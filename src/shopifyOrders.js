const { adminGraphQL } = require("./shopify");

const CURRENCY = "CAD";

function toE164(phone) {
  const raw = String(phone || "").trim();
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

async function findCustomerByPhone(phone) {
  const e164 = toE164(phone);
  if (!e164) return null;

const query = `
query FindCustomerByPhone($q: String!) {
customers(first: 1, query: $q) {
edges {
node {
id
displayName
phone
email
}
}
}
}
`;

const json = await adminGraphQL(query, { q: `phone:${e164}` });
  const edges = json.data && json.data.customers && json.data.customers.edges;
  return edges && edges.length ? edges[0].node : null;
}

    // Creates a real Shopify order for a deposit that was already collected via
// a text payment link, so it shows up in the customer's order history. The
// order is recorded as paid using a SALE transaction referencing the
// payment gateway it actually went through.
//
// provider/providerReference default to the original Stripe shape so the
// dormant Stripe code path (still kept as a backup) keeps working unchanged
// if it's ever called again; the Helcim call site passes provider: "Helcim".
async function createDepositOrder({
  customerId,
  amountCents,
  note,
  stripeSessionId,
  provider = "Stripe",
  providerReference = stripeSessionId,
}) {
  const amount = (amountCents / 100).toFixed(2);
  const title = note ? `Deposit - ${note}` : "Deposit";
  const orderNote = `Deposit collected via text payment link (${provider} reference ${providerReference})${note ? ` - ${note}` : ""}`;

const mutation = `
mutation CreateDepositOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
orderCreate(order: $order, options: $options) {
order {
id
name
}
userErrors {
field
message
}
}
}
`;

const order = {
  currency: CURRENCY,
  note: orderNote,
  lineItems: [
    {
      title,
      quantity: 1,
      priceSet: { shopMoney: { amount, currencyCode: CURRENCY } },
      requiresShipping: false,
      taxable: false,
    },
    ],
  transactions: [
    {
      kind: "SALE",
      status: "SUCCESS",
      gateway: provider,
      amountSet: { shopMoney: { amount, currencyCode: CURRENCY } },
    },
    ],
};

if (customerId) {
  order.customer = { toAssociate: { id: customerId } };
}

const variables = {
  order,
  options: { sendReceipt: true, sendFulfillmentReceipt: false },
};

const json = await adminGraphQL(mutation, variables);
  const result = json.data && json.data.orderCreate;
  if (!result) {
    throw new Error("Shopify orderCreate returned no data: " + JSON.stringify(json));
  }
  if (result.userErrors && result.userErrors.length) {
    throw new Error("Shopify orderCreate error: " + JSON.stringify(result.userErrors));
  }
  return result.order;
}

module.exports = { findCustomerByPhone, createDepositOrder, toE164 };
