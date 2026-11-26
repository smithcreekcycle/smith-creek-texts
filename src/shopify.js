// Shopify Admin API access via the client-credentials grant.
// Dev Dashboard apps (created after Jan 1, 2026) don't get a permanent Admin API
// token - instead we request a short-lived one (24h) whenever we need it, using
// the app's Client ID + Client Secret, and cache it until it's close to expiring.

const REQUEST_TIMEOUT_MS = 10_000;

function config() {
  return {
    storeDomain: process.env.SHOPIFY_STORE_DOMAIN,
    clientId: process.env.SHOPIFY_CLIENT_ID,
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
    apiVersion: process.env.SHOPIFY_API_VERSION || "2026-10",
  };
}

// Every failure talking to Shopify is one of these. Two facts matter to the
// callers that move store credit:
//
//   applied   "no"       Shopify definitely did not carry out the request
//             "unknown"  it may or may not have (timeout, dropped connection,
//                        5xx) - never blindly repeat a mutation after this
//   retryable whether trying again later could plausibly succeed
//
// The message is safe to log and to show staff: status codes and Shopify's
// own error codes only, never response bodies or tokens.
class ShopifyApiError extends Error {
  constructor(message, { applied = "unknown", retryable = true, code = null } = {}) {
    super(message);
    this.name = "ShopifyApiError";
    this.applied = applied;
    this.retryable = retryable;
    this.code = code;
  }
}

// GraphQL-level error codes that mean the operation was refused before it ran.
const NOT_EXECUTED_CODES = new Set(["THROTTLED", "ACCESS_DENIED", "SHOP_INACTIVE", "MAX_COST_EXCEEDED"]);
// ...and the ones that say nothing either way about whether it ran.
const MAYBE_EXECUTED_CODES = new Set(["INTERNAL_SERVER_ERROR", "TIMEOUT", "UNKNOWN"]);

let cachedToken = null;
let cachedExpiresAt = 0; // epoch ms

async function getAccessToken() {
  const now = Date.now();
  // Refresh 60s before actual expiry, per Shopify's own recommendation.
  if (cachedToken && now < cachedExpiresAt - 60_000) {
    return cachedToken;
  }

  const { storeDomain, clientId, clientSecret } = config();
  if (!storeDomain || !clientId || !clientSecret) {
    throw new ShopifyApiError("Missing SHOPIFY_STORE_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET env vars", {
      applied: "no",
      retryable: false,
    });
  }

  let res;
  try {
    res = await fetch(`https://${storeDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ShopifyApiError(`Couldn't reach Shopify for an access token (${err.name})`, { applied: "no" });
  }
  if (!res.ok) {
    // The body can echo credentials-adjacent detail; the status is enough.
    throw new ShopifyApiError(`Shopify token request failed (${res.status})`, {
      applied: "no",
      retryable: res.status >= 500 || res.status === 429,
    });
  }

  const data = await res.json().catch(() => null);
  if (!data || typeof data.access_token !== "string") {
    throw new ShopifyApiError("Shopify token response was unreadable", { applied: "no" });
  }
  cachedToken = data.access_token;
  // expires_in is seconds (Shopify always returns 86399); store as absolute ms.
  cachedExpiresAt = now + (data.expires_in || 86399) * 1000;
  return cachedToken;
}

// Runs one GraphQL operation and resolves with its `data`. Rejects with a
// ShopifyApiError for transport failures, HTTP errors and top-level GraphQL
// errors. A mutation's own `userErrors` are NOT thrown here - they're part of
// `data`, and each caller decides what they mean.
async function adminGraphQL(query, variables = {}) {
  const token = await getAccessToken();
  const { storeDomain, apiVersion } = config();

  let res;
  try {
    res = await fetch(`https://${storeDomain}/admin/api/${apiVersion}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Timed out or the connection dropped: the request may have landed.
    throw new ShopifyApiError(`Shopify request failed in transit (${err.name})`, { applied: "unknown" });
  }

  if (res.status === 401) {
    // The cached token was revoked or rotated; drop it so the next call
    // fetches a fresh one.
    cachedToken = null;
    cachedExpiresAt = 0;
  }
  if (!res.ok) {
    const refused = res.status < 500;
    throw new ShopifyApiError(`Shopify answered ${res.status}`, {
      applied: refused ? "no" : "unknown",
      retryable: !refused || res.status === 401 || res.status === 429,
      code: `HTTP_${res.status}`,
    });
  }

  const json = await res.json().catch(() => null);
  if (!json || typeof json !== "object") {
    throw new ShopifyApiError("Shopify sent a response this app couldn't read", { applied: "unknown" });
  }

  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const codes = json.errors.map((e) => (e && e.extensions && e.extensions.code) || "UNKNOWN");
    // Two ways to be sure nothing ran: every error is one Shopify raises
    // before execution, or there is no `data` at all and the errors are the
    // parse/validation kind rather than a server fault.
    const notExecuted =
      codes.every((code) => NOT_EXECUTED_CODES.has(code)) ||
      (json.data == null && codes.every((code) => !MAYBE_EXECUTED_CODES.has(code)));
    throw new ShopifyApiError(`Shopify rejected the request (${codes.join(", ")})`, {
      applied: notExecuted ? "no" : "unknown",
      retryable: codes.includes("THROTTLED") || !notExecuted,
      code: codes[0],
    });
  }
  if (json.data == null) {
    throw new ShopifyApiError("Shopify returned no data", { applied: "unknown" });
  }
  return json.data;
}

// For tests only.
function _resetTokenCache() {
  cachedToken = null;
  cachedExpiresAt = 0;
}

module.exports = { getAccessToken, adminGraphQL, ShopifyApiError, _resetTokenCache };
