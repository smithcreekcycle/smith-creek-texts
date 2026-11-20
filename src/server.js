require("dotenv").config();
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { getAccessToken } = require("./shopify");
const twilio = require("twilio");
const db = require("./db");
const needsReply = require("./needsReply");
const stripePayments = require("./stripePayments");
const shopifyOrders = require("./shopifyOrders");
const sms = require("./sms");
const auth = require("./auth");
const security = require("./security");
const { sendPaymentLinkSchema, validate } = require("./validation");
// ---- Fail fast on missing configuration ------------------------------------
//
// A missing DATABASE_URL doesn't fail loudly on its own - db.js quietly
// no-ops every query, and express-session's Postgres store throws a
// confusing error the first time anyone hits a session-backed route. Better
// to refuse to start at all with a message that says exactly what's wrong.
// Everything else here is optional at boot (Twilio/Stripe/Shopify/SMTP each
// guard their own missing config and fail only when actually used), so we
// only hard-require what the app cannot run at all without.
function assertRequiredEnv() {
  const required = ["DATABASE_URL"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. The app cannot start without them.`
    );
  }
}
// Catches anything that slips past the try/catch blocks in individual route
// handlers. Render restarts the process automatically after a crash, so
// exiting on an uncaught exception trades a few seconds of downtime for not
// running on potentially corrupted in-memory state. A rejected promise with
// no .catch() is logged but doesn't crash the process by itself - Node
// itself will start doing that in a future major version, so this also
// keeps behaviour predictable regardless of Node version.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception - exiting so Render can restart cleanly", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection", reason);
});
const app = express();
// Render sits in front of this app as a reverse proxy. Trusting it lets
// Express read the real client IP (for the Canada-only check and rate
// limiting) and the real protocol from X-Forwarded-* headers instead of
// Render's own internal hop.
app.set("trust proxy", 1);
app.use(security.securityHeaders());
app.use(security.globalLimiter);
// Stripe needs the raw request body to verify its signature, so this route
// is registered before the urlencoded/json body parsers below touch the
// request stream. express.raw's own size limit also protects this route
// before signature verification even runs.
app.post(
      "/webhooks/stripe",
      express.raw({ type: "application/json", limit: "1mb" }),
      async (req, res) => {
              const stripe = stripePayments.getClient();
              const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
              if (!stripe || !webhookSecret) {
                        console.error("Stripe webhook received but Stripe is not configured");
                        return res.sendStatus(500);
              }
        let event;
              try {
                        event = stripe.webhooks.constructEvent(
                                    req.body,
                                    req.headers["stripe-signature"],
                                    webhookSecret
                                  );
              } catch (err) {
                        console.error("Stripe webhook signature verification failed", err.message);
                                            return res.sendStatus(400);
              }
        if (event.type === "checkout.session.completed") {
                  const session = event.data.object;
                  try {
                              await handleCheckoutCompleted(session);
                  } catch (err) {
                              console.error("Failed to handle Stripe checkout completion", err.message);
                  }
        }
        res.sendStatus(200);
      }
    );
// Twilio posts form-encoded; everything else that takes a body is JSON or a
// browser form post. A 100kb cap is generous for anything this app actually
// receives and rejects an oversized body before it's fully buffered.
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(express.json({ limit: "100kb" }));
const PORT = process.env.PORT || 3000;
function escapeHtml(str) {
      return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
              return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
      });
}
// error is always a short fixed code (never raw error text - see the /login
// POST handler below), so this is safe to render without worrying that an
// internal error message leaks something like a hostname to an
// unauthenticated visitor.
const LOGIN_ERROR_MESSAGES = {
  send_failed: "Couldn't send the login link right now. Try again in a minute, or contact the site admin.",
  expired: "That login link has expired or was already used. Request a new one below.",
};
function loginPageHtml({ email, sent, error }) {
      const errorMessage = error ? LOGIN_ERROR_MESSAGES[error] || "Something went wrong. Try again." : null;
      return `<!doctype html>
      <html>
      <head><title>Log in - Smith Creek Texts</title></head>
      <body style="font-family: sans-serif; max-width: 480px; margin: 60px auto;">
      <h1 style="color:#FF5A1F;">Smith Creek Texts</h1>
      ${sent ? `<p style="color:#2ecc71;">If that address is allowed, a login link is on its way. Check the inbox and click the link (it expires in ${auth.TOKEN_TTL_MINUTES} minutes).</p>` : ""}
      ${errorMessage ? `<p style="color:#c0392b;">${escapeHtml(errorMessage)}</p>` : ""}
      <form method="POST" action="/login">
      <label>Email<br>
      <input type="email" name="email" value="${escapeHtml(email || auth.ALLOWED_LOGIN_EMAIL)}" required style="width:100%; padding:8px;">
      </label><br><br>
      <button type="submit" style="padding:10px 20px; background:#FF5A1F; color:white; border:none; border-radius:4px;">Email me a login link</button>
      </form>
      </body>
      </html>`;
}
// Everything below needs the DB (for sessions + login tokens) ready first.
async function start() {
      assertRequiredEnv();
      await db.initSchema();
  app.use(
          session({
                    store: new PgSession({ pool: db.pool, createTableIfMissing: true }),
                    secret: auth.getSessionSecret(),
                    resave: false,
                    saveUninitialized: false,
                    name: "sct.sid",
                    cookie: {
                                maxAge: auth.SESSION_MAX_AGE_MS,
                                httpOnly: true,
                                secure: true,
                                sameSite: "lax",
                    },
          })
        );
  // ---- Fully public: Render's own health check ----
  app.get("/health", (_req, res) => {
          res.json({ ok: true, time: new Date().toISOString() });
  });
  // ---- Login flow: Canada-only, but doesn't require being logged in yet ----
  app.get("/login", auth.requireCanada, (req, res) => {
          const error = req.query.error === "1" ? "send_failed" : null;
          res.type("html").send(
                    loginPageHtml({ sent: req.query.sent === "1", error })
                  );
  });
  app.post("/login", auth.requireCanada, security.loginRequestLimiter, async (req, res) => {
          try {
                    await auth.requestLoginLink(req.body && req.body.email);
                    res.redirect("/login?sent=1");
          } catch (err) {
                    // Log the real reason server-side only - an unauthenticated visitor
                    // never needs to see internal details like an SMTP hostname.
                    console.error("Failed to send login link", err.message);
                    res.redirect("/login?error=1");
          }
  });
  app.get("/login/verify", auth.requireCanada, security.loginVerifyLimiter, async (req, res) => {
          const email = await auth.verifyToken(req.query.token);
          if (!email) {
                    return res
                      .status(400)
                      .type("html")
                      .send(loginPageHtml({ error: "expired" }));
          }
          // Prevent session fixation: issue a brand new session id on login
          // rather than reusing whatever session (if any) the visitor already
          // had, so a session id captured before authentication is useless
          // afterward.
          req.session.regenerate((err) => {
                    if (err) {
                              console.error("Failed to regenerate session on login", err.message);
                              return res.status(500).type("html").send(loginPageHtml({ error: "send_failed" }));
                    }
                    req.session.authedEmail = email;
                                    req.session.save((saveErr) => {
                              if (saveErr) {
                                        console.error("Failed to save session on login", saveErr.message);
                                        return res.status(500).type("html").send(loginPageHtml({ error: "send_failed" }));
                              }
                              res.redirect("/");
                                    });
          });
  });
  app.post("/logout", (req, res) => {
          req.session.destroy(() => res.redirect("/login"));
  });
  // ---- Staff-facing pages: Canada-only AND logged in ----
  app.get("/", auth.requireCanada, auth.requireAuth, (_req, res) => {
          res.type("html").send(`
          <!doctype html>
          <html>
          <head><title>Smith Creek Texts</title></head>
          <body style="font-family: sans-serif; max-width: 640px; margin: 60px auto; color: #111;">
          <h1 style="color:#FF5A1F;">Smith Creek Texts</h1>
          <p>The app is deployed and running. This placeholder page will become
          the real texting inbox once Twilio is connected.</p>
          <p>Status: <a href="/health">/health</a></p>
          <p><a href="/inbox/needs-reply">Needs reply</a> &middot; <a href="/payments">Payment links</a></p>
          <form method="POST" action="/logout"><button type="submit">Log out</button></form>
          </body>
          </html>
          `);
  });
  // Quick manual check that the Shopify client-credentials grant actually works
  // once SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are set as real env vars here.
  app.get("/health/shopify", auth.requireCanada, auth.requireAuth, async (_req, res) => {
          try {
                    await getAccessToken();
                    res.json({ ok: true });
          } catch (err) {
                    res.status(500).json({ ok: false, error: err.message });
          }
  });
  // Simple staff-facing screen: who still needs a reply, across SMS and voicemail.
  app.get("/inbox/needs-reply", auth.requireCanada, auth.requireAuth, async (_req, res) => {
          try {
                    const items = await needsReply.getAllNeedingReply();
                    const rows = items.map(function (i) {
                                const preview = i.channel === "voicemail"
                                  ? (i.lastMessage ? `<a href="${escapeHtml(i.lastMessage)}">listen</a>` : "(no recording)")
                                              : escapeHtml(i.lastMessage || "");
                                return `<tr>
                                          <td>${escapeHtml(i.channel)}</td>
                                                    <td>${escapeHtml(i.number)}</td>
                                                              <td>${new Date(i.receivedAt).toLocaleString()}</td>
                                                                        <td>${preview}</td>
                                                                                  <td>
                                                                                              <form method="POST" action="/inbox/needs-reply/resolve">
                                                                                                            <input type="hidden" name="number" value="${escapeHtml(i.number)}">
                                                                                                                                                                                                                              <button type="submit">Mark handled</button>
                                                                                                                                                                                                                                          </form>
                                                                                                                                                                                                                                                    </td>
                                                                                                                                                                                                                                                              <td><a href="/payments/send?phone=${encodeURIComponent(i.number)}">Send payment link</a></td>
                                                                                                                                                                                                                                                                      </tr>`;
                    }).join("");
            res.type("html").send(`<!doctype html>
            <html>
            <head><title>Needs Reply - Smith Creek Texts</title></head>
            <body style="font-family: sans-serif; max-width: 900px; margin: 40px auto;">
            <h1 style="color:#FF5A1F;">Needs a reply (${items.length})</h1>
            <p><a href="/">Home</a> &middot; <a href="/payments">Payment history</a></p>
            <table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%;">
            <tr><th>Channel</th><th>From</th><th>Received</th><th>Message</th><th></th><th></th></tr>
            ${rows}
            </table>
            </body>
            </html>`);
          } catch (err) {
                    res.status(500).send(`Failed to load needs-reply list: ${escapeHtml(err.message)}`);
          }
  });
  app.post("/inbox/needs-reply/resolve", auth.requireCanada, auth.requireAuth, async (req, res) => {
          const { number } = req.body || {};
          try {
                                    if (number) await db.markResolved(number);
          } catch (err) {
                    console.error("Failed to mark resolved", err.message);
          }
          res.redirect("/inbox/needs-reply");
  });
  // Staff-facing form to text a Stripe payment link to a customer.
  app.get("/payments/send", auth.requireCanada, auth.requireAuth, (req, res) => {
          const phone = req.query.phone || "";
          res.type("html").send(`<!doctype html>
          <html>
          <head><title>Send Payment Link - Smith Creek Texts</title></head>
          <body style="font-family: sans-serif; max-width: 480px; margin: 60px auto;">
          <h1 style="color:#FF5A1F;">Send a payment link</h1>
          <p><a href="/inbox/needs-reply">Needs reply</a> &middot; <a href="/payments">Payment history</a></p>
          <form method="POST" action="/payments/send">
          <label>Phone number<br>
          <input type="text" name="phone" value="${escapeHtml(phone)}" placeholder="+12505551234" required style="width:100%; padding:8px;">
          </label><br><br>
          <label>Amount (CAD)<br>
          <input type="number" name="amount" step="0.01" min="0.50" placeholder="50.00" required style="width:100%; padding:8px;">
          </label><br><br>
          <label>Note (shows on the receipt, e.g. bike model)<br>
          <input type="text" name="note" placeholder="Trek Fuel EX deposit" style="width:100%; padding:8px;">
          </label><br><br>
          <button type="submit" style="padding:10px 20px; background:#FF5A1F; color:white; border:none; border-radius:4px;">Create &amp; text link</button>
          </form>
          </body>
          </html>`);
  });
  app.post("/payments/send", auth.requireCanada, auth.requireAuth, security.staffActionLimiter, async (req, res) => {
          const { data, error: validationError } = validate(sendPaymentLinkSchema, req.body || {});
          if (validationError) {
                    return res.status(400).send(`<!doctype html>
                    <html><body style="font-family: sans-serif; max-width: 480px; margin: 60px auto;">
                    <h1 style="color:#c0392b;">Couldn't send link</h1>
                    <p>${escapeHtml(validationError)}</p>
                    <p><a href="/payments/send">Try again</a></p>
                    </body></html>`);
          }
          const { phone, note } = data;
          try {
                    const amountCents = Math.round(data.amount * 100);
                    const session = await stripePayments.createDepositCheckout({ phone, amountCents, note });
                    await db.recordDepositCreated({
                                stripeSessionId: session.id,
                                phone,
                                amountCents,
                                currency: "CAD",
                                                          note: note || "",
                    });
                    await sms.sendSms(
                                phone,
                                `Smith Creek Cycle: here's your secure payment link${note ? ` for ${note}` : ""}: ${session.url}`
                              );
                    res.type("html").send(`<!doctype html>
                    <html><body style="font-family: sans-serif; max-width: 480px; margin: 60px auto;">
                    <h1 style="color:#FF5A1F;">Link sent</h1>
                    <p>Texted a $${(amountCents / 100).toFixed(2)} payment link to ${escapeHtml(phone)}.</p>
                    <p><a href="/payments/send">Send another</a> &middot; <a href="/payments">Payment history</a></p>
                    </body></html>`);
          } catch (err) {
                    res.status(400).send(`<!doctype html>
                    <html><body style="font-family: sans-serif; max-width: 480px; margin: 60px auto;">
                    <h1 style="color:#c0392b;">Couldn't send link</h1>
                    <p>${escapeHtml(err.message)}</p>
                    <p><a href="/payments/send">Try again</a></p>
                    </body></html>`);
          }
  });
  // Staff-facing history of payment links sent and their Shopify order status.
  app.get("/payments", auth.requireCanada, auth.requireAuth, async (_req, res) => {
          try {
                    const deposits = await db.getRecentDeposits();
                    const rows = deposits.map(function (d) {
                                const statusColor = d.status === "paid" ? "#2ecc71" : d.status === "order_failed" ? "#e67e22" : "#999";
                                const orderCell = d.shopify_order_name
                                  ? escapeHtml(d.shopify_order_name)
                                              : (d.status === "order_failed" ? "needs manual entry" : "-");
                                return `<tr>
                                          <td>${new Date(d.created_at).toLocaleString()}</td>
                                                    <td>${escapeHtml(d.phone)}</td>
                                                              <td>$${(d.amount_cents / 100).toFixed(2)}</td>
                                                                        <td>${escapeHtml(d.note || "")}</td>
                                                                                  <td style="color:${statusColor}; font-weight:bold;">${escapeHtml(d.status)}</td>
                                                                                            <td>${orderCell}</td>
                                                                                                    </tr>`;
                    }).join("");
                    res.type("html").send(`<!doctype html>
                    <html>
                    <head><title>Payments - Smith Creek Texts</title></head>
                    <body style="font-family: sans-serif; max-width: 900px; margin: 40px auto;">
                    <h1 style="color:#FF5A1F;">Payment links</h1>
                    <p><a href="/">Home</a> &middot; <a href="/payments/send">Send a new link</a></p>
                    <table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%;">
                    <tr><th>Sent</th><th>Phone</th><th>Amount</th><th>Note</th><th>Status</th><th>Shopify order</th></tr>
                    ${rows}
                    </table>
                    </body>
                    </html>`);
          } catch (err) {
                    res.status(500).send(`Failed to load payments: ${escapeHtml(err.message)}`);
          }
  });
  // ---- Customer-facing pages: no login, no geo-restriction. A customer who
  // just paid via a Stripe-hosted checkout lands here; they shouldn't be
  // blocked just because they're travelling outside Canada. ----
  app.get("/payments/success", (_req, res) => {
          res.type("html").send(`<!doctype html>
          <html><body style="font-family: sans-serif; max-width: 480px; margin: 60px auto; text-align:center;">
          <h1 style="color:#FF5A1F;">Payment received</h1>
          <p>Thanks! Your payment to Smith Creek Cycle was successful. You will get a receipt shortly.</p>
          </body></html>`);
  });
  app.get("/payments/cancelled", (_req, res) => {
          res.type("html").send(`<!doctype html>
          <html><body style="font-family: sans-serif; max-width: 480px; margin: 60px auto; text-align:center;">
          <h1>Payment cancelled</h1>
          <p>No charge was made. Contact Smith Creek Cycle if you still need to pay.</p>
          </body></html>`);
  });
  // ---- Twilio webhooks: Twilio's own servers call these, not staff or
  // customers, so they stay public with no login and no geo-restriction. ----
  // Twilio posts here whenever a customer texts the shop's number.
  app.post("/webhooks/twilio-sms", security.requireTwilioSignature, async (req, res) => {
          const { From, Body, MessageSid } = req.body || {};
          console.log("Incoming SMS", { From, Body, MessageSid });
               // TODO: store the message, notify staff, run automation rules.
               // Relay to Hubtiger so job cards stay in sync (see HUBTIGER_INCOMING_SMS_WEBHOOK_URL).
               const hubtigerUrl = process.env.HUBTIGER_INCOMING_SMS_WEBHOOK_URL;
          if (hubtigerUrl) {
                    try {
                                await fetch(hubtigerUrl, {
                                              method: "POST",
                                              headers: { "Content-Type": "application/x-www-form-urlencoded" },
                                              body: new URLSearchParams(req.body || {}),
                                });
                    } catch (err) {
                                console.error("Failed to relay to Hubtiger", err.message);
                    }
          }
               res.type("text/xml").send("<Response></Response>");
  });
  // Twilio posts delivery/status updates here.
  app.post("/webhooks/twilio-status", security.requireTwilioSignature, (req, res) => {
          console.log("Twilio status callback", req.body);
          res.sendStatus(200);
  });
  // Phone module: toggled with PHONE_MODULE_ENABLED. When off, calls get a
  // short message instead of the greeting/voicemail flow.
  app.post("/webhooks/twilio-voice", security.requireTwilioSignature, (req, res) => {
          const VoiceResponse = twilio.twiml.VoiceResponse;
          const twiml = new VoiceResponse();
               if (process.env.PHONE_MODULE_ENABLED !== "true") {
                         twiml.say("Sorry, phone support isn't available on this number yet. Please text us instead.");
                         twiml.hangup();
                         return res.type("text/xml").send(twiml.toString());
               }
               twiml.say("Thanks for calling Smith Creek Cycle. Leave a message after the tone and we will text or call you back.");
          twiml.record({
                    action: "/webhooks/twilio-voice-recording",
                    maxLength: 120,
                    playBeep: true,
          });
          twiml.say("We did not receive a recording. Goodbye.");
          res.type("text/xml").send(twiml.toString());
  });
  app.post("/webhooks/twilio-voice-recording", security.requireTwilioSignature, async (req, res) => {
          const { CallSid, From, To, RecordingUrl, RecordingDuration } = req.body || {};
          try {
                    await db.logVoicemail({
                                callSid: CallSid,
                                from: From,
                                to: To,
                                recordingUrl: RecordingUrl ? `${RecordingUrl}.mp3` : null,
                                durationSeconds: RecordingDuration ? parseInt(RecordingDuration, 10) : null,
                    });
          } catch (err) {
                    console.error("Failed to log voicemail", err.message);
          }
          const VoiceResponse = twilio.twiml.VoiceResponse;
          const twiml = new VoiceResponse();
          twiml.say("Thanks, we got your message. Goodbye.");
          twiml.hangup();
          res.type("text/xml").send(twiml.toString());
  });
  // ---- Catch-alls: must be registered after every real route -----------
  app.use((req, res) => {
          res.status(404).type("html").send(
                    "<!doctype html><title>Not found</title><p>Not found.</p>"
                  );
  });
  // Centralized error handler. Any route that forgot a try/catch, or threw
  // from synchronous code, ends up here instead of Express's default
  // behaviour (which can include a stack trace in the response). Nothing
  // internal - a message, a stack, a query - ever reaches the client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
          console.error("Unhandled request error", err);
          if (res.headersSent) return next(err);
          res.status(500).type("html").send(
                    "<!doctype html><title>Something went wrong</title><p>Something went wrong. Please try again.</p>"
                  );
  });
  app.listen(PORT, () => {
          console.log(`Smith Creek Texts listening on port ${PORT}`);
  });
}
// Called from the Stripe webhook once a text-a-payment-link checkout completes.
// Records the payment as paid, then creates a real Shopify order for it (matched
// to an existing customer by phone when possible) so it shows up as a deposit.
async function handleCheckoutCompleted(session) {
      const phone = (session.metadata && session.metadata.phone) || null;
      const note = (session.metadata && session.metadata.note) || "";
      const amountCents = session.amount_total;
      const currency = (session.currency || "cad").toUpperCase();
  // Stripe documents that a webhook event can be delivered more than once
  // for the same event. markDepositPaid only flips status on the first
  // call, so a redelivery here is a deliberate no-op rather than a second
  // Shopify order for the same payment.
  const wasNewlyPaid = await db.markDepositPaid(session.id, { amountCents, currency });
  if (!wasNewlyPaid) {
      console.log("Deposit already marked paid; skipping duplicate order creation", { sessionId: session.id });
      return;
  }
  try {
          const customer = phone ? await shopifyOrders.findCustomerByPhone(phone) : null;
          const order = await shopifyOrders.createDepositOrder({
                    customerId: customer ? customer.id : null,
                    amountCents,
                    note,
                    stripeSessionId: session.id,
          });
          await db.recordDepositOrder(session.id, {
                    shopifyOrderId: order.id,
                    shopifyOrderName: order.name,
          });
  } catch (err) {
          console.error("Failed to create Shopify deposit order", err.message);
          await db.recordDepositOrderError(session.id, err.message);
  }
}
start().catch(function (err) {
      console.error("Fatal startup error", err);
      process.exit(1);
});
