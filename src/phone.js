// Phone number helpers. No dependencies, so this is trivially testable.
//
// Staff type numbers the way people write them ("250-555-1234",
// "(250) 555 1234"), but Twilio only accepts E.164 ("+12505551234"). Rather
// than reject the natural formats, accept them and normalize once, at the
// edge, so everything downstream (Twilio, the payment processor, Shopify
// customer matching, the deposits table) sees a single canonical form.

// North American numbers: area code and exchange can't start with 0 or 1.
const NANP_PATTERN = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

// Returns the number in E.164, or null if it can't be a real phone number.
function normalizePhone(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return null;
  // Digits plus the punctuation people actually use. Anything else (letters,
  // angle brackets, ...) is a typo or an attack, not a phone number.
  if (!/^\+?[\d\s().-]+$/.test(raw)) return null;

  const digits = raw.replace(/\D/g, "");
  let e164;
  if (raw.startsWith("+")) {
    e164 = `+${digits}`;
  } else if (digits.length === 10) {
    e164 = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    e164 = `+${digits}`;
  } else {
    // An international number without a "+" is ambiguous - make staff say
    // which country rather than guessing and texting a stranger.
    return null;
  }

  if (e164.startsWith("+1")) {
    return NANP_PATTERN.test(e164) ? e164 : null;
  }
  // E.164 allows at most 15 digits; 8 is the shortest real international number.
  return digits.length >= 8 && digits.length <= 15 ? e164 : null;
}

// For log lines: enough to match a number up by eye, not enough to be a
// customer's phone number sitting in a log file.
function maskPhone(phone) {
  const value = String(phone || "");
  return value.length > 4 ? `***${value.slice(-4)}` : "***";
}

module.exports = { normalizePhone, maskPhone };
