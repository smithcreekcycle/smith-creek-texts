// Tests for src/security.js. These run with Node's built-in test runner
// (`npm test`), so no extra test framework is needed.
//
// The Twilio signature test deliberately computes the expected signature by
// hand, following Twilio's own published algorithm
// (https://www.twilio.com/docs/usage/webhooks/webhooks-security), instead of
// calling into the twilio package to produce it. That way this test can
// actually catch a mistake in our verification code - if it just asked the
// twilio package to sign and then checked that the same package's own
// validator accepted it, a bug shared by both sides would pass silently.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const security = require("../src/security");

function computeTwilioSignature(authToken, url, params) {
    const sortedKeys = Object.keys(params).sort();
    let data = url;
    for (const key of sortedKeys) {
          data += key + params[key];
    }
    return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

function fakeReqRes({ authToken, url, params, signature }) {
    const parsed = new URL(url);
    let statusCode = null;
    const req = {
          protocol: parsed.protocol.replace(":", ""),
          get: (header) => (header.toLowerCase() === "host" ? parsed.host : undefined),
          originalUrl: parsed.pathname + parsed.search,
          headers: { "x-twilio-signature": signature },
          body: params,
          path: parsed.pathname,
          ip: "203.0.113.5",
    };
    const res = {
          sendStatus(code) {
                  statusCode = code;
                  return res;
          },
    };
    let nextCalled = false;
    const next = () => {
          nextCalled = true;
    };
    const originalAuthToken = process.env.TWILIO_AUTH_TOKEN;
    process.env.TWILIO_AUTH_TOKEN = authToken;
    security.requireTwilioSignature(req, res, next);
    process.env.TWILIO_AUTH_TOKEN = originalAuthToken;
    return { statusCode, nextCalled };
}

test("requireTwilioSignature accepts a correctly signed request", () => {
    const authToken = "test-auth-token";
    const url = "https://smith-creek-texts.onrender.com/webhooks/twilio-sms";
    const params = { From: "+12505551234", Body: "Hi there", MessageSid: "SM123" };
    const signature = computeTwilioSignature(authToken, url, params);

       const { statusCode, nextCalled } = fakeReqRes({ authToken, url, params, signature });

       assert.equal(nextCalled, true, "a validly signed request should reach the route handler");
    assert.equal(statusCode, null, "a valid request should not be short-circuited with an error status");
});

test("requireTwilioSignature rejects a tampered body", () => {
    const authToken = "test-auth-token";
    const url = "https://smith-creek-texts.onrender.com/webhooks/twilio-sms";
    const signedParams = { From: "+12505551234", Body: "Hi there", MessageSid: "SM123" };
    const signature = computeTwilioSignature(authToken, url, signedParams);

       // Same signature, but the body was changed after signing - this is
       // exactly what an attacker replaying/forging a request would produce.
       const tamperedParams = { ...signedParams, Body: "Send me your SSN" };

       const { statusCode, nextCalled } = fakeReqRes({
             authToken,
             url,
             params: tamperedParams,
             signature,
       });

       assert.equal(nextCalled, false, "a tampered request must never reach the route handler");
    assert.equal(statusCode, 403);
});

test("requireTwilioSignature rejects a missing signature header", () => {
    const authToken = "test-auth-token";
    const url = "https://smith-creek-texts.onrender.com/webhooks/twilio-sms";
    const params = { From: "+12505551234", Body: "Hi there", MessageSid: "SM123" };

       const { statusCode, nextCalled } = fakeReqRes({ authToken, url, params, signature: undefined });

       assert.equal(nextCalled, false);
    assert.equal(statusCode, 403);
});

test("requireTwilioSignature fails closed when TWILIO_AUTH_TOKEN is not configured", () => {
    const url = "https://smith-creek-texts.onrender.com/webhooks/twilio-sms";
    const params = { From: "+12505551234", Body: "Hi there", MessageSid: "SM123" };
    const signature = computeTwilioSignature("whatever", url, params);

       const { statusCode, nextCalled } = fakeReqRes({ authToken: "", url, params, signature });

       assert.equal(nextCalled, false, "with no auth token configured, nothing can be verified, so nothing is trusted");
    assert.equal(statusCode, 403);
});

// ---- csrfToken / verifyCsrf -------------------------------------------------

function fakeCsrfReqRes({ session, body }) {
    const req = { session, body, path: "/payments/send", ip: "203.0.113.5" };
    let statusCode = null;
    const res = {
          status(code) {
                  statusCode = code;
                  return res;
          },
          type() {
                  return res;
          },
          send() {
                  return res;
          },
    };
    let nextCalled = false;
    const next = () => {
          nextCalled = true;
    };
    security.verifyCsrf(req, res, next);
    return { statusCode, nextCalled };
}

test("csrfToken generates a token once and reuses it on later calls", () => {
    const session = {};
    const first = security.csrfToken({ session });
    const second = security.csrfToken({ session });

       assert.equal(typeof first, "string");
    assert.ok(first.length >= 32, "token should be long enough to resist guessing");
    assert.equal(first, second, "the same session should keep the same token rather than rotating it every request");
});

test("verifyCsrf accepts a request whose body token matches the session token", () => {
    const session = { csrfToken: "a".repeat(64) };
    const { statusCode, nextCalled } = fakeCsrfReqRes({ session, body: { _csrf: session.csrfToken } });

       assert.equal(nextCalled, true);
    assert.equal(statusCode, null);
});

test("verifyCsrf rejects a missing token", () => {
    const session = { csrfToken: "a".repeat(64) };
    const { statusCode, nextCalled } = fakeCsrfReqRes({ session, body: {} });

       assert.equal(nextCalled, false);
    assert.equal(statusCode, 403);
});

test("verifyCsrf rejects a token that doesn't match the session's", () => {
    const session = { csrfToken: "a".repeat(64) };
    const { statusCode, nextCalled } = fakeCsrfReqRes({ session, body: { _csrf: "b".repeat(64) } });

       assert.equal(nextCalled, false);
    assert.equal(statusCode, 403);
});

test("verifyCsrf rejects when there is no session token to check against", () => {
    const { statusCode, nextCalled } = fakeCsrfReqRes({ session: {}, body: { _csrf: "a".repeat(64) } });

       assert.equal(nextCalled, false);
    assert.equal(statusCode, 403);
});
