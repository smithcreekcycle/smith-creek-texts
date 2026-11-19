const Stripe = require("stripe");

const APP_BASE_URL = process.env.APP_BASE_URL || "https://smith-creek-texts.onrender.com";

function getClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

// Creates a one-off Stripe Checkout Session for a text-a-payment-link deposit.
// amountCents is an integer number of cents (e.g. 5000 = $50.00).
async function createDepositCheckout({ phone, amountCents, note }) {
  const stripe = getClient();
  if (!stripe) {
    throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing)");
  }

const productName = note ? `Deposit - ${note}` : "Deposit";

const session = await stripe.checkout.sessions.create({
  mode: "payment",
  payment_method_types: ["card"],
  line_items: [
    {
      price_data: {
        currency: "cad",
        product_data: { name: productName },
        unit_amount: amountCents,
      },
      quantity: 1,
    },
    ],
  metadata: {
    phone: phone || "",
    note: note || "",
  },
  success_url: `${APP_BASE_URL}/payments/success`,
  cancel_url: `${APP_BASE_URL}/payments/cancelled`,
});

return session;
}

module.exports = { getClient, createDepositCheckout };
