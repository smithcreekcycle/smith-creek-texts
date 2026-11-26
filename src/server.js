// Entry point: checks configuration, wires the pieces together, and starts
// listening. No business logic lives here - see:
//
//   deposits.js              the payment-link / paid-deposit workflow
//   storeCredit.js           deposits held as Shopify store credit (text + POS)
//   helcimPayments.js        payment processor API client + webhook verification
//   routes/paymentWebhooks   processor webhooks (raw body, signature-verified)
//   routes/shopifyWebhooks   Shopify order/refund webhooks (raw body, signature-verified)
//   routes/twilioWebhooks    Twilio webhooks (signature-verified)
//   routes/login             passwordless staff login
//   routes/staff             staff pages (geo-restricted, logged in, CSRF)
//   views.js                 all HTML
//   security.js / auth.js    headers, rate limits, signatures, CSRF, sessions

require("dotenv").config();
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);

const db = require("./db");
const auth = require("./auth");
const security = require("./security");
const views = require("./views");
const sms = require("./sms");
const shopifyOrders = require("./shopifyOrders");
const shopifyStoreCredit = require("./shopifyStoreCredit");
const shopifyWebhooks = require("./shopifyWebhooks");
const helcimPayments = require("./helcimPayments");
// Stripe no longer sends payment links. The module and its webhook stay in
// place, dormant, as a backup in case the processor switch is rolled back.
const stripePayments = require("./stripePayments");
const { createDepositService } = require("./deposits");
const { createStoreCreditService } = require("./storeCredit");
const createPaymentWebhookRouter = require("./routes/paymentWebhooks");
const createShopifyWebhookRouter = require("./routes/shopifyWebhooks");
const createTwilioWebhookRouter = require("./routes/twilioWebhooks");
const createLoginRouter = require("./routes/login");
const createStaffRouter = require("./routes/staff");

const PORT = process.env.PORT || 3000;

// How often the app re-checks its Shopify webhook subscriptions and sweeps
// for deposit orders a webhook didn't tell it about.
const BACKGROUND_INTERVAL_MS = 30 * 60 * 1000;

// A missing DATABASE_URL doesn't fail loudly on its own - db.js quietly
// no-ops every query and the session store throws something confusing on the
// first request. Refuse to start instead, with a message that says exactly
// what's wrong. Everything else is optional at boot: Twilio, the payment
// processor, Shopify and SMTP each fail only when actually used.
function assertRequiredEnv() {
  const missing = ["DATABASE_URL"].filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. The app cannot start without them.`,
    );
  }
}

// Things that won't stop the app from starting but will bite later. Said
// once, loudly, at boot - names only, never values.
function warnAboutConfig() {
  if (!process.env.APP_SECRET) {
    console.warn(
      "APP_SECRET is not set: using a random session secret, so everyone is logged out every time the app restarts.",
    );
  }
  const paymentVars = ["HELCIM_API_TOKEN", "HELCIM_SUBDOMAIN", "HELCIM_WEBHOOK_VERIFIER_TOKEN"];
  const missingPayment = paymentVars.filter((key) => !process.env[key]);
  if (missingPayment.length > 0) {
    console.warn(`Payment links are not fully configured. Missing: ${missingPayment.join(", ")}`);
  } else if (!helcimPayments.getConfig()) {
    console.warn("HELCIM_SUBDOMAIN doesn't look like a subdomain (it should be just the part before .myhelcim.com).");
  }
  if (!shopifyConfigured()) {
    console.warn(
      "Shopify is not fully configured (SHOPIFY_STORE_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET): deposits can't be put on customer accounts.",
    );
  }
}

function shopifyConfigured() {
  return ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"].every((key) => process.env[key]);
}

// The two services that hold the business rules. Built once and shared by
// the routes and the background tasks.
function createServices() {
  const storeCredit = createStoreCreditService({ db, shopifyOrders, shopifyStoreCredit });
  const deposits = createDepositService({ db, payments: helcimPayments, shopifyOrders, storeCredit, sms });
  return { storeCredit, deposits };
}

function buildApp({ deposits, storeCredit } = createServices()) {
  const app = express();

  // Render sits in front of this app as a reverse proxy. Trusting it lets
  // Express read the client IP (geo check, rate limiting) and the real
  // protocol from X-Forwarded-* instead of Render's own internal hop.
  app.set("trust proxy", 1);
  app.use(security.securityHeaders());
  app.use(security.globalLimiter);

  // Render's health check. Public, and ahead of everything that could touch
  // the database, so a health probe never costs a query.
  app.get("/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  // Order matters from here down.
  // 1. Webhooks that verify a signature over the raw body come before the
  //    parsers: the payment processor's, then Shopify's.
  app.use(createPaymentWebhookRouter({ deposits, payments: helcimPayments, stripePayments }));
  app.use(createShopifyWebhookRouter({ db, storeCredit }));

  // 2. Body parsers. Twilio posts form-encoded; everything else is a browser
  //    form or JSON. 100kb is generous for anything this app receives.
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));
  app.use(express.json({ limit: "100kb" }));

  // 3. Twilio webhooks: machine-to-machine, never need a session.
  app.use(createTwilioWebhookRouter({ db }));

  // 4. Customer-facing pages: no login, no geo-restriction. These were the
  //    redirect targets for Stripe Checkout and are unused while Stripe is
  //    dormant (the processor's hosted invoice page shows its own
  //    confirmation). Public so a customer abroad is never blocked.
  app.get("/payments/success", (_req, res) => {
    res.type("html").send(
      views.messagePage({
        title: "Payment received",
        heading: "Payment received",
        headingColor: views.ORANGE,
        message: "Thanks! Your payment to Smith Creek Cycle was successful. You will get a receipt shortly.",
      }),
    );
  });
  app.get("/payments/cancelled", (_req, res) => {
    res.type("html").send(
      views.messagePage({
        title: "Payment cancelled",
        heading: "Payment cancelled",
        message: "No charge was made. Contact Smith Creek Cycle if you still need to pay.",
      }),
    );
  });

  // 5. Sessions, then everything that needs one.
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
    }),
  );
  app.use(createLoginRouter());
  app.use(createStaffRouter({ db, deposits, storeCredit }));

  // 6. Catch-alls, after every real route.
  app.use((_req, res) => {
    res.status(404).type("html").send("<!doctype html><title>Not found</title><p>Not found.</p>");
  });

  // Central error handler: anything a route threw or rejected with ends up
  // here instead of Express's default (which can put a stack trace in the
  // response). Nothing internal ever reaches the client.
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    // The body parsers raise ordinary client errors (too large, malformed);
    // answer those with their own 4xx rather than calling them a crash.
    const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error("Unhandled request error", err);
    res
      .status(status)
      .type("html")
      .send(
        status === 500
          ? "<!doctype html><title>Something went wrong</title><p>Something went wrong. Please try again.</p>"
          : "<!doctype html><title>Bad request</title><p>That request couldn't be processed.</p>",
      );
  });

  return app;
}

// Housekeeping that keeps deposits honest when a webhook goes missing (the
// app was restarting, Shopify dropped a subscription): make sure the
// subscriptions exist, then look for recent deposit orders that haven't been
// dealt with. Runs once at boot and then on a timer. Never throws - a
// Shopify outage must not take the texting inbox down with it.
function startBackgroundTasks({ storeCredit }) {
  if (!shopifyConfigured()) return Promise.resolve();
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    try {
      const subs = await shopifyWebhooks.ensureSubscriptions({ baseUrl: auth.getAppBaseUrl() });
      if (subs.created.length > 0 || subs.failed.length > 0) {
        console.log("[background] Shopify webhook subscriptions", subs);
      }
    } catch (err) {
      console.error("[background] couldn't check Shopify webhook subscriptions", err.message);
    }
    try {
      const sweep = await storeCredit.sweepRecentOrders();
      if (sweep.changed > 0 || sweep.failed > 0) console.log("[background] deposit sweep", sweep);
    } catch (err) {
      console.error("[background] deposit sweep failed", err.message);
    } finally {
      running = false;
    }
  }
  // unref: this timer alone should never keep the process alive.
  setInterval(run, BACKGROUND_INTERVAL_MS).unref();
  return run();
}

async function start() {
  assertRequiredEnv();
  warnAboutConfig();
  // Sessions and login tokens live in the database, so the schema has to be
  // in place before the first request.
  await db.initSchema();
  const services = createServices();
  const app = buildApp(services);
  app.listen(PORT, () => {
    console.log(`Smith Creek Texts listening on port ${PORT}`);
  });
  // Not awaited: the app is up and serving while this runs. Exposed so a
  // test can wait for the first pass.
  app.backgroundTasks = startBackgroundTasks(services);
  return app;
}

if (require.main === module) {
  // Render restarts the process after a crash, so exiting on an uncaught
  // exception trades a few seconds of downtime for not running on
  // possibly-corrupted state. A rejected promise nobody caught is logged
  // without exiting, whatever Node version this runs on.
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception - exiting so Render can restart cleanly", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection", reason);
  });

  start().catch(function (err) {
    console.error("Fatal startup error", err);
    process.exit(1);
  });
}

module.exports = { buildApp, createServices, startBackgroundTasks, start };
