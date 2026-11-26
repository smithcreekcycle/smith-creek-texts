// Tests for the deposit workflow (src/deposits.js) - the code that decides
// whether money has really arrived and whether it goes on the customer's
// account (a Shopify order, then store credit).
// Everything external is a fake, so these run with no database or network.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDepositService, DepositError } = require("../src/deposits");

const PHONE = "+12505551234";
const quiet = { log() {}, warn() {}, error() {} };

// A fake world: an in-memory deposits table plus scriptable stand-ins for
// the payment processor, Shopify and Twilio.
function makeWorld(overrides = {}) {
  const world = {
    rows: [],
    texts: [],
    orders: [],
    customersCreated: 0,
    reconciled: [],
    invoicesCreated: 0,
    transactions: {},
    invoices: {},
  };

  world.db = {
    async findRecentHelcimDeposit({ phone, amountCents }) {
      const row = world.rows.find((r) => r.phone === phone && r.amount_cents === amountCents);
      return row ? { id: 1, created_at: row.created_at } : null;
    },
    async recordHelcimDepositCreated({ helcimInvoiceNumber, helcimToken, phone, amountCents, currency, note }) {
      world.rows.push({
        helcim_invoice_number: helcimInvoiceNumber,
        helcim_token: helcimToken,
        phone,
        amount_cents: amountCents,
        currency,
        note,
        status: "pending",
        created_at: new Date(),
      });
    },
    async getDepositByInvoiceNumber(number) {
      return world.rows.find((r) => r.helcim_invoice_number.toUpperCase() === String(number).toUpperCase()) || null;
    },
    async markDepositPaidByInvoiceNumber(number) {
      const row = world.rows.find((r) => r.helcim_invoice_number === number && r.status === "pending");
      if (!row) return false;
      row.status = "paid";
      return true;
    },
    async recordHelcimDepositOrder(number, { shopifyOrderName }) {
      world.rows.find((r) => r.helcim_invoice_number === number).shopify_order_name = shopifyOrderName;
    },
    async recordHelcimDepositOrderError(number, message) {
      const row = world.rows.find((r) => r.helcim_invoice_number === number);
      row.status = "order_failed";
      row.error_message = message;
    },
    ...overrides.db,
  };

  world.payments = {
    async createDepositInvoice({ amountCents }) {
      world.invoicesCreated += 1;
      const invoiceNumber = `INV${1000 + world.invoicesCreated}`;
      return {
        invoiceNumber,
        token: `tok${world.invoicesCreated}`,
        amountCents,
        url: `https://shop.example/order/?token=tok${world.invoicesCreated}`,
      };
    },
    async getCardTransaction(id) {
      const txn = world.transactions[id];
      if (txn instanceof Error) throw txn;
      return txn;
    },
    async getInvoiceByNumber(number) {
      const invoice = world.invoices[number];
      if (invoice instanceof Error) throw invoice;
      return invoice || null;
    },
    ...overrides.payments,
  };

  world.shopifyOrders = {
    async findCustomerByPhone() {
      return { id: "gid://shopify/Customer/1" };
    },
    async findOrCreateCustomerByPhone() {
      return { id: "gid://shopify/Customer/1" };
    },
    async createDepositOrder(args) {
      world.orders.push(args);
      return { id: `gid://shopify/Order/${world.orders.length}`, name: `#${1000 + world.orders.length}` };
    },
    ...overrides.shopifyOrders,
  };

  // The store credit rules have their own tests (storeCredit.test.js); here
  // it only matters that this module asks, once, for the right order.
  world.storeCredit = {
    sku: "DEPOSIT",
    async reconcileOrder(orderId) {
      world.reconciled.push(orderId);
      return { outcome: "credited", cents: 5000 };
    },
    ...overrides.storeCredit,
  };

  world.sms = {
    async sendSms(to, body) {
      world.texts.push({ to, body });
    },
    ...overrides.sms,
  };

  world.service = createDepositService({
    db: world.db,
    payments: world.payments,
    shopifyOrders: world.shopifyOrders,
    storeCredit: world.storeCredit,
    sms: world.sms,
    logger: quiet,
  });
  return world;
}

// Sets up a world where one $50 link has been sent and the customer's
// payment (transaction "777") has gone through in full.
async function worldWithPaidDeposit(overrides) {
  const world = makeWorld(overrides);
  await world.service.sendPaymentLink({ phone: PHONE, amountCents: 5000, note: "Fuel EX" });
  world.transactions["777"] = {
    transactionId: "777",
    status: "APPROVED",
    type: "purchase",
    amountCents: 5000,
    currency: "CAD",
    invoiceNumber: "INV1001",
  };
  world.invoices.INV1001 = { invoiceNumber: "INV1001", status: "PAID", amountCents: 5000, currency: "CAD" };
  return world;
}

// ---- sendPaymentLink -----------------------------------------------------------

test("sendPaymentLink creates the invoice, records it, then texts the link", async () => {
  const world = makeWorld();
  const result = await world.service.sendPaymentLink({ phone: PHONE, amountCents: 5000, note: "Fuel EX" });

  assert.equal(result.outcome, "sent");
  assert.equal(world.rows.length, 1);
  assert.equal(world.rows[0].helcim_invoice_number, "INV1001");
  assert.equal(world.rows[0].amount_cents, 5000);
  assert.equal(world.texts.length, 1);
  assert.equal(world.texts[0].to, PHONE);
  assert.match(world.texts[0].body, /for Fuel EX: https:\/\/shop\.example\/order\/\?token=tok1$/);
});

test("sendPaymentLink won't send the same link twice in a row unless told to", async () => {
  const world = makeWorld();
  await world.service.sendPaymentLink({ phone: PHONE, amountCents: 5000, note: "" });

  const second = await world.service.sendPaymentLink({ phone: PHONE, amountCents: 5000, note: "" });
  assert.equal(second.outcome, "duplicate");
  assert.equal(world.invoicesCreated, 1, "no second invoice");
  assert.equal(world.texts.length, 1, "no second text");

  const confirmed = await world.service.sendPaymentLink({
    phone: PHONE,
    amountCents: 5000,
    note: "",
    allowDuplicate: true,
  });
  assert.equal(confirmed.outcome, "sent");
  assert.equal(world.invoicesCreated, 2);

  const differentAmount = await world.service.sendPaymentLink({ phone: PHONE, amountCents: 7500, note: "" });
  assert.equal(differentAmount.outcome, "sent", "a different amount is a different link");
});

test("two identical sends at the same instant produce one invoice", async () => {
  const world = makeWorld();
  const [a, b] = await Promise.all([
    world.service.sendPaymentLink({ phone: PHONE, amountCents: 5000, note: "" }),
    world.service.sendPaymentLink({ phone: PHONE, amountCents: 5000, note: "" }),
  ]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ["in_progress", "sent"]);
  assert.equal(world.invoicesCreated, 1);
  assert.equal(world.texts.length, 1);

  // ...and the in-flight marker is released afterwards, even after a failure.
  const failing = makeWorld({
    payments: {
      async createDepositInvoice() {
        throw new Error("boom");
      },
    },
  });
  await assert.rejects(failing.service.sendPaymentLink({ phone: PHONE, amountCents: 5000, note: "" }));
  await assert.rejects(failing.service.sendPaymentLink({ phone: PHONE, amountCents: 5000, note: "" }), /boom/);
});

test("if the text fails, staff get the link back instead of a dead end", async () => {
  const world = makeWorld({
    sms: {
      async sendSms() {
        throw new Error("The 'To' number is not a valid phone number");
      },
    },
  });
  const result = await world.service.sendPaymentLink({ phone: PHONE, amountCents: 5000, note: "" });

  assert.equal(result.outcome, "sms_failed");
  assert.equal(result.url, "https://shop.example/order/?token=tok1");
  assert.match(result.reason, /not a valid phone number/);
  assert.equal(world.rows.length, 1, "the deposit is still recorded so a payment on that link is recognized");
});

test("a link is never texted if the deposit couldn't be saved", async () => {
  const world = makeWorld({
    db: {
      async recordHelcimDepositCreated() {
        throw new Error("connection terminated");
      },
    },
  });
  await assert.rejects(world.service.sendPaymentLink({ phone: PHONE, amountCents: 5000, note: "" }), (err) => {
    assert.ok(err instanceof DepositError);
    assert.match(err.message, /INV1001/);
    assert.equal(
      err.message.includes("connection terminated"),
      false,
      "internal error text stays out of the staff message",
    );
    return true;
  });
  assert.equal(world.texts.length, 0);
});

test("a link is never texted if the processor's total differs from what staff typed", async () => {
  const world = makeWorld({
    payments: {
      async createDepositInvoice() {
        return {
          invoiceNumber: "INV2000",
          token: "tok",
          amountCents: 5250,
          url: "https://shop.example/order/?token=tok",
        };
      },
    },
  });
  await assert.rejects(
    world.service.sendPaymentLink({ phone: PHONE, amountCents: 5000, note: "" }),
    /\$52\.50 instead of \$50\.00/,
  );
  assert.equal(world.texts.length, 0);
  assert.equal(world.rows.length, 0);
});

// ---- handleCardTransaction -------------------------------------------------------

test("a fully paid deposit becomes exactly one Shopify order, then store credit", async () => {
  const world = await worldWithPaidDeposit();
  const result = await world.service.handleCardTransaction("777");

  assert.deepEqual(result, {
    outcome: "paid",
    invoiceNumber: "INV1001",
    shopifyOrderName: "#1001",
    storeCredit: "credited",
  });
  assert.equal(world.rows[0].status, "paid");
  assert.equal(world.rows[0].shopify_order_name, "#1001");
  assert.deepEqual(world.orders, [
    {
      customerId: "gid://shopify/Customer/1",
      amountCents: 5000,
      note: "Fuel EX",
      depositSku: "DEPOSIT",
      provider: "Helcim",
      providerReference: "INV1001",
    },
  ]);
  assert.deepEqual(world.reconciled, ["gid://shopify/Order/1"], "store credit asked for once, for that order");
});

test("the deposit is still recorded when the customer can't be looked up", async () => {
  const refused = Object.assign(new Error("Shopify rejected the request (ACCESS_DENIED)"), { retryable: false });
  const world = await worldWithPaidDeposit({
    shopifyOrders: {
      async findOrCreateCustomerByPhone() {
        throw refused;
      },
    },
  });
  const result = await world.service.handleCardTransaction("777");

  assert.equal(result.outcome, "paid");
  assert.equal(world.orders[0].customerId, null, "recorded without a customer; staff attach one");
  assert.equal(world.orders[0].depositSku, "DEPOSIT");
});

test("if Shopify is unreachable before anything is written, the payment is retried, not lost", async () => {
  const down = Object.assign(new Error("Shopify request failed in transit (TimeoutError)"), { retryable: true });
  const world = await worldWithPaidDeposit({
    shopifyOrders: {
      async findOrCreateCustomerByPhone() {
        throw down;
      },
    },
  });

  await assert.rejects(world.service.handleCardTransaction("777"), /in transit/);
  assert.equal(world.rows[0].status, "pending", "still pending, so the redelivered webhook can finish the job");
  assert.equal(world.orders.length, 0);
});

test("a store credit hiccup doesn't undo the recorded deposit", async () => {
  const world = await worldWithPaidDeposit({
    storeCredit: {
      async reconcileOrder() {
        throw Object.assign(new Error("Another update to order #1001 is in progress"), { retryable: true });
      },
    },
  });
  const result = await world.service.handleCardTransaction("777");

  assert.equal(result.outcome, "paid");
  assert.equal(result.storeCredit, "pending", "the Shopify webhook and the sweep will finish it");
  assert.equal(world.rows[0].status, "paid");
  assert.equal(world.orders.length, 1);
});

test("a redelivered or replayed webhook never creates a second order", async () => {
  const world = await worldWithPaidDeposit();
  await world.service.handleCardTransaction("777");
  const again = await world.service.handleCardTransaction("777");

  assert.equal(again.outcome, "ignored");
  assert.equal(again.reason, "already_processed");
  assert.equal(world.orders.length, 1);
});

test("two deliveries racing each other still create only one order", async () => {
  const world = await worldWithPaidDeposit();
  const results = await Promise.all([
    world.service.handleCardTransaction("777"),
    world.service.handleCardTransaction("777"),
  ]);

  assert.deepEqual(results.map((r) => r.outcome).sort(), ["ignored", "paid"]);
  assert.equal(world.orders.length, 1);
});

test("a declined card, a pre-auth, or a card check is not a payment", async () => {
  for (const change of [{ status: "DECLINED" }, { type: "preauth" }, { type: "verify" }]) {
    const world = await worldWithPaidDeposit();
    Object.assign(world.transactions["777"], change);
    const result = await world.service.handleCardTransaction("777");
    assert.equal(result.outcome, "ignored", JSON.stringify(change));
    assert.equal(world.rows[0].status, "pending");
    assert.equal(world.orders.length, 0);
  }
});

test("payments that have nothing to do with this app are ignored quietly", async () => {
  const world = await worldWithPaidDeposit();
  world.transactions["888"] = {
    transactionId: "888",
    status: "APPROVED",
    type: "purchase",
    amountCents: 4999,
    currency: "CAD",
    invoiceNumber: "INV-TERMINAL-5",
  };
  world.transactions["889"] = {
    transactionId: "889",
    status: "APPROVED",
    type: "purchase",
    amountCents: 4999,
    currency: "CAD",
    invoiceNumber: null,
  };

  assert.equal((await world.service.handleCardTransaction("888")).reason, "not_a_text_payment_link");
  assert.equal((await world.service.handleCardTransaction("889")).reason, "no_invoice_on_transaction");
  assert.equal(world.orders.length, 0);
});

test("an approved transaction is not enough - the invoice itself must say PAID", async () => {
  // Someone who could forge "transaction approved" still can't get an order
  // created unless the processor's own invoice record agrees.
  const world = await worldWithPaidDeposit();
  world.invoices.INV1001.status = "DUE";

  await assert.rejects(world.service.handleCardTransaction("777"), (err) => err.retryable === true);
  assert.equal(world.rows[0].status, "pending");
  assert.equal(world.orders.length, 0);

  // Once the invoice catches up, the redelivery completes it.
  world.invoices.INV1001.status = "PAID";
  assert.equal((await world.service.handleCardTransaction("777")).outcome, "paid");
});

test("a partial payment leaves the deposit pending and creates nothing", async () => {
  const world = await worldWithPaidDeposit();
  world.transactions["777"].amountCents = 2000;
  world.invoices.INV1001.status = "DUE";

  const result = await world.service.handleCardTransaction("777");
  assert.equal(result.outcome, "partial");
  assert.equal(world.rows[0].status, "pending");
  assert.equal(world.orders.length, 0);
});

test("a processor outage asks for redelivery instead of losing the payment", async () => {
  const outage = Object.assign(new Error("Couldn't reach the payment processor"), { retryable: true });

  const world = await worldWithPaidDeposit();
  world.transactions["777"] = outage;
  await assert.rejects(world.service.handleCardTransaction("777"), /reach the payment processor/);

  const world2 = await worldWithPaidDeposit();
  world2.invoices.INV1001 = outage;
  await assert.rejects(world2.service.handleCardTransaction("777"), /reach the payment processor/);
  assert.equal(world2.rows[0].status, "pending", "nothing is marked paid until the invoice is confirmed");

  const world3 = await worldWithPaidDeposit();
  delete world3.invoices.INV1001;
  await assert.rejects(world3.service.handleCardTransaction("777"), (err) => err.retryable === true);
});

test("a transaction id the processor doesn't recognize is dropped, not retried forever", async () => {
  const world = await worldWithPaidDeposit();
  world.transactions["777"] = Object.assign(new Error("rejected (404)"), { retryable: false });
  assert.deepEqual(await world.service.handleCardTransaction("777"), {
    outcome: "ignored",
    reason: "transaction_lookup_rejected",
  });
});

test("if Shopify fails after payment, the deposit is flagged for manual entry and not retried", async () => {
  const world = await worldWithPaidDeposit({
    shopifyOrders: {
      async createDepositOrder() {
        throw new Error("Shopify GraphQL request failed: 503");
      },
    },
  });
  const result = await world.service.handleCardTransaction("777");

  assert.equal(result.outcome, "paid_order_failed");
  assert.equal(world.rows[0].status, "order_failed");
  assert.match(world.rows[0].error_message, /503/);
  assert.equal(world.reconciled.length, 0, "no store credit without an order to hang it on");

  // A later delivery must not take another run at Shopify.
  assert.equal((await world.service.handleCardTransaction("777")).reason, "already_processed");
});

test("a paid invoice whose total doesn't match goes to a person, not to Shopify", async () => {
  const world = await worldWithPaidDeposit();
  world.invoices.INV1001.amountCents = 5250;

  const result = await world.service.handleCardTransaction("777");
  assert.equal(result.outcome, "paid_needs_review");
  assert.equal(world.rows[0].status, "order_failed");
  assert.match(world.rows[0].error_message, /\$52\.50/);
  assert.equal(world.orders.length, 0);
  assert.equal(world.reconciled.length, 0);
});

test("invoice numbers match regardless of letter case", async () => {
  const world = await worldWithPaidDeposit();
  world.transactions["777"].invoiceNumber = "inv1001";
  assert.equal((await world.service.handleCardTransaction("777")).outcome, "paid");
});
