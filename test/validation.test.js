const test = require("node:test");
const assert = require("node:assert/strict");
const { sendPaymentLinkSchema, validate } = require("../src/validation");

test("sendPaymentLinkSchema accepts a well-formed request", () => {
    const { data, error } = validate(sendPaymentLinkSchema, {
          phone: "+12505551234",
          amount: "50.00",
          note: "Trek Fuel EX deposit",
    });
    assert.equal(error, undefined);
    assert.equal(data.phone, "+12505551234");
    assert.equal(data.amount, 50);
    assert.equal(data.note, "Trek Fuel EX deposit");
});

test("sendPaymentLinkSchema defaults a missing note to an empty string", () => {
    const { data, error } = validate(sendPaymentLinkSchema, { phone: "+12505551234", amount: "10" });
    assert.equal(error, undefined);
    assert.equal(data.note, "");
});

test("sendPaymentLinkSchema rejects a non-numeric amount", () => {
    const { error } = validate(sendPaymentLinkSchema, { phone: "+12505551234", amount: "not-a-number" });
    assert.ok(error, "expected a validation error");
});

test("sendPaymentLinkSchema rejects an amount below the minimum", () => {
    const { error } = validate(sendPaymentLinkSchema, { phone: "+12505551234", amount: "0.10" });
    assert.ok(error);
});

test("sendPaymentLinkSchema rejects an unreasonably large amount", () => {
    const { error } = validate(sendPaymentLinkSchema, { phone: "+12505551234", amount: "999999" });
    assert.ok(error);
});

test("sendPaymentLinkSchema rejects an obviously malformed phone number", () => {
    const { error } = validate(sendPaymentLinkSchema, { phone: "<script>alert(1)</script>", amount: "10" });
    assert.ok(error);
});

test("sendPaymentLinkSchema rejects an empty phone number", () => {
    const { error } = validate(sendPaymentLinkSchema, { phone: "", amount: "10" });
    assert.ok(error);
});

test("sendPaymentLinkSchema accepts everyday phone formats and returns E.164", () => {
    for (const phone of ["2505551234", "250-555-1234", "(250) 555-1234", "1 250 555 1234"]) {
          const { data, error } = validate(sendPaymentLinkSchema, { phone, amount: "10" });
          assert.equal(error, undefined, phone);
          assert.equal(data.phone, "+12505551234", phone);
    }
});

test("sendPaymentLinkSchema rejects a number too short to text", () => {
    const { error } = validate(sendPaymentLinkSchema, { phone: "555-1234", amount: "10" });
    assert.ok(error);
});

test("sendPaymentLinkSchema rejects a repeated phone field instead of crashing", () => {
    const { error } = validate(sendPaymentLinkSchema, { phone: ["2505551234", "2505550000"], amount: "10" });
    assert.ok(error);
});

test("sendPaymentLinkSchema flattens line breaks in the note", () => {
    const { data } = validate(sendPaymentLinkSchema, { phone: "2505551234", amount: "10", note: "Fuel EX\r\n deposit" });
    assert.equal(data.note, "Fuel EX deposit");
});
