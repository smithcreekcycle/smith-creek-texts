// The two Shopify calls that move store credit. Nothing else in this app
// changes a customer's balance, and nothing calls these except storeCredit.js,
// which decides when and how much.
//
// Requires the write_store_credit_account_transactions scope.

const { adminGraphQL, ShopifyApiError } = require("./shopify");
const { centsToAmount, parseMoneyToCents } = require("./money");

const CURRENCY = "CAD";

function assertPositiveCents(cents) {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new ShopifyApiError("Store credit amount must be a positive whole number of cents", {
      applied: "no",
      retryable: false,
      code: "BAD_AMOUNT",
    });
  }
}

// Shopify reports a refused change in the mutation's own userErrors. That is
// a definite "no": nothing was applied.
function readResult(payload, action) {
  const userErrors = (payload && payload.userErrors) || [];
  if (userErrors.length > 0) {
    const code = userErrors[0].code || "REFUSED";
    throw new ShopifyApiError(`Shopify refused the store credit ${action} (${code})`, {
      applied: "no",
      retryable: false,
      code,
    });
  }
  const txn = payload && payload.storeCreditAccountTransaction;
  if (!txn || !txn.id) {
    // No error and no transaction: can't tell what happened.
    throw new ShopifyApiError(`Shopify's answer to the store credit ${action} was unreadable`, { applied: "unknown" });
  }
  return {
    transactionId: txn.id,
    balanceCents: parseMoneyToCents(txn.balanceAfterTransaction && txn.balanceAfterTransaction.amount),
  };
}

// Adds `cents` to the customer's store credit. No expiry: a deposit is the
// customer's money until it's spent or refunded.
async function credit({ customerId, cents }) {
  assertPositiveCents(cents);
  const data = await adminGraphQL(
    `mutation DepositCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
      storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
        storeCreditAccountTransaction { id balanceAfterTransaction { amount } }
        userErrors { code message }
      }
    }`,
    { id: customerId, creditInput: { creditAmount: { amount: centsToAmount(cents), currencyCode: CURRENCY } } },
  );
  return readResult(data.storeCreditAccountCredit, "credit");
}

// Takes `cents` back off the customer's store credit. Shopify refuses
// (INSUFFICIENT_FUNDS) rather than take a balance below zero.
async function debit({ customerId, cents }) {
  assertPositiveCents(cents);
  const data = await adminGraphQL(
    `mutation DepositDebit($id: ID!, $debitInput: StoreCreditAccountDebitInput!) {
      storeCreditAccountDebit(id: $id, debitInput: $debitInput) {
        storeCreditAccountTransaction { id balanceAfterTransaction { amount } }
        userErrors { code message }
      }
    }`,
    { id: customerId, debitInput: { debitAmount: { amount: centsToAmount(cents), currencyCode: CURRENCY } } },
  );
  return readResult(data.storeCreditAccountDebit, "debit");
}

module.exports = { credit, debit };
