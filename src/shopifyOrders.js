// Shopify reads and writes for customers and orders. Thin wrappers: each
// function is one Admin API call and returns plain data. Decisions about what
// to do with that data live in deposits.js and storeCredit.js.

const { adminGraphQL, ShopifyApiError } = require("./shopify");
const { normalizePhone } = require("./phone");
const { parseMoneyToCents, centsToAmount } = require("./money");

const CURRENCY = "CAD";

// A deposit order with more lines than this is not something a bike shop
// rings up; storeCredit.js sends it to a person instead of guessing.
const MAX_ORDER_LINES = 50;

// ---- Customers -------------------------------------------------------------

async function findCustomerByPhone(phone) {
  const e164 = normalizePhone(phone);
  if (!e164) return null;
  const data = await adminGraphQL(
    `query FindCustomerByPhone($q: String!) {
      customers(first: 1, query: $q) { nodes { id } }
    }`,
    // normalizePhone only ever returns "+" and digits, so this can't smuggle
    // extra search terms into the query.
    { q: `phone:${e164}` },
  );
  const nodes = data.customers && data.customers.nodes;
  return nodes && nodes.length ? nodes[0] : null;
}

// Store credit belongs to a customer, so a deposit paid from a number Shopify
// has never seen needs a customer record to hold it. Created with the phone
// number only: no marketing consent of any kind is set or implied.
async function createCustomerForPhone(phone) {
  const e164 = normalizePhone(phone);
  if (!e164) throw new ShopifyApiError("Not a usable phone number", { applied: "no", retryable: false });
  const data = await adminGraphQL(
    `mutation CreateDepositCustomer($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer { id }
        userErrors { field message }
      }
    }`,
    {
      input: {
        phone: e164,
        tags: ["deposit-by-text"],
        note: "Created automatically when a deposit was paid by text link. Add their name when you know it.",
      },
    },
  );
  const result = data.customerCreate;
  if (result && result.customer) return result.customer;
  throw new ShopifyApiError("Shopify wouldn't create a customer for that phone number", {
    applied: "no",
    retryable: false,
    code: "CUSTOMER_CREATE_REFUSED",
  });
}

async function findOrCreateCustomerByPhone(phone) {
  const existing = await findCustomerByPhone(phone);
  if (existing) return existing;
  try {
    return await createCustomerForPhone(phone);
  } catch (err) {
    // Most likely someone created the same customer a moment ago (the number
    // is "already taken"). One more look settles it.
    if (err.code !== "CUSTOMER_CREATE_REFUSED") throw err;
    const again = await findCustomerByPhone(phone);
    if (again) return again;
    throw err;
  }
}

// ---- Orders ----------------------------------------------------------------

// Records a deposit that was already paid through a text payment link as a
// paid Shopify order, so it sits in the customer's order history next to
// deposits taken in store. The line is named and SKU'd like the Customer
// Deposit item staff ring up in POS (so both show as one product in sales
// reports and in the books), and that SKU is what storeCredit.js looks for
// when it puts the money on the customer's account. Non-taxable: tax is
// charged on the full price when the goods are actually sold.
async function createDepositOrder({ customerId, amountCents, note, depositSku, provider, providerReference }) {
  const amount = centsToAmount(amountCents);
  const money = { shopMoney: { amount, currencyCode: CURRENCY } };
  const line = {
    title: "Customer Deposit",
    sku: depositSku,
    quantity: 1,
    priceSet: money,
    requiresShipping: false,
    taxable: false,
  };
  if (note) line.properties = [{ name: "For", value: note }];

  const order = {
    currency: CURRENCY,
    note: `Deposit paid by text payment link (${provider} reference ${providerReference})${note ? ` - ${note}` : ""}`,
    tags: ["customer-deposit", "deposit-by-text"],
    lineItems: [line],
    transactions: [{ kind: "SALE", status: "SUCCESS", gateway: provider, amountSet: money }],
  };
  if (customerId) order.customer = { toAssociate: { id: customerId } };

  const data = await adminGraphQL(
    `mutation CreateDepositOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        order { id name }
        userErrors { field message }
      }
    }`,
    { order, options: { sendReceipt: true, sendFulfillmentReceipt: false } },
  );
  const result = data.orderCreate;
  if (!result || !result.order) {
    const fields = ((result && result.userErrors) || []).map((e) => (e.field || []).join(".")).filter(Boolean);
    throw new ShopifyApiError(`Shopify refused the deposit order${fields.length ? ` (${fields.join(", ")})` : ""}`, {
      applied: "no",
      retryable: false,
      code: "ORDER_CREATE_REFUSED",
    });
  }
  return result.order;
}

const DEPOSIT_ORDER_FIELDS = `
  id
  name
  test
  cancelledAt
  processedAt
  updatedAt
  currencyCode
  displayFinancialStatus
  note
  customer { id }
  netPaymentSet { shopMoney { amount currencyCode } }
  lineItems(first: ${MAX_ORDER_LINES}) {
    pageInfo { hasNextPage }
    nodes {
      sku
      quantity
      currentQuantity
      originalTotalSet { shopMoney { amount } }
      discountAllocations { allocatedAmountSet { shopMoney { amount } } }
    }
  }
`;

// Flattens Shopify's order into just what the store-credit rules need, in
// integer cents. Anything that can't be read exactly comes back as null and
// sets `unreadable`, so the caller refuses to act rather than act on a guess.
function summarizeOrder(order) {
  let unreadable = false;
  const cents = (moneyBag) => {
    const value = parseMoneyToCents(moneyBag && moneyBag.shopMoney && moneyBag.shopMoney.amount);
    if (value == null) unreadable = true;
    return value;
  };
  const lines = ((order.lineItems && order.lineItems.nodes) || []).map((line) => {
    const original = cents(line.originalTotalSet);
    const discounts = (line.discountAllocations || []).reduce((sum, d) => {
      const value = cents(d.allocatedAmountSet);
      return sum + (value || 0);
    }, 0);
    return {
      sku: typeof line.sku === "string" ? line.sku.trim() : "",
      quantity: line.quantity,
      currentQuantity: line.currentQuantity,
      // What the customer was actually charged for this line.
      netCents: original == null ? null : Math.max(0, original - discounts),
    };
  });
  return {
    id: order.id,
    name: order.name,
    test: Boolean(order.test),
    cancelled: Boolean(order.cancelledAt),
    processedAt: order.processedAt,
    updatedAt: order.updatedAt,
    currency: order.currencyCode,
    financialStatus: order.displayFinancialStatus,
    note: order.note || "",
    customerId: order.customer ? order.customer.id : null,
    netPaymentCents: cents(order.netPaymentSet),
    lines,
    truncated: Boolean(order.lineItems && order.lineItems.pageInfo && order.lineItems.pageInfo.hasNextPage),
    unreadable,
  };
}

// The current truth about one order, straight from Shopify. Null if Shopify
// has no such order or won't show it to this app (orders older than 60 days
// need the read_all_orders scope).
async function getDepositOrder(orderId) {
  const data = await adminGraphQL(
    `query GetDepositOrder($id: ID!) {
      order(id: $id) { ${DEPOSIT_ORDER_FIELDS} }
    }`,
    { id: orderId },
  );
  return data.order ? summarizeOrder(data.order) : null;
}

// Staff type an order number ("#1234" or "1234"); Shopify's name search is
// fuzzy ("#2951" also finds "LS2951"), so only an exact match is returned.
async function findOrderIdByName(name) {
  const data = await adminGraphQL(
    `query FindOrderByName($q: String!) {
      orders(first: 10, query: $q) { nodes { id name } }
    }`,
    { q: `name:"${name}"` },
  );
  const nodes = (data.orders && data.orders.nodes) || [];
  const match = nodes.find((o) => o.name === name);
  return match ? match.id : null;
}

// Orders containing the deposit SKU that changed since `since` (and, if
// given, were sold on or after `soldSince`). The safety net behind the
// webhooks: anything missed while the app was asleep or restarting is found
// here.
async function listRecentDepositOrders({ sku, since, soldSince = null, limit = 50 }) {
  const terms = [`sku:${sku}`, `updated_at:>='${since.toISOString()}'`];
  if (soldSince) terms.push(`processed_at:>='${soldSince.toISOString()}'`);
  const data = await adminGraphQL(
    `query RecentDepositOrders($q: String!, $first: Int!) {
      orders(first: $first, query: $q, sortKey: UPDATED_AT, reverse: true) { nodes { id updatedAt } }
    }`,
    { q: terms.join(" "), first: limit },
  );
  return (data.orders && data.orders.nodes) || [];
}

module.exports = {
  CURRENCY,
  MAX_ORDER_LINES,
  findCustomerByPhone,
  createCustomerForPhone,
  findOrCreateCustomerByPhone,
  createDepositOrder,
  summarizeOrder,
  getDepositOrder,
  findOrderIdByName,
  listRecentDepositOrders,
};
