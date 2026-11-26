# Security posture

A plain-English account of what protects this app and why, kept up to date
as the app changes. If you're reviewing this codebase, start here.

## Access control

- **Who can reach the staff pages at all**: requests whose IP address
  geo-locates to Canada or the United States, or can't be located at all
  (`src/auth.js`, `requireCanada`, backed by `geoip-lite`). This is a coarse
  filter that keeps most of the world's drive-by traffic off the login page;
  it is not the thing that keeps people out - the login is. A
  `GEO_RESTRICT_ENABLED=false` kill switch exists in case the geo-IP
  database ever misfires and locks everyone out.
- **Who can log in**: exactly one address, `info@smithcreekcycle.ca`
  (`ALLOWED_LOGIN_EMAIL`). Login is passwordless: a single-use, 15-minute,
  256-bit random token is emailed as a link. Only a SHA-256 hash of the
  token is stored. The token is consumed atomically in SQL (`UPDATE ...
  WHERE used_at IS NULL AND expires_at > now() RETURNING ...`) so two
  simultaneous uses of the same link can't both succeed.
- **Opening the link doesn't log you in; pressing the button does**
  (`src/routes/login.js`). Mail scanners such as Outlook Safe Links open
  every link in an email before the person does. The link (a GET) only shows
  a "Finish logging in" button; the button (a POST) consumes the token. A
  scanner can therefore neither burn the token nor end up holding a session.
- **Session handling**: sessions live in Postgres (`connect-pg-simple`), are
  signed with a secret Render generates and persists (`APP_SECRET`), expire
  after 5 days, and are `httpOnly` + `secure` + `SameSite=Lax`. Logging in
  regenerates the session id (prevents session fixation); logging out
  destroys it server-side.
- **CSRF**: every state-changing staff POST carries a per-session token
  (`src/security.js`, `verifyCsrf`), checked in constant time.
- The login form can't be used to probe which email addresses are allowed:
  the response is the same whether or not the submitted address matches.

## Webhook authenticity

Nobody is logged in on a webhook route; the signature is the authentication.

- **Payment processor (Helcim)** - `POST /webhooks/payments`
  (`src/routes/paymentWebhooks.js`, `src/helcimPayments.js`). Verified per
  the Standard Webhooks spec: HMAC-SHA256 over
  `{webhook-id}.{webhook-timestamp}.{raw body}`, keyed with the
  base64-decoded `HELCIM_WEBHOOK_VERIFIER_TOKEN`, compared in constant time
  against the exact bytes received. No token configured means every request
  is refused (fail closed). The route path is deliberately generic - the
  processor refuses to deliver to a URL containing its own name.
- **Twilio** - every `/webhooks/twilio-*` request is verified against
  `TWILIO_AUTH_TOKEN` using Twilio's HMAC-SHA1 request signing
  (`src/security.js`, `requireTwilioSignature`), fail closed.
- **Shopify** - `POST /webhooks/shopify` (`src/routes/shopifyWebhooks.js`,
  `src/shopifyWebhooks.js`). HMAC-SHA256 over the raw body, keyed with the
  app's client secret, compared in constant time; the shop domain header
  must be this store's; only the four topics the app subscribes to are
  acted on. No client secret configured means every request is refused.
- **Stripe** - dormant. `/webhooks/stripe` still verifies with
  `stripe.webhooks.constructEvent` and does nothing unless Stripe's keys are
  configured.

## The money path

The rules that decide whether a deposit is "paid" live in one file,
`src/deposits.js`, and are covered by `test/deposits.test.js`.

- **A webhook is a hint, never a fact.** The processor's webhook body is
  only `{"id": "<transaction id>", "type": "cardTransaction"}`, and it fires
  for declined cards and for every other payment on the account. The app
  fetches the transaction from the API (must be an `APPROVED` `purchase`
  for one of our invoices) and then fetches the invoice itself (must be
  `PAID`, which the processor sets only when the full amount is in). A
  forged, replayed, or misrouted webhook can at most cause two read-only
  API calls.
- **Exactly one Shopify order per payment.** `markDepositPaidByInvoiceNumber`
  is a single `UPDATE ... WHERE status = 'pending'`; only the request that
  wins it may create the order. Redeliveries and races are no-ops.
- **Nothing is lost to a blip.** If the processor's API or the database is
  unreachable while confirming a payment, the webhook is answered `503` and
  the processor redelivers (for over a day). Only definite answers get `200`.
- **Nothing is retried blindly.** If Shopify fails after the payment is
  confirmed, the deposit is flagged "paid - needs manual entry" rather than
  retried, because a blind retry could create a duplicate order.
- **Amount mismatches go to a person.** A link is not texted if the
  processor's invoice total differs from what staff typed, and a paid
  invoice whose total doesn't match is flagged instead of written to Shopify.
- **Accidental double-sends are stopped.** The same amount to the same
  number within two minutes needs an explicit confirmation.

## Deposits held as store credit

A deposit - taken by text link or rung up in Shopify POS - ends up as store
credit on the customer's Shopify profile. This is the only place the app
changes a balance, and all of it is in `src/storeCredit.js`
(`test/storeCredit.test.js`).

- **One rule, one function.** For any order containing the deposit item
  (SKU `DEPOSIT`), the store credit issued should equal the value of the
  deposit lines still on the order, net of discounts, and never more than
  the money the shop has actually kept for that order. `reconcileOrder`
  reads the order from the Admin API, works that figure out, and moves the
  credit by the difference. Webhooks, the sweep and the staff buttons all
  call it; calling it twice changes nothing.
- **A webhook only says which order to look at.** No amount, customer or
  status is ever taken from a webhook body. A forged or replayed delivery
  that somehow passed the signature check could cause a read, not a credit.
- **Credit can't be bought cheaply.** It is always what the customer was
  charged for the deposit lines: a discount code or a sale that catches the
  deposit item reduces the credit by the same amount. Orders that are
  pending, authorized or part-paid earn nothing. Test orders earn nothing.
- **Exactly once.** Every change is claimed first with a single
  compare-and-swap `UPDATE` on `order_deposits` (`claimOrderDepositChange`).
  Two deliveries for the same order can't both win, and the database
  refuses a negative balance outright (`CHECK (credited_cents >= 0)`).
- **Never repeated on a guess.** If Shopify times out or errors mid-change,
  the app can't know whether the credit was applied. It freezes that order
  and waits for a person to check the customer's store credit in Shopify
  and press "It went through" or "It didn't - try again". Nothing automatic
  touches a frozen order.
- **A refund after the credit was spent is stopped, not chased.** Shopify
  refuses to take a balance below zero; the app then freezes the order
  rather than retry, so a customer's next deposit isn't quietly raided to
  cover the old one.
- **Credit is tied to the customer it was issued to.** If the customer on
  an order is swapped afterwards, nothing moves and staff are told.
- **History can't become credit.** Sales dated before the go-live moment
  (`DEPOSITS_LIVE_FROM`, default 26 Nov 2026) are never treated as
  deposits, so imported Lightspeed history - or any later import of old
  sales - can't produce store credit whatever SKU it carries.
- **Missed webhooks are caught.** At boot and every 30 minutes the app
  re-checks its webhook subscriptions and asks Shopify for deposit orders
  that changed in the last 72 hours.
- **Off switch.** Setting `DEPOSITS_LIVE_FROM` to a date in the future
  stops all new store credit without a code change.

What this does NOT protect against, because Shopify itself allows it:
anyone who can ring a sale in POS as "cash" without putting cash in the
till, or mark an order paid in Shopify admin, can create a paid deposit.
That is the same trust already placed in staff who handle cash; the POS
permissions "Manage store credit" and "Redeem store credit", and the till
count, are the controls. Keep the Customer Deposit item off the Online
Store sales channel.

## Input and output handling

- All SQL is parameterized (`pg`'s `$1`/`$2` placeholders) - user input is
  never concatenated into a query string.
- All HTML is produced in `src/views.js`, and everything dynamic is escaped
  (`escapeHtml`) before it's interpolated.
- `/payments/send` validates its input with a schema (`src/validation.js`):
  phone numbers are normalized to E.164 (`src/phone.js`), amounts are
  bounded ($0.50-$10,000), notes are length-limited and flattened to one
  line.
- Values that end up in outbound URLs are constrained first: the
  transaction id from a webhook must be numeric, and the account subdomain
  must be a plain hostname label.
- Values that end up in a Shopify search query are constrained first: phone
  numbers are digits only, order numbers typed by staff match
  `#?[A-Za-z0-9-]{1,20}` and are only trusted on an exact match, the
  deposit SKU setting is letters, digits, dash and underscore.
- Request bodies are capped at 100kb (1MB for the Shopify webhook and the
  dormant Stripe one).
- Every outbound request to the processor, Shopify and Hubtiger has a
  timeout.
- The "notice" shown after a staff action is a fixed code looked up in a
  table, never text from the URL.

## What stays out of the logs

API tokens, the Shopify client secret and access token, the webhook
verifier token, raw API responses (Shopify's included), invoice tokens
(an invoice token is enough to open that customer's invoice page), the text
of customers' messages, and full phone numbers on inbound messages. Error
pages shown to staff carry a short reason, never an upstream response body.

## Reliability

- The app refuses to start without `DATABASE_URL`, and warns at boot (names
  only) about anything else that's missing.
- The process exits on an uncaught exception so Render restarts it clean;
  a dropped idle database connection is logged, not fatal.
- Async route errors reach a central handler: the client gets a generic
  message, the detail goes to the server log.

## Known gaps and things to verify

- **Client IP behind Render's proxy.** The geo check and the per-IP rate
  limits both depend on `req.ip`, which depends on `trust proxy` matching
  the real number of proxy hops in front of the app. This hasn't been
  verified against live traffic; if `req.ip` is actually a proxy address,
  the geo check sees the proxy's country and rate limits are shared by
  everyone. Check the `ip` on a "Rejected a request..." log line against a
  known client address before relying on either.
- **Database TLS** is encrypted but the server certificate isn't verified
  (`rejectUnauthorized: false` in `src/db.js`).
- **No lockfile.** `package-lock.json` isn't committed, so each deploy can
  pick up newer dependency versions than the last one ran with.
- **Voicemail recordings** are linked by their Twilio URL; unless HTTP auth
  is enabled for media in the Twilio console, anyone holding that URL can
  play the recording.
- **Backups**: confirm the Render Postgres plan includes backups - the free
  tier does not, and free databases expire.
- **Monitoring**: there's no error alerting yet; problems surface only in
  Render's logs. A deposit stuck on "needs manual entry", or a store credit
  change waiting on a decision, is only visible on the payments page -
  someone has to look at it.
- **This repository is public.** It holds no secrets, but it does describe
  exactly how the shop's payments and store credit work. Making it private
  costs nothing and Render can still deploy from it.
- **Sleeping instance.** On Render's free plan the app sleeps when idle and
  takes about a minute to wake; Shopify and Twilio give up on a webhook
  long before that. The boot-time sweep recovers missed deposit orders, so
  credit arrives late rather than never, but a paid instance removes the
  delay.
- **Shopify permissions.** Deposits need `read_orders`, `write_orders`,
  `read_customers`, `write_customers`,
  `write_store_credit_account_transactions`, and `read_all_orders` (to read
  a deposit order more than 60 days old when it's refunded). Until they're
  approved, deposits are recorded and flagged, not credited.
- **Chargebacks.** A card dispute on a deposit isn't a refund in Shopify's
  eyes, so the store credit stays until someone removes it by hand.
- **Not yet run against the live store.** The store credit and order calls
  were checked against the store's live API schema and tested against a
  real Postgres, but no real deposit has been through them. Do a $1 test
  in each direction (text link, POS, refund) before relying on it.
- **Dependency updates**: CI runs `npm audit --audit-level=high` on every
  push, but nothing opens a PR when a new advisory lands.

If you add a feature that touches auth, money, or a webhook, update this
file in the same change.
