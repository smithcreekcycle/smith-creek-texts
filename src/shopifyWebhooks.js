// Shopify webhooks: checking that a delivery really came from Shopify, and
// keeping this app subscribed to the events it needs.
//
// The webhooks are a speed-up, not the source of truth. Every one is treated
// as "go and look at this order": storeCredit.js re-reads the order from the
// Admin API before doing anything, and a periodic sweep catches whatever a
// missed delivery would have told us. So a forged, replayed or out-of-order
// webhook can't move money - the worst it can do is cause a read.

const crypto = require("crypto");
const { adminGraphQL, ShopifyApiError } = require("./shopify");

// Header topic -> GraphQL enum. These are the only topics the receiving
// route accepts, and the only ones this app subscribes to.
const TOPICS = {
  "orders/paid": "ORDERS_PAID",
  "orders/updated": "ORDERS_UPDATED",
  "orders/cancelled": "ORDERS_CANCELLED",
  "refunds/create": "REFUNDS_CREATE",
};

const WEBHOOK_PATH = "/webhooks/shopify";

// Shopify signs the exact bytes of the body with the app's client secret
// (HMAC-SHA256, base64) and sends the result in X-Shopify-Hmac-Sha256.
//
// Returns { ok: true } or { ok: false, reason } - the reason is for our logs
// and is never sent back to the caller.
function verifyWebhook({ headers, rawBody, clientSecret, expectedShopDomain }) {
  if (!clientSecret) return { ok: false, reason: "no_client_secret" };
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return { ok: false, reason: "no_body" };

  const provided = headers["x-shopify-hmac-sha256"];
  if (typeof provided !== "string" || provided.length === 0) return { ok: false, reason: "no_signature" };

  const expected = crypto.createHmac("sha256", clientSecret).update(rawBody).digest();
  const given = Buffer.from(provided, "base64");
  // timingSafeEqual throws on different lengths, so check first. A SHA-256
  // digest is always 32 bytes; anything else is malformed, not "wrong".
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  // Signed by our app's secret, but for which shop? This app serves exactly
  // one store; refuse anything addressed to another.
  const shop = String(headers["x-shopify-shop-domain"] || "").toLowerCase();
  if (!expectedShopDomain || shop !== String(expectedShopDomain).toLowerCase()) {
    return { ok: false, reason: "wrong_shop" };
  }
  return { ok: true };
}

// Makes sure Shopify is set to deliver each topic to this app. Safe to run on
// every boot and on a timer: existing subscriptions are left alone. (Shopify
// drops a subscription after repeated failed deliveries, so "it was created
// once" isn't enough.)
//
// Resolves to { created: [...topics], existing: [...topics], failed: [...topics] }.
async function ensureSubscriptions({ baseUrl, logger = console }) {
  const uri = `${String(baseUrl).replace(/\/+$/, "")}${WEBHOOK_PATH}`;
  if (!/^https:\/\//.test(uri)) {
    throw new ShopifyApiError("Webhook address must be https", { applied: "no", retryable: false });
  }

  const data = await adminGraphQL(
    `query ListWebhookSubscriptions {
      webhookSubscriptions(first: 100) { nodes { id topic uri } }
    }`,
  );
  const current = (data.webhookSubscriptions && data.webhookSubscriptions.nodes) || [];
  const result = { created: [], existing: [], failed: [] };

  for (const topic of Object.values(TOPICS)) {
    if (current.some((sub) => sub.topic === topic && sub.uri === uri)) {
      result.existing.push(topic);
      continue;
    }
    try {
      const created = await adminGraphQL(
        `mutation SubscribeWebhook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
            webhookSubscription { id }
            userErrors { field message }
          }
        }`,
        { topic, sub: { uri, format: "JSON" } },
      );
      const payload = created.webhookSubscriptionCreate;
      if (payload && payload.webhookSubscription) {
        result.created.push(topic);
      } else {
        result.failed.push(topic);
        logger.error("[shopify-webhooks] subscription refused", {
          topic,
          errors: ((payload && payload.userErrors) || []).map((e) => e.message),
        });
      }
    } catch (err) {
      result.failed.push(topic);
      logger.error("[shopify-webhooks] couldn't subscribe", { topic, error: err.message });
    }
  }
  return result;
}

module.exports = { TOPICS, WEBHOOK_PATH, verifyWebhook, ensureSubscriptions };
