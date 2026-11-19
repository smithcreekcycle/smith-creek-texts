// Shopify Admin API access via the client-credentials grant.
// Dev Dashboard apps (created after Jan 1, 2026) don't get a permanent Admin API
// token - instead we request a short-lived one (24h) whenever we need it, using
// the app's Client ID + Client Secret, and cache it until it's close to expiring.

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-10";

let cachedToken = null;
let cachedExpiresAt = 0; // epoch ms

async function getAccessToken() {
    const now = Date.now();
    // Refresh 60s before actual expiry, per Shopify's own recommendation.
  if (cachedToken && now < cachedExpiresAt - 60_000) {
        return cachedToken;
  }

  if (!STORE_DOMAIN || !CLIENT_ID || !CLIENT_SECRET) {
        throw new Error(
                "Missing SHOPIFY_STORE_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET env vars"
              );
  }

  const res = await fetch(`https://${STORE_DOMAIN}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
        }),
  });

  if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Shopify token request failed: ${res.status} ${text}`);
  }

  const data = await res.json();
    cachedToken = data.access_token;
    // expires_in is seconds (Shopify always returns 86399); store as absolute ms.
  cachedExpiresAt = now + (data.expires_in || 86399) * 1000;
    return cachedToken;
}

async function adminGraphQL(query, variables = {}) {
    const token = await getAccessToken();
    const res = await fetch(
          `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
      {
              method: "POST",
              headers: {
                        "Content-Type": "application/json",
                        "X-Shopify-Access-Token": token,
              },
              body: JSON.stringify({ query, variables }),
      }
        );
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) {
          throw new Error(`Shopify GraphQL request failed: ${res.status}`);
    }
    return json;
}

module.exports = { getAccessToken, adminGraphQL };
