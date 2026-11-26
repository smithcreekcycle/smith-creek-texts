// Tests for the store credit rules (src/storeCredit.js) - the code that
// decides how much of a customer's money is "on account" and moves it.
// Shopify and the database are fakes, so these run with no network. The real
// SQL is exercised separately against Postgres.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createStoreCreditService, computeTarget, depositSkuFromEnv, liveFromEnv } = require("../src/storeCredit");

const ORDER = "gid://shopify/Order/1";
const CUSTOMER = "gid://shopify/Customer/7";
const quiet = { log() {}, warn() {}, error() {} };

// An order as shopifyOrders.summarizeOrder returns it: a $300 deposit rung up
// as 300 x the $1 Customer Deposit item, paid in full.
function order(overrides = {}) {
  return {
    id: ORDER,
    name: "#1001",
    test: false,
    cancelled: false,
    processedAt: "2026-11-26T18:00:00Z",
    updatedAt: "2026-11-26T18:00:00Z",
    currency: "CAD",
    financialStatus: "PAID",
    note: "Marin Rift Zone",
    customerId: CUSTOMER,
    netPaymentCents: 30000,
    lines: [{ sku: "DEPOSIT", quantity: 300, currentQuantity: 300, netCents: 30000 }],
    truncated: false,
    unreadable: false,
    ...overrides,
  };
}

function shopifyError(message, fields) {
  return Object.assign(new Error(message), { name: "ShopifyApiError" }, fields);
}

// An in-memory stand-in for the order_deposits table that follows the same
// rules as the SQL in db.js: changes are compare-and-swap, and frozen rows
// can't be claimed.
function makeWorld({ orders = { [ORDER]: order() } } = {}) {
  const world = {
    orders,
    rows: {},
    ledger: [],
    credits: [],
    debits: [],
    creditFails: [],
    debitFails: [],
    listed: null,
  };
  const frozen = (row) => row.state === "unknown" || row.state === "blocked" || row.stuck;

  world.db = {
    async getOrderDeposit(id) {
      return world.rows[id] ? { ...world.rows[id] } : null;
    },
    async upsertOrderDeposit({ shopifyOrderId, orderName, orderNote }) {
      world.rows[shopifyOrderId] = {
        shopify_order_id: shopifyOrderId,
        customer_id: null,
        credited_cents: 0,
        state: "ok",
        pending_delta_cents: null,
        message: null,
        synced_updated_at: null,
        stuck: false,
        ...world.rows[shopifyOrderId],
        order_name: orderName,
        order_note: orderNote,
      };
      return { ...world.rows[shopifyOrderId] };
    },
    async markOrderDepositSynced(id, updatedAt) {
      if (world.rows[id].state === "ok") world.rows[id].synced_updated_at = updatedAt;
    },
    async claimOrderDepositChange({ shopifyOrderId, expectedCents, newCents, customerId }) {
      const row = world.rows[shopifyOrderId];
      if (!row || row.credited_cents !== expectedCents || !["ok", "needs_review"].includes(row.state)) return false;
      Object.assign(row, {
        credited_cents: newCents,
        pending_delta_cents: newCents - expectedCents,
        customer_id: customerId,
        state: "in_progress",
        message: null,
      });
      return true;
    },
    async finishOrderDepositChange(id) {
      const row = world.rows[id];
      if (row.state === "in_progress") Object.assign(row, { state: "ok", pending_delta_cents: null, message: null });
    },
    async releaseOrderDepositChange(id, message) {
      const row = world.rows[id];
      if (row.state !== "in_progress") return;
      Object.assign(row, {
        credited_cents: row.credited_cents - row.pending_delta_cents,
        pending_delta_cents: null,
        state: "needs_review",
        message,
      });
    },
    async freezeOrderDepositChange(id, state, message) {
      const row = world.rows[id];
      if (row.state === "in_progress") Object.assign(row, { state, message });
    },
    async setOrderDepositNote(id, message) {
      const row = world.rows[id];
      if (!["ok", "needs_review"].includes(row.state)) return;
      Object.assign(row, { state: message == null ? "ok" : "needs_review", message });
    },
    async settleFrozenOrderDeposit(id, { keep }) {
      const row = world.rows[id];
      if (!row || !frozen(row)) return null;
      const before = { ...row };
      Object.assign(row, {
        credited_cents: keep ? row.credited_cents : row.credited_cents - (row.pending_delta_cents || 0),
        pending_delta_cents: null,
        state: "ok",
        message: null,
        stuck: false,
      });
      return before;
    },
    async recordStoreCreditLedger(entry) {
      world.ledger.push(entry);
    },
  };

  world.shopifyOrders = {
    async getDepositOrder(id) {
      const found = world.orders[id];
      if (found instanceof Error) throw found;
      return found || null;
    },
    async findOrderIdByName(name) {
      const found = Object.values(world.orders).find((o) => o.name === name);
      return found ? found.id : null;
    },
    async listRecentDepositOrders() {
      if (world.listed instanceof Error) throw world.listed;
      return world.listed || Object.values(world.orders).map((o) => ({ id: o.id, updatedAt: o.updatedAt }));
    },
  };

  // creditFails / debitFails are queues of errors to throw before succeeding.
  world.shopifyStoreCredit = {
    async credit({ customerId, cents }) {
      if (world.creditFails.length) throw world.creditFails.shift();
      world.credits.push({ customerId, cents });
      return { transactionId: `gid://shopify/StoreCreditAccountCreditTransaction/${world.credits.length}` };
    },
    async debit({ customerId, cents }) {
      if (world.debitFails.length) throw world.debitFails.shift();
      world.debits.push({ customerId, cents });
      return { transactionId: `gid://shopify/StoreCreditAccountDebitTransaction/${world.debits.length}` };
    },
  };

  world.service = createStoreCreditService({
    db: world.db,
    shopifyOrders: world.shopifyOrders,
    shopifyStoreCredit: world.shopifyStoreCredit,
    sku: "DEPOSIT",
    liveFrom: new Date("2026-11-26T08:00:00Z"),
    logger: quiet,
  });
  // Net store credit this app has actually moved at Shopify.
  world.balance = () =>
    world.credits.reduce((sum, c) => sum + c.cents, 0) - world.debits.reduce((sum, d) => sum + d.cents, 0);
  return world;
}

// ---- computeTarget: how much should be on account? ------------------------------

const target = (o, creditedCents = 0) => computeTarget(o, { sku: "DEPOSIT", creditedCents });

test("an order with no deposit item is not a deposit order", () => {
  const result = target(order({ lines: [{ sku: "TUBE-29", quantity: 1, currentQuantity: 1, netCents: 1200 }] }));
  assert.deepEqual(result, { isDepositOrder: false });
});

test("a paid deposit is worth what the customer paid for the deposit lines", () => {
  assert.equal(target(order()).targetCents, 30000);
});

test("the deposit SKU matches regardless of case or stray spaces already trimmed by Shopify", () => {
  const o = order({
    lines: [{ sku: "deposit", quantity: 1, currentQuantity: 1, netCents: 5000 }],
    netPaymentCents: 5000,
  });
  assert.equal(target(o).targetCents, 5000);
});

test("other items on the same order are not deposit money", () => {
  const o = order({
    lines: [
      { sku: "DEPOSIT", quantity: 300, currentQuantity: 300, netCents: 30000 },
      { sku: "TUBE-29", quantity: 1, currentQuantity: 1, netCents: 1200 },
    ],
    netPaymentCents: 31344,
  });
  assert.equal(target(o).targetCents, 30000);
});

test("a discounted deposit line is worth what was charged, not the list price", () => {
  // A storewide 20%-off sale that caught the deposit item: the customer paid $240.
  const o = order({
    lines: [{ sku: "DEPOSIT", quantity: 300, currentQuantity: 300, netCents: 24000 }],
    netPaymentCents: 24000,
  });
  assert.equal(target(o).targetCents, 24000);
});

test("a deposit discounted to nothing is worth nothing", () => {
  const o = order({
    lines: [{ sku: "DEPOSIT", quantity: 300, currentQuantity: 300, netCents: 0 }],
    netPaymentCents: 0,
  });
  assert.equal(target(o).targetCents, 0);
});

test("refunded units no longer count", () => {
  const o = order({
    financialStatus: "PARTIALLY_REFUNDED",
    lines: [{ sku: "DEPOSIT", quantity: 300, currentQuantity: 200, netCents: 30000 }],
    netPaymentCents: 20000,
  });
  assert.equal(target(o, 30000).targetCents, 20000);
});

test("a refund by amount (no line items) still brings the credit down", () => {
  const o = order({ financialStatus: "PARTIALLY_REFUNDED", netPaymentCents: 21600 });
  assert.equal(target(o, 30000).targetCents, 21600);
});

test("a fully refunded deposit is worth nothing", () => {
  const o = order({
    financialStatus: "REFUNDED",
    lines: [{ sku: "DEPOSIT", quantity: 300, currentQuantity: 0, netCents: 30000 }],
    netPaymentCents: 0,
  });
  assert.equal(target(o, 30000).targetCents, 0);
});

test("credit never exceeds the money actually kept, whatever the lines say", () => {
  assert.equal(target(order({ netPaymentCents: 25000 })).targetCents, 25000);
  assert.equal(target(order({ netPaymentCents: -500 })).targetCents, 0);
});

test("an order that isn't fully paid earns no credit", () => {
  for (const financialStatus of ["PENDING", "AUTHORIZED", "PARTIALLY_PAID", "EXPIRED", "VOIDED"]) {
    assert.equal(target(order({ financialStatus, netPaymentCents: 30000 })).targetCents, 0, financialStatus);
  }
});

test("an order that stops being fully paid keeps the credit it has, but gains none", () => {
  // e.g. the order was edited and now has a balance owing.
  const o = order({ financialStatus: "PARTIALLY_PAID" });
  assert.equal(target(o, 30000).targetCents, 30000);
  assert.equal(target(o, 10000).targetCents, 10000);
});

test("a test order is worth nothing", () => {
  assert.equal(target(order({ test: true })).targetCents, 0);
});

test("a split cent is rounded down, never up", () => {
  const o = order({
    lines: [{ sku: "DEPOSIT", quantity: 3, currentQuantity: 2, netCents: 100 }],
    netPaymentCents: 100,
  });
  assert.equal(target(o).targetCents, 66);
});

test("an order the app can't read exactly is a problem, not a guess", () => {
  for (const change of [
    { currency: "USD" },
    { unreadable: true },
    { truncated: true },
    { lines: [{ sku: "DEPOSIT", quantity: 1, currentQuantity: 1, netCents: null }] },
  ]) {
    const result = target(order(change));
    assert.equal(result.targetCents, null, JSON.stringify(change));
    assert.match(result.problem, /#1001/);
  }
});

test("nonsense quantities can't produce credit", () => {
  const o = order({ lines: [{ sku: "DEPOSIT", quantity: 0, currentQuantity: 5, netCents: 30000 }] });
  assert.equal(target(o).targetCents, 0);
  const over = order({ lines: [{ sku: "DEPOSIT", quantity: 1, currentQuantity: 9, netCents: 30000 }] });
  assert.equal(target(over).targetCents, 30000, "current quantity is capped at the quantity sold");
});

test("a sale from before deposits went live is never a deposit, whatever SKU it carries", () => {
  const liveFrom = new Date("2026-11-26T08:00:00Z");
  const at = (processedAt) => computeTarget(order({ processedAt }), { sku: "DEPOSIT", creditedCents: 0, liveFrom });
  // An old sale imported from the previous point-of-sale system last week.
  assert.deepEqual(at("2025-08-22T19:10:59Z"), { isDepositOrder: false });
  assert.deepEqual(at("2026-11-26T07:59:59Z"), { isDepositOrder: false });
  assert.deepEqual(at(null), { isDepositOrder: false }, "no sale date, no credit");
  assert.deepEqual(at("garbage"), { isDepositOrder: false });
  assert.equal(at("2026-11-26T08:00:00Z").targetCents, 30000);
});

// ---- reconcileOrder: moving the credit ---------------------------------------------

test("an imported historical sale is ignored end to end", async () => {
  const world = makeWorld({ orders: { [ORDER]: order({ name: "LS22513", processedAt: "2025-08-22T19:10:59Z" }) } });
  assert.deepEqual(await world.service.reconcileOrder(ORDER), { outcome: "ignored", reason: "not_a_deposit_order" });
  assert.deepEqual(world.rows, {});
  assert.equal(world.credits.length, 0);
});

test("a paid deposit is credited to the customer exactly once", async () => {
  const world = makeWorld();
  assert.deepEqual(await world.service.reconcileOrder(ORDER), {
    outcome: "credited",
    orderName: "#1001",
    cents: 30000,
  });
  assert.deepEqual(world.credits, [{ customerId: CUSTOMER, cents: 30000 }]);
  assert.equal(world.rows[ORDER].state, "ok");
  assert.equal(world.rows[ORDER].credited_cents, 30000);

  // Every later look at the same order - a redelivered webhook, the sweep,
  // a staff re-check - changes nothing.
  for (let i = 0; i < 3; i++) assert.equal((await world.service.reconcileOrder(ORDER)).outcome, "in_sync");
  assert.equal(world.credits.length, 1);
  assert.deepEqual(
    world.ledger.map((l) => [l.outcome, l.deltaCents]),
    [["applied", 30000]],
  );
});

test("two triggers for the same order at the same moment credit once", async () => {
  const world = makeWorld();
  const results = await Promise.allSettled([world.service.reconcileOrder(ORDER), world.service.reconcileOrder(ORDER)]);

  assert.equal(world.credits.length, 1);
  assert.equal(world.balance(), 30000);
  const fulfilled = results.filter((r) => r.status === "fulfilled").map((r) => r.value.outcome);
  assert.ok(fulfilled.includes("credited"));
  // The loser either saw it finished or was told to come back later.
  for (const r of results) {
    if (r.status === "rejected") assert.equal(r.reason.retryable, true);
  }
});

test("if the order changes while credit is being added, the app corrects itself before returning", async () => {
  const world = makeWorld();
  // The customer is refunded in the same instant the credit goes through:
  // the snapshot the credit was based on is already stale.
  const realCredit = world.shopifyStoreCredit.credit;
  world.shopifyStoreCredit.credit = async (args) => {
    world.orders[ORDER] = order({ financialStatus: "REFUNDED", netPaymentCents: 0, updatedAt: "2026-11-26T18:00:01Z" });
    return realCredit(args);
  };

  const result = await world.service.reconcileOrder(ORDER);
  assert.equal(result.outcome, "credited", "reports what it did first");
  assert.deepEqual(world.debits, [{ customerId: CUSTOMER, cents: 30000 }], "then took it straight back");
  assert.equal(world.balance(), 0);
  assert.equal(world.rows[ORDER].credited_cents, 0);
  assert.equal(world.rows[ORDER].state, "ok");
});

test("a failed re-check after a change doesn't undo or hide the change", async () => {
  const world = makeWorld();
  let reads = 0;
  const realGet = world.shopifyOrders.getDepositOrder;
  world.shopifyOrders.getDepositOrder = async (id) => {
    reads += 1;
    if (reads === 2) throw shopifyError("Shopify answered 503", { applied: "unknown", retryable: true });
    return realGet(id);
  };
  assert.equal((await world.service.reconcileOrder(ORDER)).outcome, "credited");
  assert.equal(world.balance(), 30000);
  assert.equal(world.rows[ORDER].state, "ok");
});

test("a refused CREDIT is never mistaken for a spent balance", async () => {
  const world = makeWorld();
  world.creditFails.push(shopifyError("refused", { applied: "no", retryable: false, code: "ACCOUNT_NOT_FOUND" }));
  const result = await world.service.reconcileOrder(ORDER);
  assert.equal(result.outcome, "needs_review");
  assert.equal(world.rows[ORDER].state, "needs_review", "left open to retry, not frozen");
  assert.doesNotMatch(world.rows[ORDER].message, /refunded|spent/);
  assert.equal(world.rows[ORDER].credited_cents, 0);
});

test("an unexpected internal error is frozen as unknown and its text never reaches the staff page", async () => {
  const world = makeWorld();
  world.creditFails.push(new TypeError("Cannot read properties of undefined (reading 'secretThing')"));
  assert.equal((await world.service.reconcileOrder(ORDER)).outcome, "unknown");
  assert.doesNotMatch(world.rows[ORDER].message, /secretThing|undefined/);
  assert.equal(world.credits.length, 0);
});

test("an ordinary order is ignored and leaves no trace", async () => {
  const world = makeWorld({
    orders: { [ORDER]: order({ lines: [{ sku: "TUBE-29", quantity: 1, currentQuantity: 1, netCents: 1200 }] }) },
  });
  assert.equal((await world.service.reconcileOrder(ORDER)).outcome, "ignored");
  assert.deepEqual(world.rows, {});
  assert.equal(world.credits.length, 0);
});

test("refunding part of a deposit takes that part of the credit back", async () => {
  const world = makeWorld();
  await world.service.reconcileOrder(ORDER);
  world.orders[ORDER] = order({
    financialStatus: "PARTIALLY_REFUNDED",
    lines: [{ sku: "DEPOSIT", quantity: 300, currentQuantity: 200, netCents: 30000 }],
    netPaymentCents: 20000,
  });

  assert.deepEqual(await world.service.reconcileOrder(ORDER), {
    outcome: "reversed",
    orderName: "#1001",
    cents: 10000,
  });
  assert.deepEqual(world.debits, [{ customerId: CUSTOMER, cents: 10000 }]);
  assert.equal(world.rows[ORDER].credited_cents, 20000);
  assert.equal(world.balance(), 20000);
});

test("refunding the whole deposit takes all of the credit back, once", async () => {
  const world = makeWorld();
  await world.service.reconcileOrder(ORDER);
  world.orders[ORDER] = order({
    financialStatus: "REFUNDED",
    lines: [{ sku: "DEPOSIT", quantity: 300, currentQuantity: 0, netCents: 30000 }],
    netPaymentCents: 0,
  });
  await world.service.reconcileOrder(ORDER);
  await world.service.reconcileOrder(ORDER);

  assert.equal(world.debits.length, 1);
  assert.equal(world.balance(), 0);
  assert.equal(world.rows[ORDER].credited_cents, 0);
});

test("a deposit with no customer waits, then follows the customer once one is added", async () => {
  const world = makeWorld({ orders: { [ORDER]: order({ customerId: null }) } });
  const first = await world.service.reconcileOrder(ORDER);
  assert.equal(first.outcome, "needs_review");
  assert.equal(first.reason, "no_customer");
  assert.match(world.rows[ORDER].message, /no customer/);
  assert.equal(world.credits.length, 0);

  world.orders[ORDER] = order();
  assert.equal((await world.service.reconcileOrder(ORDER)).outcome, "credited");
  assert.equal(world.rows[ORDER].state, "ok");
  assert.equal(world.rows[ORDER].message, null);
});

test("if Shopify times out mid-credit, nothing is repeated until a person has looked", async () => {
  const world = makeWorld();
  world.creditFails.push(shopifyError("Shopify request failed in transit (TimeoutError)", { applied: "unknown" }));

  assert.equal((await world.service.reconcileOrder(ORDER)).outcome, "unknown");
  assert.equal(world.rows[ORDER].state, "unknown");
  assert.match(world.rows[ORDER].message, /may or may not have gone through/);

  // The webhook is redelivered, the sweep runs, someone presses Re-check...
  for (let i = 0; i < 3; i++) assert.equal((await world.service.reconcileOrder(ORDER)).outcome, "frozen");
  assert.equal(world.credits.length, 0, "no second attempt on its own");
  assert.equal(world.ledger[0].outcome, "unknown");
});

test("staff confirm an uncertain credit went through: nothing more is sent", async () => {
  const world = makeWorld();
  world.creditFails.push(shopifyError("timeout", { applied: "unknown" }));
  await world.service.reconcileOrder(ORDER);

  assert.deepEqual(await world.service.settle(ORDER, { applied: true }), { outcome: "settled" });
  assert.equal(world.rows[ORDER].state, "ok");
  assert.equal(world.rows[ORDER].credited_cents, 30000);
  assert.equal((await world.service.reconcileOrder(ORDER)).outcome, "in_sync");
  assert.equal(world.credits.length, 0, "the app trusts the person and sends nothing");
});

test("staff say an uncertain credit did NOT go through: it is sent again, once", async () => {
  const world = makeWorld();
  world.creditFails.push(shopifyError("timeout", { applied: "unknown" }));
  await world.service.reconcileOrder(ORDER);

  assert.equal((await world.service.settle(ORDER, { applied: false })).outcome, "credited");
  assert.deepEqual(world.credits, [{ customerId: CUSTOMER, cents: 30000 }]);
  assert.equal(world.rows[ORDER].credited_cents, 30000);
  assert.deepEqual(await world.service.settle(ORDER, { applied: false }), { outcome: "not_frozen" });
  assert.equal(world.credits.length, 1);
});

test("a change interrupted by a crash is frozen for a person, not retried blind", async () => {
  const world = makeWorld();
  await world.db.upsertOrderDeposit({ shopifyOrderId: ORDER, orderName: "#1001", orderNote: "" });
  // The process died between claiming the change and hearing back from Shopify.
  Object.assign(world.rows[ORDER], {
    state: "in_progress",
    stuck: true,
    credited_cents: 30000,
    pending_delta_cents: 30000,
  });

  assert.equal((await world.service.reconcileOrder(ORDER)).outcome, "frozen");
  assert.equal(world.credits.length, 0);
  assert.equal((await world.service.settle(ORDER, { applied: false })).outcome, "credited");
  assert.equal(world.balance(), 30000);
});

test("an update already in flight asks the caller to come back later", async () => {
  const world = makeWorld();
  await world.db.upsertOrderDeposit({ shopifyOrderId: ORDER, orderName: "#1001", orderNote: "" });
  Object.assign(world.rows[ORDER], { state: "in_progress", stuck: false });

  await assert.rejects(world.service.reconcileOrder(ORDER), (err) => err.retryable === true);
  assert.equal(world.credits.length, 0);
});

test("a missing permission is reported, undone cleanly, and works once approved", async () => {
  const world = makeWorld();
  world.creditFails.push(
    shopifyError("Shopify rejected the request (ACCESS_DENIED)", {
      applied: "no",
      retryable: false,
      code: "ACCESS_DENIED",
    }),
  );

  const first = await world.service.reconcileOrder(ORDER);
  assert.equal(first.outcome, "needs_review");
  assert.equal(world.rows[ORDER].credited_cents, 0, "the claim was undone");
  assert.match(world.rows[ORDER].message, /missing a permission/);

  assert.equal((await world.service.reconcileOrder(ORDER)).outcome, "credited");
  assert.equal(world.rows[ORDER].message, null);
  assert.equal(world.balance(), 30000);
});

test("being rate-limited undoes the claim and asks for a retry", async () => {
  const world = makeWorld();
  world.creditFails.push(
    shopifyError("Shopify rejected the request (THROTTLED)", { applied: "no", retryable: true, code: "THROTTLED" }),
  );

  await assert.rejects(world.service.reconcileOrder(ORDER), (err) => err.retryable === true);
  assert.equal(world.rows[ORDER].credited_cents, 0);
  assert.equal((await world.service.reconcileOrder(ORDER)).outcome, "credited");
  assert.equal(world.credits.length, 1);
});

test("a refund after the credit was spent is stopped for a person, and never retried on its own", async () => {
  const world = makeWorld();
  await world.service.reconcileOrder(ORDER);
  world.orders[ORDER] = order({
    financialStatus: "REFUNDED",
    lines: [{ sku: "DEPOSIT", quantity: 300, currentQuantity: 0, netCents: 30000 }],
    netPaymentCents: 0,
  });
  const refused = () =>
    shopifyError("Shopify refused the store credit debit (INSUFFICIENT_FUNDS)", {
      applied: "no",
      retryable: false,
      code: "INSUFFICIENT_FUNDS",
    });
  world.debitFails.push(refused());

  assert.equal((await world.service.reconcileOrder(ORDER)).outcome, "blocked");
  assert.match(world.rows[ORDER].message, /already spent/);
  // A later deposit must not be quietly raided to cover this one.
  for (let i = 0; i < 3; i++) assert.equal((await world.service.reconcileOrder(ORDER)).outcome, "frozen");
  assert.equal(world.debits.length, 0);

  // "Leave it as is": written off, and the order is settled for good.
  assert.deepEqual(await world.service.settle(ORDER, { applied: true }), { outcome: "settled" });
  assert.equal((await world.service.reconcileOrder(ORDER)).outcome, "in_sync");
  assert.equal(world.debits.length, 0);
  assert.equal(world.ledger.at(-1).outcome, "settled_by_staff_as_applied");
});

test("after a blocked reversal, 'try again' retries it for real", async () => {
  const world = makeWorld();
  await world.service.reconcileOrder(ORDER);
  world.orders[ORDER] = order({ financialStatus: "REFUNDED", netPaymentCents: 0 });
  world.debitFails.push(shopifyError("refused", { applied: "no", retryable: false, code: "INSUFFICIENT_FUNDS" }));
  await world.service.reconcileOrder(ORDER);

  assert.equal((await world.service.settle(ORDER, { applied: false })).outcome, "reversed");
  assert.deepEqual(world.debits, [{ customerId: CUSTOMER, cents: 30000 }]);
  assert.equal(world.balance(), 0);
});

test("credit follows the customer it was issued to; a swapped customer goes to a person", async () => {
  const world = makeWorld();
  await world.service.reconcileOrder(ORDER);
  world.orders[ORDER] = order({
    customerId: "gid://shopify/Customer/99",
    financialStatus: "REFUNDED",
    netPaymentCents: 0,
  });

  const result = await world.service.reconcileOrder(ORDER);
  assert.equal(result.reason, "customer_changed");
  assert.equal(world.debits.length, 0, "nobody else's balance is touched");
  assert.equal(world.rows[ORDER].credited_cents, 30000);
});

test("an order Shopify won't show: ignored if unknown, flagged if credit was issued for it", async () => {
  const world = makeWorld({ orders: {} });
  assert.deepEqual(await world.service.reconcileOrder(ORDER), { outcome: "ignored", reason: "order_not_found" });

  const tracked = makeWorld();
  await tracked.service.reconcileOrder(ORDER);
  delete tracked.orders[ORDER];
  assert.equal((await tracked.service.reconcileOrder(ORDER)).reason, "order_not_readable");
  assert.match(tracked.rows[ORDER].message, /read_all_orders/);
  assert.equal(tracked.debits.length, 0);
});

test("if the deposit line vanishes from a credited order, nothing is unwound automatically", async () => {
  const world = makeWorld();
  await world.service.reconcileOrder(ORDER);
  // e.g. DEPOSIT_SKU was changed in the app's settings.
  world.orders[ORDER] = order({ lines: [{ sku: "OTHER", quantity: 300, currentQuantity: 300, netCents: 30000 }] });

  assert.equal((await world.service.reconcileOrder(ORDER)).outcome, "needs_review");
  assert.equal(world.debits.length, 0);
  assert.equal(world.rows[ORDER].credited_cents, 30000);
});

test("an unreadable order is flagged and nothing moves", async () => {
  const world = makeWorld({ orders: { [ORDER]: order({ currency: "USD" }) } });
  const result = await world.service.reconcileOrder(ORDER);
  assert.equal(result.outcome, "needs_review");
  assert.match(world.rows[ORDER].message, /USD.*Nothing was changed/);
  assert.equal(world.credits.length, 0);
});

test("a Shopify outage while reading the order is passed up for a retry", async () => {
  const world = makeWorld({
    orders: { [ORDER]: shopifyError("Shopify answered 503", { applied: "unknown", retryable: true }) },
  });
  await assert.rejects(world.service.reconcileOrder(ORDER), /503/);
  assert.deepEqual(world.rows, {});
});

test("only a real Shopify order ID is accepted", async () => {
  const world = makeWorld();
  for (const bad of [undefined, 1, "", "1", "gid://shopify/Customer/1", "gid://shopify/Order/1 OR 1=1"]) {
    await assert.rejects(world.service.reconcileOrder(bad), TypeError);
    await assert.rejects(world.service.settle(bad, { applied: true }), TypeError);
  }
});

// ---- staff tools and the sweep -----------------------------------------------------

test("checking an order by its number finds it and reconciles it", async () => {
  const world = makeWorld();
  assert.equal((await world.service.recheckByName("#1001")).outcome, "credited");
  assert.deepEqual(await world.service.recheckByName("#9999"), { outcome: "ignored", reason: "order_not_found" });
});

test("settling something that isn't waiting on a person does nothing", async () => {
  const world = makeWorld();
  await world.service.reconcileOrder(ORDER);
  assert.deepEqual(await world.service.settle(ORDER, { applied: false }), { outcome: "not_frozen" });
  assert.equal(world.rows[ORDER].credited_cents, 30000);
  assert.equal(world.debits.length, 0);
});

test("the sweep picks up orders no webhook told us about, and skips ones already handled", async () => {
  const second = "gid://shopify/Order/2";
  const world = makeWorld({
    orders: {
      [ORDER]: order(),
      [second]: order({
        id: second,
        name: "#1002",
        netPaymentCents: 5000,
        lines: [{ sku: "DEPOSIT", quantity: 50, currentQuantity: 50, netCents: 5000 }],
      }),
    },
  });

  assert.deepEqual(await world.service.sweepRecentOrders(), { checked: 2, changed: 2, failed: 0 });
  assert.equal(world.balance(), 35000);
  assert.deepEqual(
    await world.service.sweepRecentOrders(),
    { checked: 0, changed: 0, failed: 0 },
    "nothing has changed since",
  );

  // A refund lands (the order's updatedAt moves) while the app wasn't listening.
  world.orders[second] = {
    ...world.orders[second],
    financialStatus: "REFUNDED",
    netPaymentCents: 0,
    updatedAt: "2026-11-27T09:00:00Z",
  };
  assert.deepEqual(await world.service.sweepRecentOrders(), { checked: 1, changed: 1, failed: 0 });
  assert.equal(world.balance(), 30000);
});

test("one bad order doesn't stop the sweep, and a Shopify outage doesn't throw", async () => {
  const second = "gid://shopify/Order/2";
  const world = makeWorld({
    orders: {
      [ORDER]: shopifyError("Shopify answered 503", { retryable: true }),
      [second]: order({ id: second, name: "#1002" }),
    },
  });
  world.listed = [
    { id: ORDER, updatedAt: "2026-11-26T18:00:00Z" },
    { id: second, updatedAt: "2026-11-26T18:00:00Z" },
  ];
  assert.deepEqual(await world.service.sweepRecentOrders(), { checked: 2, changed: 1, failed: 1 });

  world.listed = shopifyError("Shopify answered 503", { retryable: true });
  assert.deepEqual(await world.service.sweepRecentOrders(), { checked: 0, changed: 0, failed: 1 });
});

test("the go-live date setting must be a real date", () => {
  const saved = process.env.DEPOSITS_LIVE_FROM;
  try {
    delete process.env.DEPOSITS_LIVE_FROM;
    assert.equal(liveFromEnv().toISOString(), "2026-11-26T08:00:00.000Z");
    process.env.DEPOSITS_LIVE_FROM = "2026-12-01";
    assert.equal(liveFromEnv().toISOString(), "2026-12-01T00:00:00.000Z");
    for (const bad of ["soon", "0", "12/01/2026", "2026-13-45"]) {
      process.env.DEPOSITS_LIVE_FROM = bad;
      assert.throws(() => liveFromEnv(), /DEPOSITS_LIVE_FROM/, bad);
    }
  } finally {
    if (saved === undefined) delete process.env.DEPOSITS_LIVE_FROM;
    else process.env.DEPOSITS_LIVE_FROM = saved;
  }
});

test("the deposit SKU setting can't carry anything but a plain SKU", () => {
  const saved = process.env.DEPOSIT_SKU;
  try {
    delete process.env.DEPOSIT_SKU;
    assert.equal(depositSkuFromEnv(), "DEPOSIT");
    process.env.DEPOSIT_SKU = " dep-01 ";
    assert.equal(depositSkuFromEnv(), "dep-01");
    for (const bad of ["DEPOSIT OR sku:*", 'a"b', "", "x".repeat(41)]) {
      process.env.DEPOSIT_SKU = bad;
      if (bad === "") assert.equal(depositSkuFromEnv(), "DEPOSIT");
      else assert.throws(() => depositSkuFromEnv(), /DEPOSIT_SKU/);
    }
  } finally {
    if (saved === undefined) delete process.env.DEPOSIT_SKU;
    else process.env.DEPOSIT_SKU = saved;
  }
});
