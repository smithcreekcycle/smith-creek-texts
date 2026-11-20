# Security posture

A plain-English account of what protects this app and why, kept up to date
as the app changes. If you're reviewing this codebase, start here.

## Access control

- **Who can reach the staff pages at all**: only requests from a Canadian IP
  address (`src/auth.js`, `requireCanada`, backed by `geoip-lite`). A
  `GEO_RESTRICT_ENABLED=false` kill switch exists in case the geo-IP
  database ever misfires and locks everyone out.
- **Who can log in**: exactly one address, `info@smithcreekcycle.ca`
  (`ALLOWED_LOGIN_EMAIL`). Login is passwordless: a single-use, 15-minute,
  256-bit random token is emailed as a link (`auth.js`,
  `requestLoginLink`/`verifyToken`). The token is consumed atomically in
  SQL (`UPDATE ... WHERE used_at IS NULL AND expires_at > now() RETURNING
  ...`) so two simultaneous uses of the same link can't both succeed.
- **Session handling**: sessions live in Postgres (`connect-pg-simple`), are
  signed with a secret Render generates and persists (`APP_SECRET`), expire
  after 5 days, and are `httpOnly` + `secure` + `SameSite=Lax`. Logging in
  regenerates the session id (prevents session fixation); logging out
  destroys it server-side.
- The login form itself can't be used to probe which email addresses are
  allowed - `requestLoginLink` behaves identically (and takes the same time)
  whether or not the submitted address matches.

## Webhook authenticity

- **Stripe**: every `/webhooks/stripe` request is verified against
  `STRIPE_WEBHOOK_SECRET` using Stripe's own signature scheme
  (`stripe.webhooks.constructEvent`) before anything in the payload is
  trusted.
- **Twilio**: every `/webhooks/twilio-*` request is verified against
  `TWILIO_AUTH_TOKEN` using Twilio's HMAC-SHA1 request-signing scheme
  (`src/security.js`, `requireTwilioSignature`). If the auth token isn't
  configured, requests are rejected rather than accepted by default (fail
  closed). See `test/security.test.js` for a from-scratch reimplementation
  of Twilio's signing algorithm used to verify this independently of the
  `twilio` package's own validator.

## Input handling

- All SQL is parameterized (`pg`'s `$1`/`$2` placeholders) - nowhere does
  user input get concatenated into a query string.
- All HTML is escaped (`escapeHtml`) before being interpolated into a
  response.
- `/payments/send` validates its input with a schema (`src/validation.js`):
  phone number shape, amount bounds ($0.50-$10,000), note length. Malformed
  input is rejected with a clear message before it reaches Stripe or
  Twilio.
- Request bodies are capped at 100kb (1MB for the Stripe webhook's raw
  body) so an oversized payload is rejected before being fully buffered.

## Idempotency and reliability

- Stripe explicitly documents that a webhook event can be delivered more
  than once. `markDepositPaid` only transitions a deposit out of
  non-`paid` status once (`WHERE status <> 'paid'`), and
  `handleCheckoutCompleted` only creates a Shopify order on that first
  transition - so a redelivered event is a safe no-op instead of a
  duplicate order.
- The process exits on an uncaught exception (so Render restarts it clean)
  rather than continuing to run on potentially corrupted state; unhandled
  promise rejections are logged. The app refuses to start at all if
  `DATABASE_URL` is missing, rather than failing confusingly on the first
  request that touches the database.
- A centralized error handler and 404 handler mean no route can
  accidentally leak a stack trace or internal error detail to a client -
  errors are logged server-side and the client gets a generic message.

## Defense in depth

- `helmet` sets standard security headers (CSP, `X-Content-Type-Options`,
  HSTS, `X-Frame-Options: DENY`, etc.) on every response.
- Rate limiting (`express-rate-limit`) applies per-IP ceilings to login
  requests, login-link verification, staff actions, and everything else as
  a backstop - the real protection against login abuse is the
  single-allowed-address + short-lived-token design above, but this blunts
  scripted abuse regardless.

## What's intentionally out of scope right now

- **Backups**: confirm the Render Postgres plan includes backups/point-in-
  time recovery appropriate for production data - the free tier does not.
- **Monitoring/alerting**: there's no error-rate alerting (e.g. Sentry) yet;
  issues currently surface only via Render's logs.
- **Automated dependency scanning**: CI (`.github/workflows/ci.yml`) runs
  `npm audit --audit-level=high` on every push, but nothing currently opens
  a PR automatically when a new advisory lands (e.g. Dependabot).

If you add a feature that touches auth, money, or a webhook, update this
file in the same change.
