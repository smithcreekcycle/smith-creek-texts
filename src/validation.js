// Input validation for every route that accepts data from a browser form.
//
// None of this replaces parameterized SQL (db.js already does that
// everywhere) - it exists so malformed or hostile input is rejected with a
// clear message before it reaches the payment processor, Twilio, or Shopify,
// instead of causing a confusing downstream failure or an unintended API call.

const { z } = require("zod");
const { normalizePhone } = require("./phone");

// Accepts the formats staff actually type and hands back E.164 (see phone.js).
const phoneSchema = z
  .string({
    required_error: "A phone number is required",
    invalid_type_error: "Enter a single phone number",
  })
  .trim()
  .min(1, "A phone number is required")
  .transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter a phone number like 250-555-1234 (add + and the country code if it isn't Canadian/US)",
      });
      return z.NEVER;
    }
    return normalized;
  });

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
    // The note ends up inside a text message and on the customer's invoice,
    // so collapse line breaks/tabs into single spaces.
    .transform((v) => (v || "").replace(/\s+/g, " ")),
});

// A button or the "check an order" box on the payments page. Exactly one of
// order_id (a hidden field this app wrote) or order_name (typed by staff).
const depositActionSchema = z
  .object({
    action: z.enum(["recheck", "applied", "not_applied"], {
      errorMap: () => ({ message: "Unknown action" }),
    }),
    order_id: z
      .string()
      .regex(/^gid:\/\/shopify\/Order\/\d{1,20}$/, "Unknown order")
      .optional(),
    order_name: z
      .string()
      .trim()
      // Shopify order names: "#1234", or a prefix/suffix the shop configured
      // ("LS2951"). Nothing that could change the meaning of a search query.
      .regex(/^#?[A-Za-z0-9-]{1,20}$/, "Enter the order number from Shopify, like #1234")
      // Staff usually type just the digits.
      .transform((name) => (/^\d+$/.test(name) ? `#${name}` : name))
      .optional(),
  })
  .refine((v) => Boolean(v.order_id) !== Boolean(v.order_name), { message: "Choose one order" })
  // Settling a frozen change is only ever done from a row's own buttons.
  .refine((v) => v.action === "recheck" || Boolean(v.order_id), { message: "Unknown order" });

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

module.exports = { sendPaymentLinkSchema, depositActionSchema, validate };
