// Tests for everything that talks to Shopify: the API client's error
// handling, the order/customer/store-credit calls, and webhook verification.
// fetch is faked, so nothing leaves the machine.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

process.env.SHOPIFY_STORE_DOMAIN = "test-shop.myshopify.com";
process.env.SHOPIFY_CLIENT_ID = "client-id";
process.env.SHOPIFY_CLIENT_SECRET = "client-secret";

const shopify = require("../src/shopify");
const shopifyOrders = require("../src/shopifyOrders");
const shopifyStoreCredit = require("../src/shopifyStoreCredit");
const shopifyWebhooks = require("../src/shopifyWebhooks");
const { readEvent } = require("../src/routes/shopifyWebhooks");
const { parseMoneyToCents, centsToAmount, formatDollars } = require("../src/money");
const { depositActionSchema, validate } = require("../src/validation");

const quiet = { log() {}, warn() {}, error() {} };

// Runs `fn` with fetch replaced. `graphql(operationName, variables, query)`
// returns the response body for each GraphQL call (or a { status, body }
// object, or throws to simulate a dropped connection).
async function withShopify(graphql, fn) {
  const realFetch = global.fetch;
  const calls = [];
  shopify._resetTokenCache();
  global.fetch = async (url, options) => {
    const u = new URL(url);
    assert.equal(u.host, "test-shop.myshopify.com");
    if (u.pathname === "/admin/oauth/access_token") {
      return { ok: true, status: 200, json: async () => ({ access_token: "shpat_test", expires_in: 86399 }) };
    }
    assert.equal(options.headers["X-Shopify-Access-Token"], "shpat_test");
    assert.ok(options.signal, "every request carries a timeout");
    const { query, variables } = JSON.parse(options.body);
    const name = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)[1];
    calls.push({ name, variables, query });
    const answer = await graphql(name, variables, query);
    const status = answer && answer.status ? answer.status : 200;
    const body = answer && answer.status ? answer.body : answer;
    return { ok: status < 300, status, json: async () => body };
  };
  try {
    return await fn({ calls });
  } finally {
    global.fetch = realFetch;
  }
}

// ---- money ---------------------------------------------------------------------

test("money: Shopify's decimal strings become exact cents", () => {
  for (const [input, cents] of [
    ["300.00", 30000],
    ["1575.0", 157500],
    ["12", 1200],
    ["0.5", 50],
    ["19.99", 1999],
    ["0.07", 7],
    ["10.10", 1010],
    ["4.350", 435],
  ]) {
    assert.equal(parseMoneyToCents(input), cents, input);
  }
});

test("money: anything that isn't a plain amount is refused rather than rounded", () => {
  for (const bad of [
    "",
    " ",
    "-5.00",
    "1e3",
    "12.345",
    "1,200.00",
    "$5",
    "abc",
    null,
    undefined,
    {},
    [],
    "12.",
    ".5",
    "NaN",
  ]) {
    assert.equal(parseMoneyToCents(bad), null, String(bad));
  }
});

test("money: cents are written back with exactly two decimals, no float drift", () => {
  assert.equal(centsToAmount(30000), "300.00");
  assert.equal(centsToAmount(1999), "19.99");
  assert.equal(centsToAmount(7), "0.07");
  assert.equal(centsToAmount(0), "0.00");
  assert.equal(formatDollars(-10000), "$100.00");
  for (const bad of [-1, 1.5, NaN, "100", Infinity]) assert.throws(() => centsToAmount(bad), TypeError);
});

// ---- the API client ----------------------------------------------------------------

test("client: a dropped connection or a 5xx leaves the outcome unknown", async () => {
  await withShopify(
    () => {
      throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
    },
    async () => {
      await assert.rejects(shopify.adminGraphQL("query Q { shop { name } }"), (err) => {
        assert.equal(err.name, "ShopifyApiError");
        assert.equal(err.applied, "unknown");
        assert.equal(err.retryable, true);
        return true;
      });
    },
  );
  await withShopify(
    () => ({ status: 502, body: {} }),
    async () => {
      await assert.rejects(shopify.adminGraphQL("query Q { shop { name } }"), (err) => err.applied === "unknown");
    },
  );
});

test("client: a 4xx or a refusal before execution means definitely not applied", async () => {
  for (const [answer, retryable] of [
    [{ status: 403, body: {} }, false],
    [{ status: 429, body: {} }, true],
    [{ data: { x: null }, errors: [{ message: "denied", extensions: { code: "ACCESS_DENIED" } }] }, false],
    [{ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }, true],
    [{ errors: [{ message: "Field 'nope' doesn't exist", extensions: { code: "undefinedField" } }] }, false],
  ]) {
    await withShopify(
      () => answer,
      async () => {
        await assert.rejects(shopify.adminGraphQL("mutation M { x }"), (err) => {
          assert.equal(err.applied, "no", JSON.stringify(answer));
          assert.equal(err.retryable, retryable, JSON.stringify(answer));
          return true;
        });
      },
    );
  }
});

test("client: a server fault reported inside a 200 is treated as unknown", async () => {
  for (const answer of [
    { errors: [{ message: "Internal error", extensions: { code: "INTERNAL_SERVER_ERROR" } }] },
    { data: { x: null }, errors: [{ message: "something" }] },
    { nothing: true },
  ]) {
    await withShopify(
      () => answer,
      async () => {
        await assert.rejects(shopify.adminGraphQL("mutation M { x }"), (err) => err.applied === "unknown");
      },
    );
  }
});

test("client: error messages never carry response bodies or tokens", async () => {
  await withShopify(
    () => ({ status: 500, body: { secret: "shpat_test", detail: "client-secret" } }),
    async () => {
      await assert.rejects(shopify.adminGraphQL("query Q { shop { name } }"), (err) => {
        assert.doesNotMatch(err.message, /shpat|client-secret/);
        return true;
      });
    },
  );
});

// ---- orders and customers ----------------------------------------------------------

const RAW_ORDER = {
  id: "gid://shopify/Order/5",
  name: "#1005",
  test: false,
  cancelledAt: null,
  processedAt: "2026-11-26T17:59:00Z",
  updatedAt: "2026-11-26T18:00:00Z",
  currencyCode: "CAD",
  displayFinancialStatus: "PAID",
  note: null,
  customer: { id: "gid://shopify/Customer/7" },
  netPaymentSet: { shopMoney: { amount: "251.2", currencyCode: "CAD" } },
  lineItems: {
    pageInfo: { hasNextPage: false },
    nodes: [
      {
        sku: " DEPOSIT ",
        quantity: 300,
        currentQuantity: 300,
        originalTotalSet: { shopMoney: { amount: "300.0" } },
        discountAllocations: [
          { allocatedAmountSet: { shopMoney: { amount: "50.0" } } },
          { allocatedAmountSet: { shopMoney: { amount: "10.00" } } },
        ],
      },
      {
        sku: null,
        quantity: 1,
        currentQuantity: 1,
        originalTotalSet: { shopMoney: { amount: "10.00" } },
        discountAllocations: [],
      },
    ],
  },
};

test("orders: an order is reduced to exact cents, net of every discount", async () => {
  await withShopify(
    () => ({ data: { order: RAW_ORDER } }),
    async ({ calls }) => {
      const order = await shopifyOrders.getDepositOrder("gid://shopify/Order/5");
      assert.deepEqual(order, {
        id: "gid://shopify/Order/5",
        name: "#1005",
        test: false,
        cancelled: false,
        processedAt: "2026-11-26T17:59:00Z",
        updatedAt: "2026-11-26T18:00:00Z",
        currency: "CAD",
        financialStatus: "PAID",
        note: "",
        customerId: "gid://shopify/Customer/7",
        netPaymentCents: 25120,
        lines: [
          { sku: "DEPOSIT", quantity: 300, currentQuantity: 300, netCents: 24000 },
          { sku: "", quantity: 1, currentQuantity: 1, netCents: 1000 },
        ],
        truncated: false,
        unreadable: false,
      });
      assert.deepEqual(calls[0].variables, { id: "gid://shopify/Order/5" });
    },
  );
});

test("orders: an amount that can't be read exactly marks the whole order unreadable", () => {
  const broken = JSON.parse(JSON.stringify(RAW_ORDER));
  broken.lineItems.nodes[0].originalTotalSet.shopMoney.amount = "300.005";
  const order = shopifyOrders.summarizeOrder(broken);
  assert.equal(order.unreadable, true);
  assert.equal(order.lines[0].netCents, null);

  const long = JSON.parse(JSON.stringify(RAW_ORDER));
  long.lineItems.pageInfo.hasNextPage = true;
  assert.equal(shopifyOrders.summarizeOrder(long).truncated, true);
});

test("orders: a missing order comes back as null", async () => {
  await withShopify(
    () => ({ data: { order: null } }),
    async () => assert.equal(await shopifyOrders.getDepositOrder("gid://shopify/Order/404"), null),
  );
});

test("orders: a text-link deposit is recorded as a paid, non-taxable Customer Deposit line", async () => {
  await withShopify(
    () => ({ data: { orderCreate: { order: { id: "gid://shopify/Order/9", name: "#1009" }, userErrors: [] } } }),
    async ({ calls }) => {
      const order = await shopifyOrders.createDepositOrder({
        customerId: "gid://shopify/Customer/7",
        amountCents: 25050,
        note: "Marin Rift Zone",
        depositSku: "DEPOSIT",
        provider: "Helcim",
        providerReference: "INV5001",
      });
      assert.deepEqual(order, { id: "gid://shopify/Order/9", name: "#1009" });
      const sent = calls[0].variables.order;
      const money = { shopMoney: { amount: "250.50", currencyCode: "CAD" } };
      assert.deepEqual(sent.lineItems, [
        {
          title: "Customer Deposit",
          sku: "DEPOSIT",
          quantity: 1,
          priceSet: money,
          requiresShipping: false,
          taxable: false,
          properties: [{ name: "For", value: "Marin Rift Zone" }],
        },
      ]);
      assert.deepEqual(sent.transactions, [{ kind: "SALE", status: "SUCCESS", gateway: "Helcim", amountSet: money }]);
      assert.deepEqual(sent.customer, { toAssociate: { id: "gid://shopify/Customer/7" } });
      assert.deepEqual(sent.tags, ["customer-deposit", "deposit-by-text"]);
      assert.match(sent.note, /Helcim reference INV5001\) - Marin Rift Zone$/);
    },
  );
});

test("orders: a deposit with no note and no customer is still a valid order", async () => {
  await withShopify(
    () => ({ data: { orderCreate: { order: { id: "gid://shopify/Order/9", name: "#1009" }, userErrors: [] } } }),
    async ({ calls }) => {
      await shopifyOrders.createDepositOrder({
        customerId: null,
        amountCents: 5000,
        note: "",
        depositSku: "DEPOSIT",
        provider: "Helcim",
        providerReference: "INV1",
      });
      const sent = calls[0].variables.order;
      assert.equal(sent.lineItems[0].properties, undefined);
      assert.equal(sent.customer, undefined);
    },
  );
});

test("orders: a refused order is a definite 'not created', with no Shopify text in the message", async () => {
  await withShopify(
    () => ({
      data: {
        orderCreate: {
          order: null,
          userErrors: [{ field: ["order", "lineItems"], message: "Customer Jane Doe (jane@example.com) is invalid" }],
        },
      },
    }),
    async () => {
      await assert.rejects(
        shopifyOrders.createDepositOrder({
          customerId: null,
          amountCents: 5000,
          note: "",
          depositSku: "DEPOSIT",
          provider: "Helcim",
          providerReference: "INV1",
        }),
        (err) => {
          assert.equal(err.applied, "no");
          assert.match(err.message, /order\.lineItems/);
          assert.doesNotMatch(err.message, /Jane|example\.com/);
          return true;
        },
      );
    },
  );
});

test("customers: an existing customer is found by phone; nothing is created", async () => {
  await withShopify(
    (name) => {
      assert.equal(name, "FindCustomerByPhone");
      return { data: { customers: { nodes: [{ id: "gid://shopify/Customer/7" }] } } };
    },
    async ({ calls }) => {
      assert.deepEqual(await shopifyOrders.findOrCreateCustomerByPhone("250-555-1234"), {
        id: "gid://shopify/Customer/7",
      });
      assert.deepEqual(calls[0].variables, { q: "phone:+12505551234" });
      assert.equal(calls.length, 1);
    },
  );
});

test("customers: an unknown number gets a bare customer record - phone only, no marketing consent", async () => {
  await withShopify(
    (name) =>
      name === "FindCustomerByPhone"
        ? { data: { customers: { nodes: [] } } }
        : { data: { customerCreate: { customer: { id: "gid://shopify/Customer/8" }, userErrors: [] } } },
    async ({ calls }) => {
      assert.deepEqual(await shopifyOrders.findOrCreateCustomerByPhone("+12505551234"), {
        id: "gid://shopify/Customer/8",
      });
      const input = calls[1].variables.input;
      assert.equal(input.phone, "+12505551234");
      assert.deepEqual(input.tags, ["deposit-by-text"]);
      assert.equal(input.smsMarketingConsent, undefined);
      assert.equal(input.emailMarketingConsent, undefined);
    },
  );
});

test("customers: losing a race to create the same customer falls back to finding them", async () => {
  let finds = 0;
  await withShopify(
    (name) => {
      if (name === "FindCustomerByPhone") {
        finds += 1;
        return { data: { customers: { nodes: finds === 1 ? [] : [{ id: "gid://shopify/Customer/8" }] } } };
      }
      return {
        data: {
          customerCreate: {
            customer: null,
            userErrors: [{ field: ["phone"], message: "Phone has already been taken" }],
          },
        },
      };
    },
    async () => {
      assert.deepEqual(await shopifyOrders.findOrCreateCustomerByPhone("+12505551234"), {
        id: "gid://shopify/Customer/8",
      });
    },
  );
});

test("customers: something that isn't a phone number never reaches a Shopify search", async () => {
  await withShopify(
    () => assert.fail("no request expected"),
    async () => {
      assert.equal(await shopifyOrders.findCustomerByPhone("+1250555 OR email:*"), null);
      assert.equal(await shopifyOrders.findCustomerByPhone(""), null);
    },
  );
});

test("lookups: Shopify's fuzzy order search is only trusted on an exact match", async () => {
  await withShopify(
    () => ({
      data: {
        orders: {
          nodes: [
            { id: "gid://shopify/Order/1", name: "LS2951" },
            { id: "gid://shopify/Order/2", name: "#2951" },
          ],
        },
      },
    }),
    async () => {
      assert.equal(await shopifyOrders.findOrderIdByName("#2951"), "gid://shopify/Order/2");
      assert.equal(await shopifyOrders.findOrderIdByName("#295"), null);
    },
  );
});

test("lookups: the sweep asks only for recent deposit orders sold since go-live", async () => {
  await withShopify(
    () => ({ data: { orders: { nodes: [{ id: "gid://shopify/Order/1", updatedAt: "2026-11-27T00:00:00Z" }] } } }),
    async ({ calls }) => {
      const found = await shopifyOrders.listRecentDepositOrders({
        sku: "DEPOSIT",
        since: new Date("2026-11-24T00:00:00Z"),
        soldSince: new Date("2026-11-26T08:00:00Z"),
      });
      assert.equal(found.length, 1);
      assert.deepEqual(calls[0].variables, {
        q: "sku:DEPOSIT updated_at:>='2026-11-24T00:00:00.000Z' processed_at:>='2026-11-26T08:00:00.000Z'",
        first: 50,
      });
    },
  );
});

// ---- store credit ------------------------------------------------------------------

test("store credit: a credit is sent in CAD with an exact amount and no expiry", async () => {
  await withShopify(
    () => ({
      data: {
        storeCreditAccountCredit: {
          storeCreditAccountTransaction: {
            id: "gid://shopify/StoreCreditAccountCreditTransaction/1",
            balanceAfterTransaction: { amount: "300.0" },
          },
          userErrors: [],
        },
      },
    }),
    async ({ calls }) => {
      const result = await shopifyStoreCredit.credit({ customerId: "gid://shopify/Customer/7", cents: 30000 });
      assert.deepEqual(result, {
        transactionId: "gid://shopify/StoreCreditAccountCreditTransaction/1",
        balanceCents: 30000,
      });
      assert.deepEqual(calls[0].variables, {
        id: "gid://shopify/Customer/7",
        creditInput: { creditAmount: { amount: "300.00", currencyCode: "CAD" } },
      });
    },
  );
});

test("store credit: a refusal is a definite 'not applied' carrying Shopify's code", async () => {
  await withShopify(
    () => ({
      data: {
        storeCreditAccountDebit: {
          storeCreditAccountTransaction: null,
          userErrors: [{ code: "INSUFFICIENT_FUNDS", message: "Insufficient funds" }],
        },
      },
    }),
    async ({ calls }) => {
      await assert.rejects(
        shopifyStoreCredit.debit({ customerId: "gid://shopify/Customer/7", cents: 10000 }),
        (err) => {
          assert.equal(err.applied, "no");
          assert.equal(err.retryable, false);
          assert.equal(err.code, "INSUFFICIENT_FUNDS");
          return true;
        },
      );
      assert.deepEqual(calls[0].variables.debitInput, { debitAmount: { amount: "100.00", currencyCode: "CAD" } });
    },
  );
});

test("store credit: an answer with neither a transaction nor an error is unknown, not success", async () => {
  await withShopify(
    () => ({ data: { storeCreditAccountCredit: { storeCreditAccountTransaction: null, userErrors: [] } } }),
    async () => {
      await assert.rejects(
        shopifyStoreCredit.credit({ customerId: "gid://shopify/Customer/7", cents: 100 }),
        (err) => err.applied === "unknown",
      );
    },
  );
});

test("store credit: zero, negative and fractional amounts never reach Shopify", async () => {
  await withShopify(
    () => assert.fail("no request expected"),
    async () => {
      for (const cents of [0, -100, 10.5, NaN, "100", undefined]) {
        await assert.rejects(
          shopifyStoreCredit.credit({ customerId: "gid://shopify/Customer/7", cents }),
          (err) => err.applied === "no",
        );
        await assert.rejects(
          shopifyStoreCredit.debit({ customerId: "gid://shopify/Customer/7", cents }),
          (err) => err.applied === "no",
        );
      }
    },
  );
});

// ---- webhooks ----------------------------------------------------------------------

function signed(body, { secret = "client-secret", shop = "test-shop.myshopify.com" } = {}) {
  const rawBody = Buffer.from(body);
  return {
    rawBody,
    headers: {
      "x-shopify-hmac-sha256": crypto.createHmac("sha256", secret).update(rawBody).digest("base64"),
      "x-shopify-shop-domain": shop,
    },
  };
}
const verify = (delivery, overrides = {}) =>
  shopifyWebhooks.verifyWebhook({
    ...delivery,
    clientSecret: "client-secret",
    expectedShopDomain: "test-shop.myshopify.com",
    ...overrides,
  });

test("webhooks: a correctly signed delivery for this shop is accepted", () => {
  assert.deepEqual(verify(signed('{"id":1}')), { ok: true });
  assert.deepEqual(verify(signed('{"id":1}', { shop: "Test-Shop.myshopify.com" })), { ok: true });
});

test("webhooks: anything unsigned, mis-signed, altered or for another shop is refused", () => {
  const good = signed('{"id":1}');
  assert.equal(verify({ rawBody: good.rawBody, headers: {} }).reason, "no_signature");
  assert.equal(verify(signed('{"id":1}', { secret: "attacker" })).reason, "signature_mismatch");
  assert.equal(verify({ ...good, rawBody: Buffer.from('{"id":2}') }).reason, "signature_mismatch");
  assert.equal(
    verify({ rawBody: good.rawBody, headers: { ...good.headers, "x-shopify-hmac-sha256": "not base64 !!" } }).reason,
    "signature_mismatch",
  );
  assert.equal(
    verify({ rawBody: good.rawBody, headers: { ...good.headers, "x-shopify-hmac-sha256": ["a", "b"] } }).reason,
    "no_signature",
  );
  assert.equal(verify(signed('{"id":1}', { shop: "other-shop.myshopify.com" })).reason, "wrong_shop");
  assert.equal(verify(good, { expectedShopDomain: undefined }).reason, "wrong_shop");
  assert.equal(verify(good, { clientSecret: "" }).reason, "no_client_secret");
  assert.equal(verify({ rawBody: {}, headers: good.headers }).reason, "no_body");
  assert.equal(verify({ rawBody: Buffer.alloc(0), headers: good.headers }).reason, "no_body");
});

test("webhooks: the payload only ever says which order to look at", () => {
  const order = { id: 8334472642765, line_items: [{ sku: "deposit " }, { sku: null }] };
  assert.deepEqual(readEvent("orders/paid", order, "DEPOSIT"), {
    orderId: "gid://shopify/Order/8334472642765",
    mentionsDeposit: true,
  });
  assert.deepEqual(readEvent("orders/updated", { id: 5, line_items: [{ sku: "TUBE" }] }, "DEPOSIT"), {
    orderId: "gid://shopify/Order/5",
    mentionsDeposit: false,
  });
  assert.deepEqual(
    readEvent(
      "refunds/create",
      { id: 1, order_id: 5, refund_line_items: [{ line_item: { sku: "DEPOSIT" } }] },
      "DEPOSIT",
    ),
    { orderId: "gid://shopify/Order/5", mentionsDeposit: true },
  );
  assert.deepEqual(readEvent("refunds/create", { id: 1, order_id: 5, refund_line_items: [] }, "DEPOSIT"), {
    orderId: "gid://shopify/Order/5",
    mentionsDeposit: false,
  });
  // Hostile or malformed IDs never become an order reference.
  for (const id of ["5 OR 1=1", "gid://shopify/Order/5", -5, 1.5, null, {}, "9".repeat(30)]) {
    assert.equal(readEvent("orders/paid", { id, line_items: [] }, "DEPOSIT").orderId, null, String(id));
  }
  assert.equal(readEvent("orders/paid", null, "DEPOSIT"), null);
  assert.equal(readEvent("orders/paid", "x", "DEPOSIT"), null);
});

test("webhooks: missing subscriptions are created, existing ones are left alone", async () => {
  const uri = "https://smith-creek-texts.onrender.com/webhooks/shopify";
  await withShopify(
    (name, variables) => {
      if (name === "ListWebhookSubscriptions") {
        return {
          data: {
            webhookSubscriptions: {
              nodes: [
                { id: "1", topic: "ORDERS_PAID", uri },
                { id: "2", topic: "REFUNDS_CREATE", uri: "https://somewhere-else.example/hook" },
              ],
            },
          },
        };
      }
      if (variables.topic === "ORDERS_CANCELLED") {
        return {
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: null,
              userErrors: [{ field: ["topic"], message: "nope" }],
            },
          },
        };
      }
      return { data: { webhookSubscriptionCreate: { webhookSubscription: { id: "9" }, userErrors: [] } } };
    },
    async ({ calls }) => {
      const result = await shopifyWebhooks.ensureSubscriptions({
        baseUrl: "https://smith-creek-texts.onrender.com/",
        logger: quiet,
      });
      assert.deepEqual(result, {
        created: ["ORDERS_UPDATED", "REFUNDS_CREATE"],
        existing: ["ORDERS_PAID"],
        failed: ["ORDERS_CANCELLED"],
      });
      const created = calls.filter((c) => c.name === "SubscribeWebhook");
      assert.ok(created.every((c) => c.variables.sub.uri === uri && c.variables.sub.format === "JSON"));
    },
  );
  await assert.rejects(
    shopifyWebhooks.ensureSubscriptions({ baseUrl: "http://insecure.example", logger: quiet }),
    /https/,
  );
});

// ---- staff form validation ---------------------------------------------------------

test("deposit actions: order numbers are tidied, and nothing odd gets through", () => {
  assert.deepEqual(validate(depositActionSchema, { action: "recheck", order_name: " 1234 " }).data, {
    action: "recheck",
    order_name: "#1234",
  });
  assert.equal(validate(depositActionSchema, { action: "recheck", order_name: "#1234" }).data.order_name, "#1234");
  assert.equal(validate(depositActionSchema, { action: "recheck", order_name: "LS2951" }).data.order_name, "LS2951");
  assert.equal(
    validate(depositActionSchema, { action: "applied", order_id: "gid://shopify/Order/5" }).data.order_id,
    "gid://shopify/Order/5",
  );

  for (const bad of [
    { action: "recheck" },
    { action: "recheck", order_name: '#1234" OR name:*' },
    { action: "recheck", order_name: "x".repeat(30) },
    { action: "recheck", order_name: ["#1", "#2"] },
    { action: "recheck", order_name: "#1", order_id: "gid://shopify/Order/5" },
    { action: "applied", order_name: "#1234" },
    { action: "not_applied" },
    { action: "delete", order_id: "gid://shopify/Order/5" },
    { action: "applied", order_id: "gid://shopify/Customer/5" },
    { action: "applied", order_id: "gid://shopify/Order/5; DROP TABLE" },
    {},
  ]) {
    assert.ok(validate(depositActionSchema, bad).error, JSON.stringify(bad));
  }
});
