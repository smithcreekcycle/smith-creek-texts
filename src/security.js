// Security middleware and helpers shared across server.js.
//
// This file is deliberately boring: every function here does one
// well-understood thing (verify a signature, cap a rate, set a header) so a
// reviewer can audit the whole security posture of the app in one place.

const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const twilio = require("twilio");

// ---- HTTP security headers -------------------------------------------------
//
// helmet's defaults already cover the important cases for a server-rendered
// app with no third-party scripts: a same-origin Content-Security-Policy,
// X-Content-Type-Options: nosniff, X-Frame-Options: SAMEORIGIN, and
// Strict-Transport-Security (the app is HTTPS-only on Render). We only
// override frameguard to be explicit, since this app is never meant to be
// embedded in an iframe anywhere.
function securityHeaders() {
    return helmet({
          frameguard: { action: "deny" },
    });
}

// ---- Rate limiting ----------------------------------------------------------
//
// Defense in depth, not the primary control. The login flow's real
// protection is the single allowed address plus short-lived, single-use,
// 256-bit tokens (see auth.js); these limiters exist to blunt scripted abuse
// and keep one misbehaving client from drowning out logs or the mail
// provider.

// A handful of login attempts per IP every 15 minutes is generous for a
// legitimate user (who needs at most one) and annoying for a script.
const loginRequestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many login attempts from this address. Try again in a few minutes.",
});

// Verifying a token is naturally rarer than requesting one, but allow a bit
// more headroom since email prefetching/scanning by some mail clients can
// generate an extra hit or two on the same link.
const loginVerifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many attempts. Try again in a few minutes.",
});

// Staff-only routes still get a light limiter - nobody on the team should
// ever hit this ceiling, but it stops a stuck browser tab or buggy script
// from hammering Stripe/Twilio/Shopify on our behalf.
const staffActionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests. Please slow down.",
});

// A generous backstop for every other route (including the Twilio/Stripe
// webhooks, which are additionally protected by signature verification
// below). This is about surviving a flood, not distinguishing good traffic
// from bad.
const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
});

// ---- Twilio webhook signature verification ---------------------------------
//
// Twilio signs every webhook request with HMAC-SHA1 over the full URL plus
// the sorted POST params, keyed by the account's auth token (see
// https://www.twilio.com/docs/usage/webhooks/webhooks-security). Without
// this check, anyone who finds these URLs could post fake incoming
// messages, fake call recordings, or fake status callbacks. express.raw/
// urlencoded already parsed req.body by the time this runs, which is fine -
// validateRequest wants the parsed params, not the raw bytes.
function requireTwilioSignature(req, res, next) {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
          // Fail closed: an unconfigured auth token means we cannot verify
      // anything, so treat every request as untrusted rather than accepting
      // it by default.
      console.error("TWILIO_AUTH_TOKEN is not set; rejecting webhook request for safety", {
              path: req.path,
      });
          return res.sendStatus(403);
    }

  const signature = req.headers["x-twilio-signature"];
    const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    const valid = signature && twilio.validateRequest(authToken, signature, url, req.body || {});

  if (!valid) {
        console.warn("Rejected a webhook request with a missing or invalid Twilio signature", {
                path: req.path,
                ip: req.ip,
        });
        return res.sendStatus(403);
  }

  next();
}

module.exports = {
    securityHeaders,
    loginRequestLimiter,
    loginVerifyLimiter,
    staffActionLimiter,
    globalLimiter,
    requireTwilioSignature,
};
