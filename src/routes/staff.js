// Staff-facing pages. Every route here is geo-restricted AND requires a
// logged-in session; every POST also requires the session's CSRF token.
//
// The guards are listed on each route on purpose (rather than a blanket
// router.use) so a guard can't silently apply to - or miss - a route that
// gets mounted next to this router.

const express = require("express");
const asyncHandler = require("./asyncHandler");
const auth = require("../auth");
const security = require("../security");
const views = require("../views");
const needsReply = require("../needsReply");
const { getAccessToken } = require("../shopify");
const { sendPaymentLinkSchema, depositActionSchema, validate } = require("../validation");

const staffOnly = [auth.requireCanada, auth.requireAuth];

// The Shopify admin address for links to orders, or null if the configured
// store domain isn't a plain myshopify.com hostname (never build a link from
// something unexpected).
function shopAdminUrl() {
  const domain = String(process.env.SHOPIFY_STORE_DOMAIN || "").toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) ? `https://${domain}/admin` : null;
}

// Maps what storeCredit.js reports to the fixed notice codes views.js knows.
function noticeFor(result) {
  switch (result.outcome) {
    case "credited":
    case "reversed":
    case "in_sync":
    case "settled":
    case "needs_review":
      return result.outcome;
    case "frozen":
    case "blocked":
    case "unknown":
    case "not_frozen":
      return "frozen";
    case "ignored":
      return result.reason === "order_not_found" ? "not_found" : "not_deposit";
    default:
      return "error";
  }
}

function createStaffRouter({ db, deposits, storeCredit }) {
  const router = express.Router();

  router.get("/", staffOnly, (req, res) => {
    res.type("html").send(views.homePage({ csrfToken: security.csrfToken(req) }));
  });

  // Manual check that the Shopify client-credentials grant works.
  router.get(
    "/health/shopify",
    staffOnly,
    asyncHandler(async (_req, res) => {
      try {
        await getAccessToken();
        res.json({ ok: true });
      } catch (err) {
        console.error("Shopify health check failed", err.message);
        res.status(500).json({ ok: false, error: "Shopify token request failed - see the server logs." });
      }
    }),
  );

  // Who still needs a reply, across SMS and voicemail.
  router.get(
    "/inbox/needs-reply",
    staffOnly,
    asyncHandler(async (req, res) => {
      const items = await needsReply.getAllNeedingReply();
      res.type("html").send(views.needsReplyPage({ items, csrfToken: security.csrfToken(req) }));
    }),
  );

  router.post(
    "/inbox/needs-reply/resolve",
    staffOnly,
    security.verifyCsrf,
    asyncHandler(async (req, res) => {
      const number = req.body && typeof req.body.number === "string" ? req.body.number : "";
      try {
        if (number) await db.markResolved(number);
      } catch (err) {
        console.error("Failed to mark resolved", err.message);
      }
      res.redirect("/inbox/needs-reply");
    }),
  );

  router.get("/payments/send", staffOnly, (req, res) => {
    const phone = typeof req.query.phone === "string" ? req.query.phone : "";
    res.type("html").send(views.sendPaymentPage({ phone, csrfToken: security.csrfToken(req) }));
  });

  router.post(
    "/payments/send",
    staffOnly,
    security.staffActionLimiter,
    security.verifyCsrf,
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const { data, error: validationError } = validate(sendPaymentLinkSchema, body);
      if (validationError) {
        return res
          .status(400)
          .type("html")
          .send(views.paymentErrorPage({ message: validationError }));
      }
      const { phone, amount, note } = data;
      const amountCents = Math.round(amount * 100);

      let result;
      try {
        result = await deposits.sendPaymentLink({
          phone,
          amountCents,
          note,
          allowDuplicate: body.confirm_duplicate === "1",
        });
      } catch (err) {
        // Errors marked `expose` were written for staff. Anything else is
        // unexpected: log it, show something generic.
        if (!err || !err.expose) console.error("Unexpected error sending payment link", err);
        const message =
          err && err.expose
            ? err.message
            : "Something went wrong creating the link, and nothing was texted. Try again; if it keeps happening, check the server logs.";
        return res.status(502).type("html").send(views.paymentErrorPage({ message }));
      }

      switch (result.outcome) {
        case "sent":
          return res.type("html").send(views.paymentSentPage({ phone, amountCents }));
        case "duplicate":
          return res
            .status(409)
            .type("html")
            .send(
              views.paymentDuplicatePage({
                phone,
                amount,
                note,
                previousAt: result.previousAt,
                csrfToken: security.csrfToken(req),
              }),
            );
        case "in_progress":
          return res.status(409).type("html").send(views.paymentInProgressPage());
        case "sms_failed":
          return res
            .status(502)
            .type("html")
            .send(views.paymentSmsFailedPage({ phone, amountCents, url: result.url, reason: result.reason }));
        default:
          throw new Error(`Unhandled sendPaymentLink outcome: ${result.outcome}`);
      }
    }),
  );

  // Deposits on account (store credit) and the history of payment links.
  router.get(
    "/payments",
    staffOnly,
    asyncHandler(async (req, res) => {
      const [recent, orderDeposits] = await Promise.all([db.getRecentDeposits(), db.getRecentOrderDeposits()]);
      res.type("html").send(
        views.paymentsHistoryPage({
          deposits: recent,
          orderDeposits,
          csrfToken: security.csrfToken(req),
          notice: typeof req.query.notice === "string" ? req.query.notice : null,
          shopAdminUrl: shopAdminUrl(),
          depositSku: storeCredit.sku,
        }),
      );
    }),
  );

  // Buttons on the payments page: re-check an order's deposit, or settle a
  // store credit change that's waiting on a person. Every path ends in a
  // redirect back to the page with a fixed notice code.
  router.post(
    "/payments/deposits",
    staffOnly,
    security.staffActionLimiter,
    security.verifyCsrf,
    asyncHandler(async (req, res) => {
      const { data, error: validationError } = validate(depositActionSchema, req.body || {});
      if (validationError) return res.redirect("/payments?notice=invalid");

      let notice;
      try {
        let result;
        if (data.action === "recheck") {
          result = data.order_id
            ? await storeCredit.reconcileOrder(data.order_id)
            : await storeCredit.recheckByName(data.order_name);
        } else {
          result = await storeCredit.settle(data.order_id, { applied: data.action === "applied" });
        }
        notice = noticeFor(result);
        console.log("[staff] deposit action", { action: data.action, orderId: data.order_id || null, ...result });
      } catch (err) {
        // "Try again later" from storeCredit.js is expected now and then;
        // anything else is worth a full log line.
        if (!err || !err.retryable) console.error("Unexpected error in deposit action", err);
        notice = err && err.name === "RetryLater" ? "busy" : "error";
      }
      res.redirect(`/payments?notice=${notice}`);
    }),
  );

  return router;
}

module.exports = createStaffRouter;
