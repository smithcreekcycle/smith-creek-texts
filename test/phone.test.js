const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePhone, maskPhone } = require("../src/phone");

test("normalizePhone accepts the ways staff actually type Canadian numbers", () => {
  for (const input of [
    "+12505551234",
    "2505551234",
    "250-555-1234",
    "(250) 555-1234",
    "250.555.1234",
    "1 250 555 1234",
    " 250 555 1234 ",
  ]) {
    assert.equal(normalizePhone(input), "+12505551234", input);
  }
});

test("normalizePhone keeps a properly written international number", () => {
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
});

test("normalizePhone rejects numbers that can't be texted", () => {
  for (const input of [
    "",
    null,
    undefined,
    "555-1234",
    "250555123",
    "25055512345",
    "0505551234",
    "2501551234",
    "+1250555123",
    "+123",
    "<script>alert(1)</script>",
    "250-555-1234 ext 5",
    "442079460958",
  ]) {
    assert.equal(normalizePhone(input), null, String(input));
  }
});

test("maskPhone keeps only the last four digits", () => {
  assert.equal(maskPhone("+12505551234"), "***1234");
  assert.equal(maskPhone(""), "***");
  assert.equal(maskPhone(undefined), "***");
});
