// Helcim replacement for the old Stripe Checkout flow.
//
// Helcim has no direct equivalent of a Stripe Checkout Session (a one-off API
// call that hands back a ready-to-text hosted URL). The closest match is the
// Invoice API: we create an invoice for the deposit amount, then build the
// customer-facing link ourselves from the invoice's `token` plus our Helcim
// subdomain, per Helcim's documented pattern:
//
//   https://{subdomain}.myhelcim.com/order/?token={invoiceToken}
//
// Requires two env vars (set directly in Render, not passed through this app):
//   HELCIM_API_TOKEN  - the API token from All Tools > API Access Configurations
//   HELCIM_SUBDOMAIN  - the business DBA subdomain, e.g. "smith-creek-cycle"
//                        (the part before ".myhelcim.com")
//
// NOTE: Helcim's Create Invoice response field names below (token,
// invoiceNumber, invoiceId) are taken from their published docs, but this
// hasn't been exercised against a live Helcim account yet. The first real
// invoice created after deploy should be checked against Render's logs
// (logDepositInvoiceResponse below logs the raw response) in case a field
// name needs adjusting.

const HELCIM_API_BASE = "https://api.helcim.com/v2";

function getConfig() {
  const apiToken = process.env.HELCIM_API_TOKEN;
  const subdomain = process.env.HELCIM_SUBDOMAIN;
  if (!apiToken || !subdomain) return null;
  return { apiToken, subdomain };
}

function buildInvoiceUrl(subdomain, token) {
  return `https://${subdomain}.myhelcim.com/order/?token=${encodeURIComponent(token)}`;
}

// Creates a one-off Helcim invoice for a text-a-payment-link deposit.
// amountCents is an integer number of cents (e.g. 5000 = $50.00), matching
// the shape the rest of the app already uses for Stripe.
async function createDepositInvoice({ phone, amountCents, note }) {
  const config = getConfig();
  if (!config) {
    throw new Error("Helcim is not configured (HELCIM_API_TOKEN / HELCIM_SUBDOMAIN missing)");
  }

  const description = note ? `Deposit - ${note}` : "Deposit";
  const amount = Math.round(amountCents) / 100;

  const res = await fetch(`${HELCIM_API_BASE}/invoices`, {
    method: "POST",
    headers: {
      "api-token": config.apiToken,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      currency: "CAD",
      lineItems: [
        {
          description,
          quantity: 1,
          price: amount,
          sku: "DEPOSIT",
        },
      ],
      // Not a documented field, but harmless if ignored - keeps the phone
      // number visible on the invoice if Helcim's UI shows a notes field.
      notes: phone ? `Phone: ${phone}` : undefined,
    }),
  });

  const rawText = await res.text();
  let body;
  try {
    body = rawText ? JSON.parse(rawText) : {};
  } catch (e) {
    body = null;
  }

  // Log the raw response once per call so the first live invoice can be
  // sanity-checked in Render logs without needing a debugger.
  console.log("[helcim] create invoice response", res.status, rawText);

  if (!res.ok) {
    throw new Error(`Helcim invoice creation failed (${res.status}): ${rawText}`);
  }
  if (!body) {
    throw new Error(`Helcim invoice creation returned unparseable response: ${rawText}`);
  }

  // Helcim's docs show the invoice object directly in the response, but be
  // defensive in case it's nested under a `data` key.
  const invoice = body.data || body;
  const token = invoice.token || invoice.invoiceToken;
  const invoiceNumber = invoice.invoiceNumber || invoice.invoice_number;
  const invoiceId = invoice.invoiceId || invoice.id;

  if (!token || !invoiceNumber) {
    throw new Error(
      `Helcim invoice response missing token/invoiceNumber - check Render logs for the raw response and adjust helcimPayments.js field names. Raw: ${rawText}`
    );
  }

  return {
    invoiceId,
    invoiceNumber: String(invoiceNumber),
    token,
    url: buildInvoiceUrl(config.subdomain, token),
  };
}

// Fetches the full invoice (and its linked transactions) from Helcim by
// invoiceNumber, used by the webhook handler to confirm a payment before
// trusting it - the webhook payload itself is documented as "thin" and
// shouldn't be trusted for the amount/approval status on its own.
async function getInvoiceByNumber(invoiceNumber) {
  const config = getConfig();
  if (!config) {
    throw new Error("Helcim is not configured (HELCIM_API_TOKEN / HELCIM_SUBDOMAIN missing)");
  }

  const res = await fetch(
    `${HELCIM_API_BASE}/invoices?invoiceNumber=${encodeURIComponent(invoiceNumber)}`,
    {
      method: "GET",
      headers: {
        "api-token": config.apiToken,
        accept: "application/json",
      },
    }
  );

  const rawText = await res.text();
  console.log("[helcim] get invoice response", res.status, rawText);

  if (!res.ok) {
    throw new Error(`Helcim get-invoice failed (${res.status}): ${rawText}`);
  }

  let body;
  try {
    body = rawText ? JSON.parse(rawText) : {};
  } catch (e) {
    throw new Error(`Helcim get-invoice returned unparseable response: ${rawText}`);
  }

  // Get invoices (plural, filtered) typically returns an array; Get invoice
  // (singular, by ID) returns an object. Handle both shapes.
  const invoice = Array.isArray(body) ? body[0] : Array.isArray(body.data) ? body.data[0] : body.data || body;
  return invoice || null;
}

module.exports = { getConfig, createDepositInvoice, getInvoiceByNumber, buildInvoiceUrl };
