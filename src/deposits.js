// The deposit workflow: text a customer a payment link, and turn a confirmed
// payment into a deposit on their account. This is the only place those
// decisions are made - routes just translate HTTP to and from these functions.
//
// "On their account" means two things, in order:
//   1. a paid Shopify order for the deposit item, so it's in their order
//      history exactly like a deposit taken in store, and
//   2. store credit for the same amount, which is what they actually spend
//      at pickup. Step 2 belongs to storeCredit.js; this module just asks.
//
// Everything this module touches (database, payment processor, Shopify,
// Twilio) is passed in, so the money logic can be tested with fakes and has
// no idea what a web request is.

// A re-send of the same amount to the same number inside this window is
// treated as an accident (double-click, back button, impatient retry) until
// staff say otherwise.
const DUPLICATE_WINDOW_SECONDS = 120;

const { formatDollars } = require("./money");

// An error whose message was written for staff and is safe to show them.
class DepositError extends Error {
  constructor(message) {
    super(message);
    this.name = "DepositError";
    this.expose = true;
  }
}

function createDepositService({ db, payments, shopifyOrders, storeCredit, sms, logger = console }) {
  // A lookup that only reads (or harmlessly creates) on the Shopify side.
  // If Shopify is briefly unreachable, let the error out so the processor
  // redelivers the webhook; if Shopify flatly refuses (a permission this
  // app doesn't have), carry on without the answer - the deposit can still
  // be recorded and a person can finish the rest.
  async function optionalLookup(what, fn) {
    try {
      return await fn();
    } catch (err) {
      if (err && err.retryable) throw err;
      logger.error(`[deposits] ${what} lookup refused; continuing without it`, { error: err && err.message });
      return null;
    }
  }

  // Records the paid deposit in Shopify as an order for the deposit item.
  // Returns the Shopify order.
  function createShopifyDepositOrder({ customerId, amountCents, note, provider, providerReference }) {
    return shopifyOrders.createDepositOrder({
      customerId,
      amountCents,
      note,
      depositSku: storeCredit.sku,
      provider,
      providerReference,
    });
  }

  // The order exists; now the credit. Whatever happens here, the Shopify
  // webhook for the new order and the sweep will both try again, so a
  // failure is logged, not fatal.
  async function issueStoreCredit(orderId) {
    try {
      const result = await storeCredit.reconcileOrder(orderId);
      return result.outcome;
    } catch (err) {
      logger.warn("[deposits] store credit not issued yet; it will be retried", { orderId, error: err.message });
      return "pending";
    }
  }

  // Sends currently mid-flight in this process, keyed by phone+amount. The
  // database check below can't see a request that hasn't inserted its row
  // yet; this closes that gap for two clicks landing at the same moment.
  const inFlight = new Set();

  // Creates the invoice, records it, and texts the link.
  // Resolves to one of:
  //   { outcome: "sent", url }
  //   { outcome: "duplicate", previousAt }   nothing was created or sent
  //   { outcome: "in_progress" }             an identical send is mid-flight
  //   { outcome: "sms_failed", url, reason } invoice exists, text didn't go
  // Rejects if no usable link could be created at all.
  async function sendPaymentLink({ phone, amountCents, note, allowDuplicate = false }) {
    const key = `${phone}:${amountCents}`;
    if (inFlight.has(key)) return { outcome: "in_progress" };
    inFlight.add(key);
    try {
      if (!allowDuplicate) {
        const recent = await db.findRecentHelcimDeposit({
          phone,
          amountCents,
          withinSeconds: DUPLICATE_WINDOW_SECONDS,
        });
        if (recent) return { outcome: "duplicate", previousAt: recent.created_at };
      }

      const invoice = await payments.createDepositInvoice({ phone, amountCents, note });

      // If a tax or fee setting on the processor's side changed the total,
      // the customer would be asked for a different amount than staff typed.
      // Don't text that.
      if (invoice.amountCents != null && invoice.amountCents !== amountCents) {
        logger.error("[deposits] invoice total differs from requested amount; link not sent", {
          invoiceNumber: invoice.invoiceNumber,
          requestedCents: amountCents,
          invoiceCents: invoice.amountCents,
        });
        throw new DepositError(
          `The payment processor created invoice ${invoice.invoiceNumber} for ${formatDollars(invoice.amountCents)} instead of ${formatDollars(amountCents)} (a tax or fee setting on that account, most likely). Nothing was texted. Cancel that invoice in the processor's dashboard.`,
        );
      }

      try {
        await db.recordHelcimDepositCreated({
          helcimInvoiceNumber: invoice.invoiceNumber,
          helcimToken: invoice.token,
          phone,
          amountCents,
          currency: "CAD",
          note: note || "",
        });
      } catch (err) {
        // Without this row a payment could never be matched back, so the
        // link must not go out.
        logger.error("[deposits] could not record deposit; link not sent", {
          invoiceNumber: invoice.invoiceNumber,
          error: err.message,
        });
        throw new DepositError(
          `Invoice ${invoice.invoiceNumber} was created but couldn't be saved here, so nothing was texted. Cancel that invoice in the processor's dashboard and try again.`,
        );
      }

      try {
        await sms.sendSms(
          phone,
          `Smith Creek Cycle: here's your secure payment link${note ? ` for ${note}` : ""}: ${invoice.url}`,
        );
      } catch (err) {
        logger.error("[deposits] invoice created but text failed", {
          invoiceNumber: invoice.invoiceNumber,
          error: err.message,
        });
        return { outcome: "sms_failed", url: invoice.url, reason: err.message };
      }
      return { outcome: "sent", url: invoice.url };
    } finally {
      inFlight.delete(key);
    }
  }

  // Called for every card-transaction webhook on the account. Works out
  // whether it's a payment for one of our deposits and, if it is and the
  // invoice is now fully paid, puts the deposit on the customer's account -
  // exactly once.
  //
  // Resolves to { outcome, ... } when the question is settled (including
  // "not ours"). Rejects only when something transient got in the way and
  // the processor should deliver the webhook again later.
  async function handleCardTransaction(transactionId) {
    let txn;
    try {
      txn = await payments.getCardTransaction(transactionId);
    } catch (err) {
      if (err && err.retryable === false) {
        return { outcome: "ignored", reason: "transaction_lookup_rejected" };
      }
      throw err;
    }

    if (txn.status !== "APPROVED" || txn.type !== "purchase") {
      return { outcome: "ignored", reason: "not_an_approved_purchase" };
    }
    if (!txn.invoiceNumber) {
      return { outcome: "ignored", reason: "no_invoice_on_transaction" };
    }

    // Most transactions on the account (in-store terminal sales, other
    // invoices) have nothing to do with this app. That's normal, not an error.
    const deposit = await db.getDepositByInvoiceNumber(txn.invoiceNumber);
    if (!deposit) {
      return { outcome: "ignored", reason: "not_a_text_payment_link" };
    }
    const invoiceNumber = deposit.helcim_invoice_number;
    if (deposit.status !== "pending") {
      return { outcome: "ignored", reason: "already_processed", invoiceNumber };
    }

    // The invoice is the authority on "fully paid": the processor flips it to
    // PAID only once the whole amount has come in, and leaves it DUE after a
    // partial payment.
    const invoice = await payments.getInvoiceByNumber(invoiceNumber);
    if (!invoice || invoice.status !== "PAID") {
      const coversDeposit = txn.amountCents != null && txn.amountCents >= deposit.amount_cents;
      if (!invoice || coversDeposit) {
        // Approved for the full amount but the invoice hasn't caught up (or
        // couldn't be found): ask for a redelivery rather than guess.
        const err = new Error(`Invoice ${invoiceNumber} is not marked paid yet`);
        err.retryable = true;
        throw err;
      }
      logger.warn("[deposits] partial payment received; deposit left pending", {
        invoiceNumber,
        paidCents: txn.amountCents,
        expectedCents: deposit.amount_cents,
      });
      return { outcome: "partial", invoiceNumber };
    }

    // Store credit needs a customer to belong to. Find (or create) one
    // before the point of no return below, while a Shopify hiccup can still
    // be answered with "send that webhook again".
    const customer = await optionalLookup("customer", () => shopifyOrders.findOrCreateCustomerByPhone(deposit.phone));

    const amountCents = deposit.amount_cents;
    const currency = deposit.currency || "CAD";
    const wasNewlyPaid = await db.markDepositPaidByInvoiceNumber(invoiceNumber, { amountCents, currency });
    if (!wasNewlyPaid) {
      return { outcome: "ignored", reason: "already_processed", invoiceNumber };
    }

    // Paid, but not for the amount we asked for (or not in CAD): the money
    // is real, so the deposit shows as paid, but a person should look before
    // anything is written to Shopify.
    if (
      (invoice.amountCents != null && invoice.amountCents !== amountCents) ||
      (invoice.currency && invoice.currency !== currency)
    ) {
      await db.recordHelcimDepositOrderError(
        invoiceNumber,
        `Paid, but the invoice total (${invoice.amountCents == null ? "unknown" : formatDollars(invoice.amountCents)} ${invoice.currency}) doesn't match the ${formatDollars(amountCents)} ${currency} requested. Check the processor's dashboard, then add the right amount of store credit to the customer in Shopify by hand.`,
      );
      logger.error("[deposits] paid invoice total doesn't match deposit", { invoiceNumber });
      return { outcome: "paid_needs_review", invoiceNumber };
    }

    let order;
    try {
      order = await createShopifyDepositOrder({
        customerId: customer ? customer.id : null,
        amountCents,
        note: deposit.note || "",
        provider: "Helcim",
        providerReference: invoiceNumber,
      });
      await db.recordHelcimDepositOrder(invoiceNumber, {
        shopifyOrderId: order.id,
        shopifyOrderName: order.name,
      });
    } catch (err) {
      // Not retried automatically: the order may have been created before
      // the failure, and a blind retry could create a second one. The
      // payments page shows it as needing manual entry.
      logger.error("[deposits] paid, but Shopify order creation failed", { invoiceNumber, error: err.message });
      await db.recordHelcimDepositOrderError(invoiceNumber, err.message);
      return { outcome: "paid_order_failed", invoiceNumber };
    }

    const storeCreditOutcome = await issueStoreCredit(order.id);
    return { outcome: "paid", invoiceNumber, shopifyOrderName: order.name, storeCredit: storeCreditOutcome };
  }

  // DORMANT BACKUP: the Stripe Checkout completion handler, kept so Stripe
  // can be switched back on without rewriting anything. It records deposits
  // the same way the live path does.
  // Nothing in the live flow creates Stripe sessions any more.
  async function handleStripeCheckoutCompleted(session) {
    const phone = (session.metadata && session.metadata.phone) || null;
    const note = (session.metadata && session.metadata.note) || "";
    const amountCents = session.amount_total;
    const currency = (session.currency || "cad").toUpperCase();
    // Stripe can deliver the same event more than once. markDepositPaid only
    // flips the status on the first call, so a redelivery is a no-op rather
    // than a second Shopify order.
    const wasNewlyPaid = await db.markDepositPaid(session.id, { amountCents, currency });
    if (!wasNewlyPaid) {
      logger.log("Deposit already marked paid; skipping duplicate order creation", { sessionId: session.id });
      return;
    }
    let order;
    try {
      const customer = phone ? await shopifyOrders.findCustomerByPhone(phone) : null;
      order = await createShopifyDepositOrder({
        customerId: customer ? customer.id : null,
        amountCents,
        note,
        provider: "Stripe",
        providerReference: session.id,
      });
      await db.recordDepositOrder(session.id, {
        shopifyOrderId: order.id,
        shopifyOrderName: order.name,
      });
    } catch (err) {
      logger.error("Failed to create Shopify deposit order", err.message);
      await db.recordDepositOrderError(session.id, err.message);
      return;
    }
    await issueStoreCredit(order.id);
  }

  return { sendPaymentLink, handleCardTransaction, handleStripeCheckoutCompleted };
}

module.exports = { createDepositService, DepositError, DUPLICATE_WINDOW_SECONDS, formatDollars };
