// Webhooks from Shopify. Mounted BEFORE the JSON / urlencoded body parsers:
// the signature is computed over the exact bytes that arrived, so the body
// is read raw.
//
// Nobody is logged in on this route. The signature is the authentication,
// and even a correctly signed delivery is only ever a hint: the payload is
// used to decide WHICH order to look at, never what to do about it. Every
// amount comes from the Admin API (see storeCredit.js).

const express = require("express");
const asyncHandler = require("./asyncHandler");
const { TOPICS, WEBHOOK_PATH, verifyWebhook } = require("../shopifyWebhooks");

// Shopify order IDs are plain integers in webhook payloads.
function orderGid(value) {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === "string" && /^\d{1,20}$/.test(id) ? `gid://shopify/Order/${id}` : null;
}

function hasDepositLine(lineItems, sku) {
  if (!Array.isArray(lineItems)) return false;
  const wanted = sku.toUpperCase();
  return lineItems.some((line) => line && typeof line.sku === "string" && line.sku.trim().toUpperCase() === wanted);
}

// Works out which order a delivery is about and whether it could concern a
// deposit, from the payload alone. Most of the shop's orders stop here.
function readEvent(topic, payload, sku) {
  if (!payload || typeof payload !== "object") return null;
  if (topic === "refunds/create") {
    const lines = Array.isArray(payload.refund_line_items)
      ? payload.refund_line_items.map((r) => r && r.line_item)
      : [];
    return { orderId: orderGid(payload.order_id), mentionsDeposit: hasDepositLine(lines, sku) };
  }
  return { orderId: orderGid(payload.id), mentionsDeposit: hasDepositLine(payload.line_items, sku) };
}

function createShopifyWebhookRouter({ db, storeCredit }) {
  const router = express.Router();

  // Response codes are chosen for Shopify's retry behaviour (it redelivers
  // on anything that isn't 2xx, for about four hours):
  //   200  handled, or nothing to do with deposits - don't send it again
  //   401  not a request we can authenticate
  //   503  something transient got in the way - please send it again
  router.post(
    WEBHOOK_PATH,
    // Order payloads are much bigger than anything else this app receives.
    express.raw({ type: () => true, limit: "1mb" }),
    asyncHandler(async (req, res) => {
      const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
      if (!clientSecret) {
        console.error("[shopify-webhook] received, but SHOPIFY_CLIENT_SECRET is not set");
        return res.sendStatus(503);
      }
      const check = verifyWebhook({
        headers: req.headers,
        rawBody: req.body,
        clientSecret,
        expectedShopDomain: process.env.SHOPIFY_STORE_DOMAIN,
      });
      if (!check.ok) {
        console.warn("[shopify-webhook] rejected", { reason: check.reason, ip: req.ip });
        return res.sendStatus(401);
      }

      const topic = String(req.headers["x-shopify-topic"] || "");
      if (!Object.prototype.hasOwnProperty.call(TOPICS, topic)) return res.sendStatus(200);

      let payload;
      try {
        payload = JSON.parse(req.body.toString("utf8"));
      } catch (err) {
        return res.sendStatus(400);
      }
      const event = readEvent(topic, payload, storeCredit.sku);
      if (!event || !event.orderId) return res.sendStatus(200);

      try {
        // Worth a look if the payload shows a deposit line, or if this is an
        // order we've already issued credit for (a refund by amount carries
        // no line items at all).
        if (!event.mentionsDeposit && !(await db.getOrderDeposit(event.orderId))) {
          return res.sendStatus(200);
        }
        const result = await storeCredit.reconcileOrder(event.orderId);
        if (result.outcome !== "ignored" && result.outcome !== "in_sync") {
          console.log("[shopify-webhook] deposit order processed", { topic, orderId: event.orderId, ...result });
        }
        return res.sendStatus(200);
      } catch (err) {
        console.error("[shopify-webhook] couldn't process yet; asking for redelivery", {
          topic,
          orderId: event.orderId,
          error: err.message,
        });
        return res.sendStatus(503);
      }
    }),
  );

  return router;
}

module.exports = createShopifyWebhookRouter;
module.exports.readEvent = readEvent;
