// Passwordless staff login: request a link, open it, confirm, logged in.
// Geo-restricted, but (obviously) not behind requireAuth.

const express = require("express");
const asyncHandler = require("./asyncHandler");
const auth = require("../auth");
const security = require("../security");
const views = require("../views");

// Login tokens are 32 random bytes, hex-encoded (auth.js).
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function createLoginRouter() {
  const router = express.Router();

  function loginPage(options) {
    return views.loginPage({
      email: auth.ALLOWED_LOGIN_EMAIL,
      tokenTtlMinutes: auth.TOKEN_TTL_MINUTES,
      ...options,
    });
  }

  router.get("/login", auth.requireCanada, (req, res) => {
    res.type("html").send(
      loginPage({
        sent: req.query.sent === "1",
        error: req.query.error === "1" ? "send_failed" : null,
      }),
    );
  });

  router.post(
    "/login",
    auth.requireCanada,
    security.loginRequestLimiter,
    asyncHandler(async (req, res) => {
      try {
        await auth.requestLoginLink(req.body && req.body.email);
        res.redirect("/login?sent=1");
      } catch (err) {
        // The real reason stays server-side - someone who isn't logged in
        // never needs to see internals like an SMTP hostname.
        console.error("Failed to send login link", err.message);
        res.redirect("/login?error=1");
      }
    }),
  );

  // Opening the emailed link does NOT log anyone in or use the token up; it
  // only shows a "Finish logging in" button. Mail security scanners (Outlook
  // Safe Links and friends) open every link in an email before the person
  // does. If a plain GET consumed the single-use token, the scanner would
  // burn it and the real click would land on "expired".
  router.get("/login/verify", auth.requireCanada, security.loginVerifyLimiter, (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!TOKEN_PATTERN.test(token)) {
      return res
        .status(400)
        .type("html")
        .send(loginPage({ error: "expired" }));
    }
    res.type("html").send(views.loginConfirmPage({ token }));
  });

  router.post(
    "/login/verify",
    auth.requireCanada,
    security.loginVerifyLimiter,
    asyncHandler(async (req, res) => {
      const token = req.body && typeof req.body.token === "string" ? req.body.token : "";
      const email = TOKEN_PATTERN.test(token) ? await auth.verifyToken(token) : null;
      if (!email) {
        return res
          .status(400)
          .type("html")
          .send(loginPage({ error: "expired" }));
      }
      // Prevent session fixation: issue a brand new session id on login, so
      // a session id captured before authentication is useless afterward.
      req.session.regenerate((err) => {
        if (err) {
          console.error("Failed to regenerate session on login", err.message);
          return res
            .status(500)
            .type("html")
            .send(loginPage({ error: "send_failed" }));
        }
        req.session.authedEmail = email;
        req.session.save((saveErr) => {
          if (saveErr) {
            console.error("Failed to save session on login", saveErr.message);
            return res
              .status(500)
              .type("html")
              .send(loginPage({ error: "send_failed" }));
          }
          res.redirect("/");
        });
      });
    }),
  );

  router.post("/logout", security.verifyCsrf, (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
  });

  return router;
}

module.exports = createLoginRouter;
