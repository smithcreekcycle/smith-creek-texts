// Money helpers. Amounts are carried as integer cents everywhere in this app;
// these are the only two places a decimal string is read or written.
//
// No floating point: "19.99" * 100 is 1998.9999999999998 in JavaScript, and a
// store-credit balance is the wrong place to find that out.

// Shopify sends amounts as decimal strings and isn't consistent about the
// number of places ("1575.0", "300.00", "12"). Returns integer cents, or null
// for anything that isn't a plain non-negative amount with at most two
// decimal places - callers treat null as "don't act on this".
function parseMoneyToCents(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  const match = /^(\d{1,12})(?:\.(\d{1,2})0*)?$/.exec(text);
  if (!match) return null;
  const dollars = Number(match[1]);
  const cents = match[2] ? Number(match[2].padEnd(2, "0")) : 0;
  return dollars * 100 + cents;
}

// 30000 -> "300.00", the shape Shopify's MoneyInput wants.
function centsToAmount(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new TypeError(`centsToAmount needs a non-negative whole number of cents, got ${cents}`);
  }
  const dollars = Math.floor(cents / 100);
  return `${dollars}.${String(cents % 100).padStart(2, "0")}`;
}

function formatDollars(cents) {
  return `$${centsToAmount(Math.abs(cents))}`;
}

module.exports = { parseMoneyToCents, centsToAmount, formatDollars };
