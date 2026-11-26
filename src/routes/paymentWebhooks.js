// Webhooks from payment processors. These must be mounted BEFORE the JSON /
// urlencoded body parsers: signature checks are computed over the exact
// bytes that arrived, so each route here reads the body raw.
//
// Nobody is logged in on these routes. The signature is the authentication.

const express = require("express");
const asyncHandler = require("./asyncHandler");

function createPaymentWebhookRouter({ deposits, payments, stripePayments }) {
  const router = express.Router();

  // The live one. The path is deliberately generic: the processor refuses
  // to deliver to any URL containing its own name.
  //
  // Response codes are chosen for the processor's retry behaviour - it
  // redelivers on anything that isn't 2xx, for over a day:
  //   200  handled, or definitely not ours - don't send it again
  //   4xx  not a request we can authenticate
  //   503  something transient got in the way - please send it again
  router.post(
    "/webhooks/payments",
    // type: () => true reads the body raw whatever Content-Type arrives with it.
    express.raw({ type: () => true, limit: "100kb" }),
    asyncHandler(async (req, res) => {
      const verifierToken = process.env.HELCIM_WEBHOOK_VERIFIER_TOKEN;
      if (!verifierToken) {
        // Fail closed, but retryably: once the token is set, the processor's
        // next redelivery will go through.
        console.error("[webhook] payment webhook received but HELCIM_WEBHOOK_VERIFIER_TOKEN is not set");
        return res.sendStatus(503);
      }

      const check = payments.verifyWebhookSignature({
        headers: req.headers,
        rawBody: req.body,
        verifierToken,
      });
      if (!check.ok) {
        console.warn("[webhook] rejected payment webhook", { reason: check.reason, ip: req.ip });
        return res.sendStatus(401);
      }

      const event = payments.parseWebhookEvent(req.body);
      if (!event) return res.sendStatus(400);
      if (event.type !== "cardTransaction" || !event.id) {
        return res.sendStatus(200);
      }

      try {
        const result = await deposits.handleCardTransaction(event.id);
        if (result.outcome !== "ignored") {
          console.log("[webhook] card transaction processed", { transactionId: event.id, ...result });
        }
        return res.sendStatus(200);
      } catch (err) {
        console.error("[webhook] could not process card transaction yet; asking for redelivery", {
          transactionId: event.id,
          error: err.message,
        });
        return res.sendStatus(503);
      }
    }),
  );

  // DORMANT BACKUP: Stripe's webhook, unchanged. With no STRIPE_SECRET_KEY /
  // STRIPE_WEBHOOK_SECRET set it answers 500 and does nothing.
  router.post(
    "/webhooks/stripe",
    express.raw({ type: "application/json", limit: "1mb" }),
    asyncHandler(async (req, res) => {
      const stripe = stripePayments.getClient();
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!stripe || !webhookSecret) {
        console.error("Stripe webhook received but Stripe is not configured");
        return res.sendStatus(500);
      }
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], webhookSecret);
      } catch (err) {
        console.error("Stripe webhook signature verification failed", err.message);
        return res.sendStatus(400);
      }
      if (event.type === "checkout.session.completed") {
        try {
          await deposits.handleStripeCheckoutCompleted(event.data.object);
        } catch (err) {
          console.error("Failed to handle Stripe checkout completion", err.message);
        }
      }
      res.sendStatus(200);
    }),
  );

  return router;
}

module.exports = createPaymentWebhookRouter;
