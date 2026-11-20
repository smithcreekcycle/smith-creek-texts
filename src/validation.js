// Input validation for every route that accepts data from a browser form.
//
// None of this replaces parameterized SQL (db.js already does that
// correctly everywhere) - it exists so malformed or hostile input is
// rejected with a clear message before it reaches Stripe, Twilio, or
// Shopify, instead of causing a confusing downstream failure or an
// unintended API call.

const { z } = require("zod");

// Loose but real E.164-ish check: optional leading +, 7-15 digits. Good
// enough to catch "whoops, typo" and "<script>" without rejecting a real
// international number.
const phoneSchema = z
  .string()
  .trim()
  .min(1, "A phone number is required")
  .regex(/^\+?[0-9]{7,15}$/, "Enter a phone number like +12505551234");

const sendPaymentLinkSchema = z.object({
    phone: phoneSchema,
    amount: z.coerce
      .number({ invalid_type_error: "Enter an amount in dollars" })
      .min(0.5, "The minimum amount is $0.50")
      .max(10000, "For amounts over $10,000, take the payment another way and double-check it manually"),
    note: z
      .string()
      .trim()
      .max(200, "Keep the note under 200 characters")
      .optional()
      .transform((v) => v || ""),
});

// Runs a zod schema against req.body and returns either { data } or
// { error } with a single human-readable message - callers don't need to
// know anything about zod's own error shape.
function validate(schema, input) {
    const result = schema.safeParse(input);
    if (result.success) {
          return { data: result.data };
    }
    const message = result.error.issues[0] ? result.error.issues[0].message : "Invalid input";
    return { error: message };
}

module.exports = { sendPaymentLinkSchema, validate };
