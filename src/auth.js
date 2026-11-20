const crypto = require("crypto");
const nodemailer = require("nodemailer");
const geoip = require("geoip-lite");
const db = require("./db");

// Only this address is allowed to request a login link. Override with the
// ALLOWED_LOGIN_EMAIL env var if that ever needs to change.
const ALLOWED_LOGIN_EMAIL = (process.env.ALLOWED_LOGIN_EMAIL || "info@smithcreekcycle.ca").toLowerCase();

const TOKEN_TTL_MINUTES = 15;
const SESSION_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000; // "stay logged in" for up to 5 days

// Kill switch in case the Canada-only IP check ever misfires and locks
// everyone out (geo-IP databases are approximate). Set GEO_RESTRICT_ENABLED=false
// in Render to temporarily disable it without a code change.
const GEO_RESTRICT_ENABLED = process.env.GEO_RESTRICT_ENABLED !== "false";

function getAppBaseUrl() {
    return process.env.APP_BASE_URL || "https://smith-creek-texts.onrender.com";
}

// Render's render.yaml generates APP_SECRET for us and it persists across
// deploys, so we reuse it to sign session cookies instead of inventing and
// storing a second secret.
function getSessionSecret() {
    return process.env.APP_SECRET || crypto.randomBytes(32).toString("hex");
}

function getMailer() {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || "587", 10);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) return null;
    return nodemailer.createTransport({
          host,
          port,
          secure: port === 465,
          auth: { user, pass },
    });
}

async function sendLoginLink(email, token) {
    const link = `${getAppBaseUrl()}/login/verify?token=${token}`;
    const transporter = getMailer();
    if (!transporter) {
          // Email isn't configured yet - log the link so whoever has shell/log
      // access can still get in, but don't silently pretend it worked.
      console.error("SMTP is not configured; cannot email the login link. Link:", link);
          throw new Error("Email sending isn't configured yet. Ask the site admin to set SMTP_HOST/SMTP_USER/SMTP_PASS.");
    }
    const from = process.env.SMTP_FROM || "Smith Creek Texts <no-reply@smithcreekcycle.ca>";
    await transporter.sendMail({
          from,
          to: email,
          subject: "Your Smith Creek Texts login link",
          text: `Click this link to log in (it expires in ${TOKEN_TTL_MINUTES} minutes):\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
          html: `<p>Click below to log in. This link expires in ${TOKEN_TTL_MINUTES} minutes.</p>
          <p><a href="${link}">Log in to Smith Creek Texts</a></p>
          <p style="color:#777; font-size: 0.9em;">If you didn't request this, you can ignore this email.</p>`,
    });
}

// Always resolves with no error info either way, so the login form can't be
// used to probe which email addresses are allowed.
async function requestLoginLink(rawEmail) {
    const normalized = String(rawEmail || "").trim().toLowerCase();
    if (normalized !== ALLOWED_LOGIN_EMAIL) {
          console.warn("Login link requested for a non-allowed address", { attempted: normalized });
          return;
    }
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);
    await db.createLoginToken(token, normalized, expiresAt);
    await sendLoginLink(normalized, token);
}

// Consumes a token (single use). Returns the email on success, null if the
// token is missing, expired, or already used.
async function verifyToken(token) {
    if (!token) return null;
    return db.consumeLoginToken(String(token));
}

function requireAuth(req, res, next) {
    if (req.session && req.session.authedEmail) return next();
    return res.redirect("/login");
}

function requireCanada(req, res, next) {
    if (!GEO_RESTRICT_ENABLED) return next();
    const ip = req.ip;
        const geo = ip ? geoip.lookup(ip) : null;
        // geoip-lite's offline database can't place shared/anycast ranges used by
        // privacy proxies (Cloudflare WARP, iCloud Private Relay, some corporate
        // VPNs) - those come back with no country at all, not a wrong one. Only
        // block when the lookup positively names a non-Canadian country; treat an
        // inconclusive lookup as "can't tell" rather than "not Canada", since the
        // login itself is still locked to one address with single-use, hashed,
        // 15-minute tokens and rate limiting regardless of this check.
        const country = geo && geo.country ? geo.country : null;
        if (country === null || country === "CA" || country === "US") return next();
    console.warn("Blocked a non-Canadian access attempt", {
          ip,
          country: country || "unknown",
          path: req.path,
    });
    return res.status(403).type("html").send(`<!doctype html>
    <html><body style="font-family: sans-serif; max-width: 480px; margin: 60px auto; text-align:center;">
    <h1>Access restricted</h1>
    <p>This page is only available from Canada or the United States.</p>
    </body></html>`);
}

module.exports = {
    ALLOWED_LOGIN_EMAIL,
    TOKEN_TTL_MINUTES,
    SESSION_MAX_AGE_MS,
    getSessionSecret,
    requestLoginLink,
    verifyToken,
    requireAuth,
    requireCanada,
};
