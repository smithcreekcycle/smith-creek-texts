// Deposits on a customer's account.
//
// Shopify has no "deposit" feature, so a deposit is held as store credit:
// a balance on the customer's profile that staff can see in Shopify admin and
// POS, and that the customer spends like any other payment method when they
// pick up the bike.
//
// A deposit always arrives the same way: a PAID Shopify order containing the
// deposit item (the product with SKU "DEPOSIT"). There are two sources -
//
//   in store   staff ring up the Customer Deposit item in Shopify POS
//   by text    a paid text payment link is recorded as an order (deposits.js)
//
// - and one rule, applied by reconcileOrder() below:
//
//   The store credit this app has issued for an order should equal the value
//   of the deposit items still on it, and never more than the money the shop
//   has actually kept for that order.
//
// So a paid deposit adds credit, a refunded one takes it back, and every
// trigger (a webhook, the sweep, a button on the staff page) does the same
// thing: read the order from Shopify, work out what the credit should be,
// and move it by the difference. Running it twice changes nothing.
//
// Everything external is passed in, so the rules can be tested with fakes.

const { formatDollars } = require("./money");

const CURRENCY = "CAD";

// Shopify's "all the money has arrived" statuses. Credit is only ever ADDED
// in one of these; an order that is pending, authorized or part-paid can
// only hold or lose credit.
const FULLY_PAID = new Set(["PAID", "PARTIALLY_REFUNDED", "REFUNDED"]);

// How far back the sweep looks. Shopify retries a failed webhook for about
// four hours; this covers a long weekend of the app being down.
const SWEEP_WINDOW_HOURS = 72;

const ORDER_GID = /^gid:\/\/shopify\/Order\/\d+$/;

// Orders sold before this moment are never treated as deposits, whatever SKU
// they carry. The shop's sales history was imported from its previous
// point-of-sale system, and nothing in that history - or in any later import
// of old sales - may turn into store credit. Shopify's processedAt is the
// date of the sale itself, not the date the record was created.
const DEFAULT_LIVE_FROM = "2026-11-26T08:00:00Z"; // midnight Pacific, the day this shipped

function liveFromEnv() {
  const raw = String(process.env.DEPOSITS_LIVE_FROM || DEFAULT_LIVE_FROM).trim();
  const date = new Date(raw);
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw) || Number.isNaN(date.getTime())) {
    throw new Error("DEPOSITS_LIVE_FROM must be a date like 2026-12-01 or 2026-12-01T08:00:00Z");
  }
  return date;
}

// The SKU that marks a deposit line. Letters, digits, dash and underscore
// only: it's placed inside a Shopify search query.
function depositSkuFromEnv() {
  const sku = String(process.env.DEPOSIT_SKU || "DEPOSIT").trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(sku)) {
    throw new Error("DEPOSIT_SKU may only contain letters, digits, dashes and underscores (max 40)");
  }
  return sku;
}

// An error that means "nothing is wrong with the data - try this again in a
// little while". The webhook route answers 503 so Shopify redelivers.
class RetryLater extends Error {
  constructor(message) {
    super(message);
    this.name = "RetryLater";
    this.retryable = true;
  }
}

// Pure. Given an order (as shopifyOrders.summarizeOrder returns it) and the
// credit already issued for it, what should the credit be?
//
// Returns { isDepositOrder: false } for an order with no deposit line, or
// { isDepositOrder: true, targetCents, problem } - `problem` is a message
// for staff when the order can't be trusted enough to act on (targetCents is
// then null).
function computeTarget(order, { sku, creditedCents, liveFrom = null }) {
  const wanted = sku.toUpperCase();
  const depositLines = order.lines.filter((line) => line.sku.toUpperCase() === wanted);
  if (depositLines.length === 0) return { isDepositOrder: false };

  // A sale from before deposits went live (or with no readable sale date)
  // is history, not a deposit.
  if (liveFrom) {
    const soldAt = new Date(order.processedAt).getTime();
    if (Number.isNaN(soldAt) || soldAt < liveFrom.getTime()) return { isDepositOrder: false };
  }

  if (order.truncated) {
    return problem(`Order ${order.name} has too many lines for this app to read safely.`);
  }
  if (order.unreadable || depositLines.some((line) => line.netCents == null)) {
    return problem(`Shopify sent amounts for order ${order.name} that this app couldn't read exactly.`);
  }
  if (order.currency !== CURRENCY) {
    return problem(`Order ${order.name} is in ${order.currency}, not ${CURRENCY}.`);
  }

  // What the deposit lines are still worth: refunded or removed units no
  // longer count. Rounded down, so a split cent is never credited.
  const remainingCents = depositLines.reduce((sum, line) => {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) return sum;
    const kept = Math.min(Math.max(line.currentQuantity, 0), line.quantity);
    return sum + Math.floor((line.netCents * kept) / line.quantity);
  }, 0);

  // Never more than the shop has actually kept, whatever the lines say.
  // A test order is worth nothing.
  const ceilingCents = order.test ? 0 : Math.min(remainingCents, Math.max(order.netPaymentCents, 0));

  const targetCents = FULLY_PAID.has(order.financialStatus) ? ceilingCents : Math.min(creditedCents, ceilingCents);
  return { isDepositOrder: true, targetCents, problem: null };

  function problem(message) {
    return { isDepositOrder: true, targetCents: null, problem: message };
  }
}

// Shopify's two ways of saying "there isn't that much credit left to take".
function spentCode(code) {
  return code === "INSUFFICIENT_FUNDS" || code === "ACCOUNT_NOT_FOUND" ? "SPENT" : code;
}

// After a change, the order is read again to make sure nothing moved while
// the change was being made. This many passes at most; the sweep is the
// backstop beyond that.
const MAX_PASSES = 3;

function createStoreCreditService({
  db,
  shopifyOrders,
  shopifyStoreCredit,
  sku = depositSkuFromEnv(),
  liveFrom = liveFromEnv(),
  logger = console,
}) {
  // Explains a refused or uncertain Shopify call to the person who will
  // read it on the staff page. No customer details, no raw API text.
  function describeFailure(err, { orderName, deltaCents }) {
    const amount = formatDollars(deltaCents);
    const adding = deltaCents > 0;
    switch (adding ? err.code : spentCode(err.code)) {
      case "SPENT":
        return `Order ${orderName}'s deposit was refunded, but ${amount} of the store credit couldn't be taken back - the customer has already spent it. Check their store credit in Shopify.`;
      case "ACCESS_DENIED":
        return `Shopify wouldn't let this app change store credit for order ${orderName} (the app is missing a permission). Once the permission is approved, press Re-check.`;
      case "OWNER_NOT_FOUND":
        return `The customer on order ${orderName} no longer exists in Shopify, so ${amount} of store credit couldn't be added.`;
      case "CREDIT_LIMIT_EXCEEDED":
        return `Adding ${amount} for order ${orderName} would put the customer over Shopify's store credit limit.`;
      default: {
        // Only our own Shopify errors are written to be read by staff.
        const why = err && err.name === "ShopifyApiError" ? ` (${err.message})` : "";
        return adding
          ? `Couldn't add ${amount} of store credit for order ${orderName}${why}.`
          : `Couldn't take back ${amount} of store credit for order ${orderName}${why}.`;
      }
    }
  }

  // Brings the store credit issued for one order into line with the order.
  //
  // Resolves to { outcome, ... } where outcome is one of:
  //   ignored        not a deposit order (the usual case for most orders)
  //   in_sync        nothing to do
  //   credited       store credit was added     { cents }
  //   reversed       store credit was taken back { cents }
  //   needs_review   couldn't act; staff page says why; will retry by itself
  //   frozen         waiting on a person (an earlier change is unresolved)
  //   blocked        Shopify refused and a retry won't help; waiting on a person
  //   unknown        the change may or may not have been made; waiting on a person
  //
  // Rejects (retryable) when Shopify couldn't be read or another update to
  // the same order is mid-flight - the caller should simply try again later.
  async function reconcileOrder(orderId) {
    if (typeof orderId !== "string" || !ORDER_GID.test(orderId)) {
      throw new TypeError("reconcileOrder needs a Shopify order ID");
    }
    const result = await reconcileOnce(orderId);

    // A change was made from a snapshot of the order. If the order moved in
    // the meantime (a refund landing in the same second, say), that snapshot
    // was already out of date - so look again, now, rather than wait for the
    // next webhook or sweep to notice. Usually this is one read that finds
    // everything in step.
    let last = result;
    for (let pass = 1; pass < MAX_PASSES && (last.outcome === "credited" || last.outcome === "reversed"); pass++) {
      try {
        last = await reconcileOnce(orderId);
        if (last.outcome === "credited" || last.outcome === "reversed") {
          logger.warn("[store-credit] order changed mid-update; corrected", { orderId, ...last });
        }
      } catch (err) {
        // The first change stands and is recorded; the sweep will re-check.
        logger.warn("[store-credit] couldn't re-check after a change", { orderId, error: err.message });
        break;
      }
    }
    return result;
  }

  async function reconcileOnce(orderId) {
    const order = await shopifyOrders.getDepositOrder(orderId);
    if (!order) {
      const tracked = await db.getOrderDeposit(orderId);
      if (!tracked) return { outcome: "ignored", reason: "order_not_found" };
      await db.setOrderDepositNote(
        orderId,
        `Shopify wouldn't show this app order ${tracked.order_name || ""}. Orders older than 60 days need the read_all_orders permission.`,
      );
      return { outcome: "needs_review", reason: "order_not_readable" };
    }

    const first = computeTarget(order, { sku, creditedCents: 0, liveFrom });
    let row = await db.getOrderDeposit(orderId);
    if (!first.isDepositOrder && (!row || row.credited_cents === 0)) {
      return { outcome: "ignored", reason: "not_a_deposit_order" };
    }

    row = await db.upsertOrderDeposit({ shopifyOrderId: order.id, orderName: order.name, orderNote: order.note });
    if (!row) throw new RetryLater("The database isn't available");

    if (row.state === "unknown" || row.state === "blocked" || row.stuck) {
      return { outcome: "frozen", orderName: order.name };
    }
    if (row.state === "in_progress") {
      throw new RetryLater(`Another update to order ${order.name} is in progress`);
    }

    // Refunded and removed lines stay on the order (at quantity zero), so a
    // tracked order with no deposit line at all means something else changed
    // - most likely the DEPOSIT_SKU setting. Don't unwind credit on that.
    const calc = first.isDepositOrder
      ? computeTarget(order, { sku, creditedCents: row.credited_cents, liveFrom })
      : {
          problem: `Order ${order.name} no longer shows a line with SKU ${sku}, but ${formatDollars(row.credited_cents)} of store credit was issued for it.`,
        };
    if (calc.problem) {
      await db.setOrderDepositNote(orderId, `${calc.problem} Nothing was changed.`);
      return { outcome: "needs_review", reason: "order_unreadable", orderName: order.name };
    }

    const deltaCents = calc.targetCents - row.credited_cents;
    if (deltaCents === 0) {
      if (row.state === "needs_review") await db.setOrderDepositNote(orderId, null);
      await db.markOrderDepositSynced(orderId, order.updatedAt);
      return { outcome: "in_sync", orderName: order.name, creditedCents: row.credited_cents };
    }

    // Whose account? Once credit has been issued it is tied to the customer
    // it went to; until then, whoever is on the order now.
    let customerId;
    if (row.credited_cents > 0) {
      customerId = row.customer_id;
      if (order.customerId && order.customerId !== customerId) {
        await db.setOrderDepositNote(
          orderId,
          `The customer on order ${order.name} was changed after ${formatDollars(row.credited_cents)} of store credit was issued. Move the credit by hand in Shopify. Nothing was changed.`,
        );
        return { outcome: "needs_review", reason: "customer_changed", orderName: order.name };
      }
    } else {
      customerId = order.customerId;
    }
    if (!customerId) {
      await db.setOrderDepositNote(
        orderId,
        `Order ${order.name} has a ${formatDollars(deltaCents)} deposit but no customer. Add the customer to the order in Shopify and the store credit will follow.`,
      );
      return { outcome: "needs_review", reason: "no_customer", orderName: order.name };
    }

    // The gate: exactly one caller gets past this for any given change.
    const claimed = await db.claimOrderDepositChange({
      shopifyOrderId: orderId,
      expectedCents: row.credited_cents,
      newCents: calc.targetCents,
      customerId,
    });
    if (!claimed) throw new RetryLater(`Order ${order.name} changed while it was being updated`);

    const ledger = (outcome, extra = {}) =>
      db
        .recordStoreCreditLedger({ shopifyOrderId: orderId, customerId, deltaCents, outcome, ...extra })
        .catch((err) => logger.error("[store-credit] couldn't write the ledger", { orderId, error: err.message }));

    let txn;
    try {
      txn =
        deltaCents > 0
          ? await shopifyStoreCredit.credit({ customerId, cents: deltaCents })
          : await shopifyStoreCredit.debit({ customerId, cents: -deltaCents });
    } catch (err) {
      const message = describeFailure(err, { orderName: order.name, deltaCents });
      if (err.applied !== "no") {
        // Timed out, dropped, 5xx: the change may have been made. Leave the
        // claim in place and stop - repeating it could double the credit.
        await db.freezeOrderDepositChange(
          orderId,
          "unknown",
          `${deltaCents > 0 ? "Adding" : "Taking back"} ${formatDollars(deltaCents)} of store credit for order ${order.name} may or may not have gone through. Check the customer's store credit history in Shopify, then choose below.`,
        );
        await ledger("unknown", { detail: err.message });
        logger.error("[store-credit] outcome unknown; frozen for review", { orderId, deltaCents, error: err.message });
        return { outcome: "unknown", orderName: order.name };
      }
      if (deltaCents < 0 && spentCode(err.code) === "SPENT") {
        // Definitely not applied, and trying again every half hour would
        // quietly take the money out of whatever credit the customer is
        // given next. A person decides.
        await db.freezeOrderDepositChange(orderId, "blocked", message);
        await ledger("refused", { detail: err.code });
        logger.error("[store-credit] reversal refused; frozen for review", { orderId, deltaCents, code: err.code });
        return { outcome: "blocked", orderName: order.name };
      }
      // Definitely not applied, and may well work later (throttled, a
      // permission not approved yet): undo the claim and leave it open.
      await db.releaseOrderDepositChange(orderId, message);
      await ledger("refused", { detail: err.code || err.message });
      logger.error("[store-credit] change refused; will retry", { orderId, deltaCents, error: err.message });
      if (err.retryable) throw new RetryLater(err.message);
      return { outcome: "needs_review", reason: "refused", orderName: order.name };
    }

    await db.finishOrderDepositChange(orderId);
    await db.markOrderDepositSynced(orderId, order.updatedAt);
    await ledger("applied", { shopifyTransactionId: txn.transactionId });
    logger.log("[store-credit] store credit updated", { orderId, orderName: order.name, deltaCents });
    return {
      outcome: deltaCents > 0 ? "credited" : "reversed",
      orderName: order.name,
      cents: Math.abs(deltaCents),
    };
  }

  // Staff typed an order number on the payments page.
  async function recheckByName(name) {
    const orderId = await shopifyOrders.findOrderIdByName(name);
    if (!orderId) return { outcome: "ignored", reason: "order_not_found" };
    return reconcileOrder(orderId);
  }

  // A person has checked Shopify and settles a frozen row.
  //   applied: true   the change stands (or, for a refused reversal, is
  //                   written off) - nothing further happens
  //   applied: false  the change didn't happen - undo the claim and try again
  async function settle(orderId, { applied }) {
    if (typeof orderId !== "string" || !ORDER_GID.test(orderId)) {
      throw new TypeError("settle needs a Shopify order ID");
    }
    const before = await db.settleFrozenOrderDeposit(orderId, { keep: applied });
    if (!before) return { outcome: "not_frozen" };
    await db
      .recordStoreCreditLedger({
        shopifyOrderId: orderId,
        customerId: before.customer_id,
        deltaCents: before.pending_delta_cents || 0,
        outcome: applied ? "settled_by_staff_as_applied" : "settled_by_staff_as_not_applied",
        detail: `was ${before.stuck ? "stuck" : before.state}`,
      })
      .catch((err) => logger.error("[store-credit] couldn't write the ledger", { orderId, error: err.message }));
    if (applied) return { outcome: "settled" };
    return reconcileOrder(orderId);
  }

  // The safety net. Asks Shopify for deposit orders that changed recently
  // and reconciles any this app hasn't seen in that state. Never rejects:
  // one bad order must not stop the rest.
  async function sweepRecentOrders({ now = new Date() } = {}) {
    const since = new Date(now.getTime() - SWEEP_WINDOW_HOURS * 60 * 60 * 1000);
    const summary = { checked: 0, changed: 0, failed: 0 };
    let orders;
    try {
      orders = await shopifyOrders.listRecentDepositOrders({ sku, since, soldSince: liveFrom });
    } catch (err) {
      logger.error("[store-credit] sweep couldn't list orders", { error: err.message });
      return { ...summary, failed: 1 };
    }
    for (const candidate of orders) {
      try {
        const row = await db.getOrderDeposit(candidate.id);
        const seen =
          row &&
          row.state === "ok" &&
          row.synced_updated_at &&
          new Date(row.synced_updated_at).getTime() >= new Date(candidate.updatedAt).getTime();
        if (seen) continue;
        summary.checked += 1;
        const result = await reconcileOrder(candidate.id);
        if (result.outcome === "credited" || result.outcome === "reversed") summary.changed += 1;
      } catch (err) {
        summary.failed += 1;
        logger.error("[store-credit] sweep couldn't reconcile an order", { orderId: candidate.id, error: err.message });
      }
    }
    return summary;
  }

  return { sku, liveFrom, reconcileOrder, recheckByName, settle, sweepRecentOrders };
}

module.exports = {
  createStoreCreditService,
  computeTarget,
  depositSkuFromEnv,
  liveFromEnv,
  RetryLater,
  FULLY_PAID,
  SWEEP_WINDOW_HOURS,
  ORDER_GID,
};
