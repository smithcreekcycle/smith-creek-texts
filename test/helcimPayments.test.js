// Tests for the payment processor client. No network: fetch is replaced with
// a fake for the API tests, and the webhook signatures are computed here from
// the published algorithm (Standard Webhooks) rather than by calling the
// code under test.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const payments = require("../src/helcimPayments");

const VERIFIER_TOKEN = Buffer.from("a-test-webhook-secret-of-some-length").toString("base64");
const NOW = 1_800_000_000;

function sign({ id, timestamp, body, token = VERIFIER_TOKEN }) {
  const signature = crypto
    .createHmac("sha256", Buffer.from(token, "base64"))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return `v1,${signature}`;
}

function webhook(overrides = {}) {
  const id = "msg_2abc";
  const timestamp = String(NOW - 5);
  const body = '{"id":"25764674","type":"cardTransaction"}';
  return {
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": sign({ id, timestamp, body }),
      ...overrides.headers,
    },
    rawBody: Buffer.from(overrides.body == null ? body : overrides.body),
    verifierToken: overrides.verifierToken == null ? VERIFIER_TOKEN : overrides.verifierToken,
    nowSeconds: overrides.nowSeconds == null ? NOW : overrides.nowSeconds,
  };
}

// ---- verifyWebhookSignature ---------------------------------------------------

test("verifyWebhookSignature accepts a correctly signed webhook", () => {
  assert.deepEqual(payments.verifyWebhookSignature(webhook()), { ok: true });
});

test("verifyWebhookSignature accepts when one of several signatures matches", () => {
  const good = webhook();
  good.headers["webhook-signature"] = `v1,${Buffer.alloc(32).toString("base64")} ${good.headers["webhook-signature"]}`;
  assert.deepEqual(payments.verifyWebhookSignature(good), { ok: true });
});

test("verifyWebhookSignature rejects a tampered body", () => {
  const result = payments.verifyWebhookSignature(webhook({ body: '{"id":"99999999","type":"cardTransaction"}' }));
  assert.deepEqual(result, { ok: false, reason: "signature_mismatch" });
});

test("verifyWebhookSignature rejects a signature made with a different secret", () => {
  const other = Buffer.from("some-other-secret").toString("base64");
  const result = payments.verifyWebhookSignature(webhook({ verifierToken: other }));
  assert.deepEqual(result, { ok: false, reason: "signature_mismatch" });
});

test("verifyWebhookSignature rejects a changed id or timestamp (both are signed)", () => {
  assert.equal(payments.verifyWebhookSignature(webhook({ headers: { "webhook-id": "msg_other" } })).ok, false);
  assert.equal(
    payments.verifyWebhookSignature(webhook({ headers: { "webhook-timestamp": String(NOW - 6) } })).ok,
    false,
  );
});

test("verifyWebhookSignature ignores signature schemes other than v1", () => {
  const w = webhook();
  w.headers["webhook-signature"] = w.headers["webhook-signature"].replace(/^v1,/, "v2,");
  assert.deepEqual(payments.verifyWebhookSignature(w), { ok: false, reason: "signature_mismatch" });
});

test("verifyWebhookSignature rejects missing headers, and never throws on junk", () => {
  for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
    const w = webhook();
    delete w.headers[name];
    assert.deepEqual(payments.verifyWebhookSignature(w), { ok: false, reason: "missing_headers" });
  }
  assert.equal(payments.verifyWebhookSignature(webhook({ headers: { "webhook-signature": "garbage" } })).ok, false);
  assert.equal(payments.verifyWebhookSignature(webhook({ headers: { "webhook-signature": "v1," } })).ok, false);
  assert.equal(
    payments.verifyWebhookSignature(webhook({ headers: { "webhook-timestamp": "soon" } })).reason,
    "bad_timestamp",
  );
  assert.equal(
    payments.verifyWebhookSignature({ headers: {}, rawBody: Buffer.alloc(0), verifierToken: VERIFIER_TOKEN }).ok,
    false,
  );
});

test("verifyWebhookSignature fails closed when the body isn't raw bytes or no secret is set", () => {
  const parsed = webhook();
  parsed.rawBody = { id: "25764674", type: "cardTransaction" };
  assert.deepEqual(payments.verifyWebhookSignature(parsed), { ok: false, reason: "no_raw_body" });
  assert.deepEqual(payments.verifyWebhookSignature(webhook({ verifierToken: "" })), {
    ok: false,
    reason: "no_verifier_token",
  });

  // An empty secret must not be usable even by someone who signs with it.
  const id = "msg_x";
  const timestamp = String(NOW);
  const body = "{}";
  const forged = {
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${crypto.createHmac("sha256", Buffer.alloc(0)).update(`${id}.${timestamp}.${body}`).digest("base64")}`,
    },
    rawBody: Buffer.from(body),
    verifierToken: "",
    nowSeconds: NOW,
  };
  assert.deepEqual(payments.verifyWebhookSignature(forged), { ok: false, reason: "no_verifier_token" });
});

test("verifyWebhookSignature allows a day-late retry but not an ancient or future-dated one", () => {
  const lateRetry = webhook({ nowSeconds: NOW + 27 * 60 * 60 });
  assert.deepEqual(payments.verifyWebhookSignature(lateRetry), { ok: true });
  assert.equal(
    payments.verifyWebhookSignature(webhook({ nowSeconds: NOW + 72 * 60 * 60 })).reason,
    "timestamp_out_of_range",
  );
  assert.equal(
    payments.verifyWebhookSignature(webhook({ nowSeconds: NOW - 60 * 60 })).reason,
    "timestamp_out_of_range",
  );
});

test("parseWebhookEvent reads the thin event body and rejects junk", () => {
  assert.deepEqual(payments.parseWebhookEvent(Buffer.from('{"id":"25764674","type":"cardTransaction"}')), {
    type: "cardTransaction",
    id: "25764674",
  });
  assert.deepEqual(payments.parseWebhookEvent(Buffer.from('{"id":25764674,"type":"cardTransaction"}')).id, "25764674");
  assert.equal(payments.parseWebhookEvent(Buffer.from("not json")), null);
  assert.equal(payments.parseWebhookEvent(Buffer.from("null")), null);
  assert.equal(payments.parseWebhookEvent(Buffer.from('{"id":"1"}')), null);
});

// ---- API client -----------------------------------------------------------------

const API_TOKEN = "test-api-token-value";

// Runs fn with a fake fetch, test credentials, and console output captured so
// the test can assert on what would have been logged.
async function withFakeApi(respond, fn) {
  const saved = { fetch: global.fetch, token: process.env.HELCIM_API_TOKEN, sub: process.env.HELCIM_SUBDOMAIN };
  const savedConsole = { log: console.log, error: console.error, warn: console.warn };
  const calls = [];
  const logged = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    const { status = 200, body } = respond(url, options);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  for (const level of ["log", "error", "warn"]) {
    console[level] = (...args) =>
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  }
  process.env.HELCIM_API_TOKEN = API_TOKEN;
  process.env.HELCIM_SUBDOMAIN = "smith-creek-test";
  try {
    return await fn({ calls, logged });
  } finally {
    global.fetch = saved.fetch;
    Object.assign(console, savedConsole);
    for (const [key, value] of [
      ["HELCIM_API_TOKEN", saved.token],
      ["HELCIM_SUBDOMAIN", saved.sub],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("createDepositInvoice sends the amount in dollars and builds the hosted link", async () => {
  await withFakeApi(
    () => ({
      body: {
        invoiceId: 1,
        invoiceNumber: "INV1791",
        token: "4d86fb15661a10181c0eb5",
        status: "DUE",
        amount: 19.99,
        currency: "CAD",
      },
    }),
    async ({ calls, logged }) => {
      const invoice = await payments.createDepositInvoice({
        phone: "+12505551234",
        amountCents: 1999,
        note: "Fuel EX",
      });
      assert.deepEqual(invoice, {
        invoiceNumber: "INV1791",
        token: "4d86fb15661a10181c0eb5",
        amountCents: 1999,
        url: "https://smith-creek-test.myhelcim.com/order/?token=4d86fb15661a10181c0eb5",
      });
      assert.equal(calls[0].url, "https://api.helcim.com/v2/invoices");
      assert.equal(calls[0].options.method, "POST");
      assert.equal(calls[0].options.headers["api-token"], API_TOKEN);
      assert.ok(calls[0].options.signal, "every request must carry a timeout");
      const sent = JSON.parse(calls[0].options.body);
      assert.equal(sent.currency, "CAD");
      assert.deepEqual(sent.lineItems, [
        { sku: "DEPOSIT", description: "Deposit - Fuel EX", quantity: 1, price: 19.99 },
      ]);
      assert.equal(
        logged.join("\n").includes("4d86fb15661a10181c0eb5"),
        false,
        "invoice tokens must stay out of the logs",
      );
    },
  );
});

test("createDepositInvoice refuses a response without a token or invoice number", async () => {
  await withFakeApi(
    () => ({ body: { invoiceId: 1, somethingElse: true } }),
    async () => {
      await assert.rejects(
        payments.createDepositInvoice({ phone: "+12505551234", amountCents: 5000, note: "" }),
        payments.PaymentProviderError,
      );
    },
  );
});

test("API errors never put the response body or the API token in the message or the logs", async () => {
  await withFakeApi(
    () => ({ status: 401, body: { errors: "Unauthorized", echoed: "super-secret-detail" } }),
    async ({ logged }) => {
      await assert.rejects(
        payments.createDepositInvoice({ phone: "+12505551234", amountCents: 5000, note: "" }),
        (err) => {
          assert.equal(err.status, 401);
          assert.equal(err.expose, true);
          assert.equal(err.retryable, true, "a credentials problem can be fixed, so a webhook should be redelivered");
          assert.equal(err.message.includes("super-secret-detail"), false);
          assert.equal(err.message.includes(API_TOKEN), false);
          return true;
        },
      );
      const output = logged.join("\n");
      assert.equal(output.includes(API_TOKEN), false);
      assert.equal(output.includes("super-secret-detail"), false);
    },
  );
});

test("a network failure becomes a retryable, staff-readable error", async () => {
  await withFakeApi(
    () => {
      throw new TypeError("fetch failed");
    },
    async () => {
      await assert.rejects(
        payments.getInvoiceByNumber("INV1"),
        (err) => err instanceof payments.PaymentProviderError && err.retryable === true,
      );
    },
  );
});

test("getCardTransaction normalizes the transaction and only accepts numeric ids", async () => {
  await withFakeApi(
    () => ({
      body: {
        transactionId: 25764674,
        status: "APPROVED",
        type: "purchase",
        amount: 50,
        currency: "CAD",
        invoiceNumber: "INV1791",
      },
    }),
    async ({ calls }) => {
      assert.deepEqual(await payments.getCardTransaction("25764674"), {
        transactionId: "25764674",
        status: "APPROVED",
        type: "purchase",
        amountCents: 5000,
        currency: "CAD",
        invoiceNumber: "INV1791",
      });
      assert.equal(calls[0].url, "https://api.helcim.com/v2/card-transactions/25764674");

      await assert.rejects(payments.getCardTransaction("../invoices"), (err) => err.retryable === false);
      await assert.rejects(payments.getCardTransaction("12?x=1"), (err) => err.retryable === false);
      assert.equal(calls.length, 1, "a malformed id must never reach the API");
    },
  );
});

test("a 404 on lookup is not worth a redelivery", async () => {
  await withFakeApi(
    () => ({ status: 404, body: { errors: ["not found"] } }),
    async () => {
      await assert.rejects(payments.getCardTransaction("123"), (err) => err.retryable === false);
    },
  );
});

test("getInvoiceByNumber returns only the invoice that was asked for", async () => {
  const paidOther = { invoiceNumber: "INV9999", status: "PAID", amount: 900, currency: "CAD" };
  const ours = { invoiceNumber: "INV1791", status: "DUE", amount: 50, currency: "CAD" };

  // If the filter were ever ignored and the API returned other invoices
  // first, a different customer's PAID invoice must not be mistaken for ours.
  await withFakeApi(
    () => ({ body: [paidOther, ours] }),
    async ({ calls }) => {
      assert.deepEqual(await payments.getInvoiceByNumber("inv1791"), {
        invoiceNumber: "INV1791",
        status: "DUE",
        amountCents: 5000,
        currency: "CAD",
      });
      assert.equal(calls[0].url, "https://api.helcim.com/v2/invoices?invoiceNumber=inv1791");
    },
  );
  await withFakeApi(
    () => ({ body: [paidOther] }),
    async () => assert.equal(await payments.getInvoiceByNumber("INV1791"), null),
  );
  await withFakeApi(
    () => ({ body: [] }),
    async () => assert.equal(await payments.getInvoiceByNumber("INV1791"), null),
  );
  await withFakeApi(
    () => ({ body: { data: [ours] } }),
    async () => assert.equal((await payments.getInvoiceByNumber("INV1791")).status, "DUE"),
  );
});

test("the subdomain setting tolerates common paste mistakes and rejects anything unsafe", () => {
  assert.equal(payments.normalizeSubdomain("smith-creek-cycle"), "smith-creek-cycle");
  assert.equal(payments.normalizeSubdomain(" Smith-Creek-Cycle.myhelcim.com "), "smith-creek-cycle");
  assert.equal(payments.normalizeSubdomain("https://smith-creek-cycle.myhelcim.com/order/"), "smith-creek-cycle");
  for (const bad of ["", undefined, "evil.example.com", "a b", "x@y", "-leading", "trailing-", "smith_creek"]) {
    assert.equal(payments.normalizeSubdomain(bad), null, String(bad));
  }
});

test("without credentials the client refuses to run rather than calling the API", async () => {
  await withFakeApi(
    () => ({ body: {} }),
    async ({ calls }) => {
      delete process.env.HELCIM_API_TOKEN;
      await assert.rejects(
        payments.createDepositInvoice({ phone: "+12505551234", amountCents: 5000, note: "" }),
        payments.PaymentProviderError,
      );
      assert.equal(calls.length, 0);
    },
  );
});
