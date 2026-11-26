// Client for the payment processor (Helcim): the three API calls this app
// makes, plus verification of the webhooks it sends us.
//
// How a text-a-payment-link deposit works end to end:
//
//   1. createDepositInvoice() creates an invoice for the deposit amount. The
//      customer-facing link is built from the invoice's `token` and the
//      account's subdomain:  https://{subdomain}.myhelcim.com/order/?token=...
//      That page shows the invoice and takes the card payment.
//   2. When any card payment is processed on the account, the processor
//      POSTs a webhook. The body is deliberately thin - just
//      {"id":"<card transaction id>","type":"cardTransaction"} - and it fires
//      for approved AND declined attempts, on every payment tool the account
//      uses (not just our invoices).
//   3. So nothing in the webhook is trusted beyond "go look at this
//      transaction": getCardTransaction() and getInvoiceByNumber() fetch the
//      facts straight from the API (see deposits.js for the decision logic).
//
// Environment (set directly in Render):
//   HELCIM_API_TOKEN               API token (All Tools > Integrations > API Access)
//   HELCIM_SUBDOMAIN               the part before ".myhelcim.com"
//   HELCIM_WEBHOOK_VERIFIER_TOKEN  from All Tools > Integrations > Webhooks
//
// This module never logs the API token, the verifier token, raw API response
// bodies, or invoice tokens (an invoice token is all anyone needs to open
// that customer's invoice page).

const crypto = require("crypto");

const API_BASE = "https://api.helcim.com/v2";
// Node's fetch has no useful default timeout. Without one, a stalled
// connection would leave a staff member staring at a spinner (or a webhook
// hanging) for minutes.
const REQUEST_TIMEOUT_MS = 15_000;

// Webhook timestamps: the processor retries a failed delivery for over a day
// (5s, 5m, 30m, 2h, 5h, 10h, 10h), and replaying an old, validly signed
// webhook can't do damage here - processing is idempotent and every fact is
// re-fetched from the API. So the window is deliberately wide: it only exists
// to throw out nonsense, not to act as replay protection.
const WEBHOOK_MAX_AGE_SECONDS = 48 * 60 * 60;
const WEBHOOK_MAX_FUTURE_SECONDS = 5 * 60;

// An error whose message is safe to show to staff: it never contains a
// response body, a token, or anything else from the wire. `retryable` tells
// the webhook handler whether asking the processor to redeliver could help.
class PaymentProviderError extends Error {
  constructor(message, { status = null, retryable = true } = {}) {
    super(message);
    this.name = "PaymentProviderError";
    this.status = status;
    this.retryable = retryable;
    this.expose = true;
  }
}

function toCents(amount) {
  const value = Number(amount);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

// Tolerates the ways this env var commonly gets pasted ("Smith-Creek",
// "smith-creek.myhelcim.com", "https://smith-creek.myhelcim.com/") and
// refuses anything that isn't a plain hostname label - the value goes
// straight into a link that gets texted to customers.
function normalizeSubdomain(value) {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.myhelcim\.com$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(cleaned) ? cleaned : null;
}

function getConfig() {
  const apiToken = (process.env.HELCIM_API_TOKEN || "").trim();
  const subdomain = normalizeSubdomain(process.env.HELCIM_SUBDOMAIN);
  if (!apiToken || !subdomain) return null;
  return { apiToken, subdomain };
}

function requireConfig() {
  const config = getConfig();
  if (!config) {
    throw new PaymentProviderError(
      "The payment processor isn't set up yet: HELCIM_API_TOKEN and HELCIM_SUBDOMAIN must be set in Render (the subdomain is just the part before .myhelcim.com).",
      { retryable: true },
    );
  }
  return config;
}

function buildInvoiceUrl(subdomain, token) {
  return `https://${subdomain}.myhelcim.com/order/?token=${encodeURIComponent(token)}`;
}

// The processor's error bodies look like {"errors": ...}. Keep a short,
// bounded summary for the server log; never the whole body.
function summarizeErrors(json) {
  if (!json || json.errors == null) return undefined;
  return JSON.stringify(json.errors).slice(0, 300);
}

async function apiRequest(method, path, body) {
  const { apiToken } = requireConfig();
  let res;
  let text;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        "api-token": apiToken,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    console.error("[payments] request failed", { method, path, error: err.name });
    throw new PaymentProviderError("Couldn't reach the payment processor. Try again in a moment.");
  }

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (err) {
    json = null;
  }

  if (!res.ok) {
    console.error("[payments] API error", { method, path, status: res.status, errors: summarizeErrors(json) });
    const hint = res.status === 401 || res.status === 403 ? " - check the API token and its permissions" : "";
    throw new PaymentProviderError(`The payment processor rejected the request (${res.status})${hint}.`, {
      status: res.status,
      // A bad request or a missing record won't fix itself; everything else
      // (outage, rate limit, a token that's about to be corrected) might.
      retryable: ![400, 404, 422].includes(res.status),
    });
  }
  if (json === null) {
    console.error("[payments] unreadable API response", { method, path, status: res.status });
    throw new PaymentProviderError("The payment processor sent back a response this app couldn't read.");
  }
  return json;
}

// Creates a one-off invoice for a deposit. amountCents is an integer number
// of cents (5000 = $50.00), the shape the rest of the app uses.
async function createDepositInvoice({ phone, amountCents, note }) {
  const { subdomain } = requireConfig();
  const json = await apiRequest("POST", "/invoices", {
    currency: "CAD",
    // Shown on the invoice; lets staff match it to a text thread from the
    // processor's own dashboard.
    notes: phone ? `Payment link texted to ${phone}` : undefined,
    lineItems: [
      {
        sku: "DEPOSIT",
        description: note ? `Deposit - ${note}` : "Deposit",
        quantity: 1,
        price: amountCents / 100,
      },
    ],
  });

  const invoice = json && typeof json === "object" && json.data ? json.data : json;
  const token = invoice && typeof invoice.token === "string" ? invoice.token : null;
  const invoiceNumber = invoice && invoice.invoiceNumber != null ? String(invoice.invoiceNumber) : null;
  if (!token || !invoiceNumber) {
    // Field names, not values: enough to fix a mismatch, nothing sensitive.
    console.error("[payments] invoice response missing token/invoiceNumber", {
      fields: invoice && typeof invoice === "object" ? Object.keys(invoice) : typeof invoice,
    });
    throw new PaymentProviderError(
      "The payment processor created something, but not in the shape this app expects. Nothing was texted - check the processor's dashboard for a stray invoice.",
    );
  }

  return {
    invoiceNumber,
    token,
    // What the processor says the customer will be asked to pay. Null if it
    // didn't say; deposits.js refuses to text a link whose total differs
    // from what staff typed (e.g. a tax or fee setting added to it).
    amountCents: invoice.amount == null ? null : toCents(invoice.amount),
    url: buildInvoiceUrl(subdomain, token),
  };
}

// The facts about one card transaction, by the id a webhook handed us.
async function getCardTransaction(transactionId) {
  const id = String(transactionId == null ? "" : transactionId);
  // The id goes into the URL path, and it arrives from the internet.
  if (!/^\d{1,20}$/.test(id)) {
    throw new PaymentProviderError("Webhook carried a malformed transaction id.", { retryable: false });
  }
  const json = await apiRequest("GET", `/card-transactions/${id}`);
  const txn = json && typeof json === "object" && json.data ? json.data : json;
  return {
    transactionId: id,
    status: String(txn.status || "").toUpperCase(), // APPROVED | DECLINED
    type: String(txn.type || "").toLowerCase(), // purchase | preauth | verify
    amountCents: toCents(txn.amount),
    currency: String(txn.currency || "").toUpperCase(),
    invoiceNumber: txn.invoiceNumber ? String(txn.invoiceNumber) : null,
  };
}

// Looks an invoice up by number. The list endpoint is a filter, so this only
// ever returns an invoice whose number actually matches - never "whatever
// came back first" - because the caller is about to mark a deposit paid on
// the strength of it.
async function getInvoiceByNumber(invoiceNumber) {
  const wanted = String(invoiceNumber || "").trim();
  if (!wanted) return null;
  const json = await apiRequest("GET", `/invoices?invoiceNumber=${encodeURIComponent(wanted)}`);
  const list = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : [json.data || json];
  const match = list.find(
    (inv) => inv && inv.invoiceNumber != null && String(inv.invoiceNumber).toUpperCase() === wanted.toUpperCase(),
  );
  if (!match) return null;
  return {
    invoiceNumber: String(match.invoiceNumber),
    status: String(match.status || "").toUpperCase(), // DUE until fully paid, then PAID
    amountCents: toCents(match.amount),
    currency: String(match.currency || "").toUpperCase(),
  };
}

// ---- Webhooks ---------------------------------------------------------------
//
// The processor follows the Standard Webhooks spec: an HMAC-SHA256 over
// `${webhook-id}.${webhook-timestamp}.${raw body}`, keyed with the
// base64-DECODED verifier token, sent base64-encoded in `webhook-signature`
// as one or more space-separated "v1,<signature>" values.
//
// Returns { ok: true } or { ok: false, reason } - it never throws, so the
// route can't accidentally treat an exception as a pass.
function verifyWebhookSignature({ headers, rawBody, verifierToken, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const id = headers && headers["webhook-id"];
  const timestamp = headers && headers["webhook-timestamp"];
  const signatureHeader = headers && headers["webhook-signature"];
  if (typeof id !== "string" || typeof timestamp !== "string" || typeof signatureHeader !== "string") {
    return { ok: false, reason: "missing_headers" };
  }
  if (!Buffer.isBuffer(rawBody)) {
    return { ok: false, reason: "no_raw_body" };
  }
  if (!/^\d{1,12}$/.test(timestamp)) {
    return { ok: false, reason: "bad_timestamp" };
  }
  const age = nowSeconds - Number(timestamp);
  if (age > WEBHOOK_MAX_AGE_SECONDS || age < -WEBHOOK_MAX_FUTURE_SECONDS) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }

  const key = Buffer.from(String(verifierToken || ""), "base64");
  if (key.length === 0) {
    return { ok: false, reason: "no_verifier_token" };
  }
  // Sign the exact bytes received - never a re-serialized or re-decoded copy.
  const expected = crypto
    .createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`, "utf8"), rawBody]))
    .digest();

  const matches = signatureHeader.split(" ").some((part) => {
    const comma = part.indexOf(",");
    if (comma === -1 || part.slice(0, comma) !== "v1") return false;
    const provided = Buffer.from(part.slice(comma + 1), "base64");
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  });
  return matches ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}

// Returns { type, id } from a (already verified) webhook body, or null.
function parseWebhookEvent(rawBody) {
  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    return null;
  }
  if (!event || typeof event !== "object" || typeof event.type !== "string") return null;
  return { type: event.type, id: event.id == null ? null : String(event.id) };
}

module.exports = {
  PaymentProviderError,
  getConfig,
  buildInvoiceUrl,
  normalizeSubdomain,
  createDepositInvoice,
  getCardTransaction,
  getInvoiceByNumber,
  verifyWebhookSignature,
  parseWebhookEvent,
};
