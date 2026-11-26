// Every piece of HTML this app sends, in one place. Pure functions: data in,
// string out. Nothing here talks to the database or reads the request.
//
// The one rule: anything that isn't a literal in this file goes through
// escapeHtml() before it's interpolated.

const ORANGE = "#FF5A1F";
const RED = "#c0392b";

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// The server runs in UTC; the shop doesn't. Always show shop time.
const shopTime = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Vancouver",
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : shopTime.format(date);
}

function formatMoney(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function csrfField(csrfToken) {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">`;
}

// Shared shell for the plain staff pages.
function page({ title, maxWidth = 480, body }) {
  return `<!doctype html>
<html>
<head>
<title>${escapeHtml(title)} - Smith Creek Texts</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: sans-serif; max-width: ${maxWidth}px; margin: 40px auto; padding: 0 16px; color: #111;">
${body}
</body>
</html>`;
}

// ---- Login -----------------------------------------------------------------

// `error` is always one of these fixed codes, never raw error text, so an
// internal message (an SMTP hostname, say) can't leak to someone who isn't
// logged in.
const LOGIN_ERROR_MESSAGES = {
  send_failed: "Couldn't send the login link right now. Try again in a minute, or contact the site admin.",
  expired: "That login link has expired or was already used. Request a new one below.",
};

// Styled to match the Smith Creek Cycle brand (smithcreekcycle.ca): white
// page, black type, Archivo Black headline, hard-edged orange button.
function loginShell(inner) {
  return `<!doctype html>
<html>
<head>
<title>Log in - Smith Creek Texts</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&display=swap" rel="stylesheet">
</head>
<body style="font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; background:#fff; color:#111; max-width: 420px; margin: 0 auto; padding: 0 24px;">
<div style="margin-top:72px; display:flex; align-items:center; gap:10px;">
  <div style="display:flex; gap:3px; transform: skewX(-12deg);">
    <div style="width:6px; height:28px; background:#FF5C00;"></div>
    <div style="width:6px; height:28px; background:#FF5C00;"></div>
    <div style="width:6px; height:28px; background:#111;"></div>
  </div>
  <span style="font-family:'Archivo Black', sans-serif; font-size:22px; letter-spacing:0.5px; white-space:nowrap;">SMITH CREEK CYCLE</span>
</div>
<p style="color:#FF5C00; font-weight:700; letter-spacing:3px; text-transform:uppercase; font-size:12px; margin: 28px 0 4px;">Staff login</p>
<h1 style="font-family:'Archivo Black', sans-serif; font-size:28px; margin: 0 0 24px; line-height:1.15;">Smith Creek Texts</h1>
${inner}
</body>
</html>`;
}

const LOGIN_BUTTON_STYLE =
  "width:100%; padding:14px 20px; background:#FF5C00; color:#111; font-weight:700; letter-spacing:2px; text-transform:uppercase; font-size:13px; border:none; border-radius:0; cursor:pointer;";

function loginPage({ email, sent, error, tokenTtlMinutes }) {
  const errorMessage = error ? LOGIN_ERROR_MESSAGES[error] || "Something went wrong. Try again." : null;
  return loginShell(`
${sent ? `<p style="background:#111; color:#fff; padding:12px 14px; font-size:14px; line-height:1.4;">If that address is allowed, a login link is on its way. Check the inbox and click the link (it expires in ${escapeHtml(tokenTtlMinutes)} minutes).</p>` : ""}
${errorMessage ? `<p style="background:${RED}; color:#fff; padding:12px 14px; font-size:14px; line-height:1.4;">${escapeHtml(errorMessage)}</p>` : ""}
<form method="POST" action="/login" style="margin-top: 8px;">
<label style="display:block; font-weight:700; font-size:13px; letter-spacing:0.5px; margin-bottom:6px;">Email</label>
<input type="email" name="email" value="${escapeHtml(email)}" required style="width:100%; box-sizing:border-box; padding:12px; font-size:15px; border:2px solid #111; border-radius:0; margin-bottom:18px;">
<button type="submit" style="${LOGIN_BUTTON_STYLE}">Email me a login link</button>
</form>`);
}

// Shown when the emailed link is opened. The link itself doesn't log anyone
// in - this button does (see routes/login.js for why).
function loginConfirmPage({ token }) {
  return loginShell(`
<p style="font-size:15px; line-height:1.5;">One more tap and you're in.</p>
<form method="POST" action="/login/verify" style="margin-top: 8px;">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<button type="submit" style="${LOGIN_BUTTON_STYLE}">Finish logging in</button>
</form>`);
}

// ---- Staff pages -------------------------------------------------------------

function homePage({ csrfToken }) {
  return page({
    title: "Home",
    maxWidth: 640,
    body: `<h1 style="color:${ORANGE};">Smith Creek Texts</h1>
<p><a href="/inbox/needs-reply">Needs reply</a> &middot; <a href="/payments/send">Send a payment link</a> &middot; <a href="/payments">Deposits &amp; payments</a></p>
<p style="color:#666;">Status: <a href="/health">/health</a></p>
<form method="POST" action="/logout">
${csrfField(csrfToken)}
<button type="submit">Log out</button>
</form>`,
  });
}

function needsReplyPage({ items, csrfToken }) {
  const rows = items
    .map(function (i) {
      let preview;
      if (i.channel === "voicemail") {
        // Only ever link to an https URL; anything else is shown as text.
        const url = String(i.lastMessage || "");
        preview = /^https:\/\//i.test(url)
          ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer">listen</a>`
          : "(no recording)";
      } else {
        preview = escapeHtml(i.lastMessage || "");
      }
      return `<tr>
<td>${escapeHtml(i.channel)}</td>
<td>${escapeHtml(i.number)}</td>
<td>${escapeHtml(formatDateTime(i.receivedAt))}</td>
<td>${preview}</td>
<td>
  <form method="POST" action="/inbox/needs-reply/resolve">
    <input type="hidden" name="number" value="${escapeHtml(i.number)}">
    ${csrfField(csrfToken)}
    <button type="submit">Mark handled</button>
  </form>
</td>
<td><a href="/payments/send?phone=${encodeURIComponent(i.number)}">Send payment link</a></td>
</tr>`;
    })
    .join("");
  return page({
    title: "Needs reply",
    maxWidth: 900,
    body: `<h1 style="color:${ORANGE};">Needs a reply (${items.length})</h1>
<p><a href="/">Home</a> &middot; <a href="/payments">Payment history</a></p>
<table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%;">
<tr><th>Channel</th><th>From</th><th>Received</th><th>Message</th><th></th><th></th></tr>
${rows}
</table>`,
  });
}

function sendPaymentPage({ phone, csrfToken }) {
  return page({
    title: "Send payment link",
    body: `<h1 style="color:${ORANGE};">Send a payment link</h1>
<p><a href="/inbox/needs-reply">Needs reply</a> &middot; <a href="/payments">Payment history</a></p>
<form method="POST" action="/payments/send">
${csrfField(csrfToken)}
<label>Phone number<br>
<input type="tel" name="phone" value="${escapeHtml(phone)}" placeholder="250-555-1234" required style="width:100%; box-sizing:border-box; padding:8px;">
</label><br><br>
<label>Amount (CAD)<br>
<input type="number" name="amount" step="0.01" min="0.50" max="10000" placeholder="50.00" required style="width:100%; box-sizing:border-box; padding:8px;">
</label><br><br>
<label>Note (the customer sees this, e.g. bike model)<br>
<input type="text" name="note" maxlength="200" placeholder="Trek Fuel EX deposit" style="width:100%; box-sizing:border-box; padding:8px;">
</label><br><br>
<button type="submit" style="padding:10px 20px; background:${ORANGE}; color:white; border:none; border-radius:4px;">Create &amp; text link</button>
</form>`,
  });
}

const PAYMENT_NAV = `<p><a href="/payments/send">Send another</a> &middot; <a href="/payments">Payment history</a></p>`;

function paymentSentPage({ phone, amountCents }) {
  return page({
    title: "Link sent",
    body: `<h1 style="color:${ORANGE};">Link sent</h1>
<p>Texted a ${escapeHtml(formatMoney(amountCents))} payment link to ${escapeHtml(phone)}.</p>
${PAYMENT_NAV}`,
  });
}

function paymentErrorPage({ message }) {
  return page({
    title: "Couldn't send link",
    body: `<h1 style="color:${RED};">Couldn't send link</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/payments/send">Try again</a></p>`,
  });
}

// The invoice exists but the text didn't go out. Give staff the link so the
// customer can still be sent it another way, instead of creating a second
// invoice by retrying.
function paymentSmsFailedPage({ phone, amountCents, url, reason }) {
  return page({
    title: "Text didn't send",
    body: `<h1 style="color:${RED};">Invoice created, but the text didn't send</h1>
<p>A ${escapeHtml(formatMoney(amountCents))} invoice was created for ${escapeHtml(phone)}, but texting the link failed:</p>
<p style="color:#666;">${escapeHtml(reason)}</p>
<p>The link still works. Copy it and send it another way, rather than creating a second invoice:</p>
<p><input type="text" readonly value="${escapeHtml(url)}" style="width:100%; box-sizing:border-box; padding:8px;"></p>
${PAYMENT_NAV}`,
  });
}

// An identical link went out moments ago. Nothing was created; offer an
// explicit "yes, send another" rather than silently doing it twice.
function paymentDuplicatePage({ phone, amount, note, previousAt, csrfToken }) {
  return page({
    title: "Already sent",
    body: `<h1 style="color:${ORANGE};">That link was just sent</h1>
<p>A ${escapeHtml(formatMoney(Math.round(amount * 100)))} link went to ${escapeHtml(phone)} at ${escapeHtml(formatDateTime(previousAt))}. Nothing new was created.</p>
<form method="POST" action="/payments/send">
${csrfField(csrfToken)}
<input type="hidden" name="phone" value="${escapeHtml(phone)}">
<input type="hidden" name="amount" value="${escapeHtml(amount)}">
<input type="hidden" name="note" value="${escapeHtml(note)}">
<input type="hidden" name="confirm_duplicate" value="1">
<button type="submit">Send a second link anyway</button>
</form>
<p><a href="/payments">Payment history</a></p>`,
  });
}

function paymentInProgressPage() {
  return page({
    title: "Already sending",
    body: `<h1 style="color:${ORANGE};">Already sending</h1>
<p>That exact link is being created right now from another click. Check payment history in a few seconds before sending again.</p>
<p><a href="/payments">Payment history</a></p>`,
  });
}

// Outcome of a button press on the payments page. Always one of these fixed
// codes (it travels in the URL), never free text.
const DEPOSIT_NOTICES = {
  credited: "Store credit added.",
  reversed: "Store credit taken back.",
  in_sync: "Checked: the store credit already matches that order.",
  settled: "Marked as settled.",
  not_found: "No order with that number was found in Shopify.",
  not_deposit: "That order has no Customer Deposit item on it, so there's nothing to put on account.",
  needs_review: "Checked, but it still needs attention - see the note in the table below.",
  frozen: "That order is waiting on a decision - use the buttons in the table below.",
  busy: "That order is being updated right now. Try again in a minute.",
  invalid: "That didn't look like an order number. Use the number from Shopify, like #1234.",
  error: "Something went wrong talking to Shopify. Nothing was changed; try again in a minute.",
};

function depositAction({ csrfToken, orderId, action, label }) {
  return `<form method="POST" action="/payments/deposits" style="display:inline;">
${csrfField(csrfToken)}
<input type="hidden" name="order_id" value="${escapeHtml(orderId)}">
<input type="hidden" name="action" value="${escapeHtml(action)}">
<button type="submit">${escapeHtml(label)}</button>
</form>`;
}

// One row of the "Deposits on account" table: what the app believes is on
// the customer's account for this order, and what (if anything) it needs
// from a person.
function orderDepositRow(d, { csrfToken, shopAdminUrl }) {
  const numericId = /^gid:\/\/shopify\/Order\/(\d+)$/.exec(String(d.shopify_order_id || ""));
  const name = escapeHtml(d.order_name || "(order)");
  const orderCell =
    shopAdminUrl && numericId
      ? `<a href="${escapeHtml(`${shopAdminUrl}/orders/${numericId[1]}`)}" rel="noopener noreferrer" target="_blank">${name}</a>`
      : name;

  const waitingOnPerson = d.state === "unknown" || d.state === "blocked" || d.stuck;
  let status;
  let color = "#999";
  let actions = "";
  if (d.state === "unknown" || d.stuck) {
    status = "needs a decision";
    color = RED;
    actions =
      depositAction({ csrfToken, orderId: d.shopify_order_id, action: "applied", label: "It went through" }) +
      " " +
      depositAction({ csrfToken, orderId: d.shopify_order_id, action: "not_applied", label: "It didn't - try again" });
  } else if (d.state === "blocked") {
    status = "needs a decision";
    color = RED;
    actions =
      depositAction({ csrfToken, orderId: d.shopify_order_id, action: "not_applied", label: "Try again" }) +
      " " +
      depositAction({ csrfToken, orderId: d.shopify_order_id, action: "applied", label: "Leave it as is" });
  } else if (d.state === "in_progress") {
    status = "updating...";
  } else if (d.state === "needs_review") {
    status = "needs attention";
    color = "#e67e22";
    actions = depositAction({ csrfToken, orderId: d.shopify_order_id, action: "recheck", label: "Re-check" });
  } else if (d.credited_cents > 0) {
    status = "on account";
    color = "#2ecc71";
  } else {
    status = "nothing on account";
  }

  const fallbackMessage = d.stuck
    ? "A store credit change for this order was interrupted partway. Check the customer's store credit history in Shopify, then choose."
    : "";
  const message = d.message || fallbackMessage;
  return `<tr${waitingOnPerson ? ' style="background:#fff4f2;"' : ""}>
<td>${orderCell}</td>
<td>${escapeHtml(d.order_note || "")}</td>
<td>${escapeHtml(formatMoney(d.credited_cents))}</td>
<td><span style="color:${color}; font-weight:bold;">${escapeHtml(status)}</span>${message ? `<br><span style="color:#444; font-size:13px;">${escapeHtml(message)}</span>` : ""}</td>
<td>${actions}</td>
</tr>`;
}

// What a payment-link row says about its store credit.
function linkCreditLabel(d) {
  if (d.status === "order_failed") return "check the table above; if it's missing, add store credit by hand";
  if (!d.shopify_order_name) return "-";
  if (d.credit_state == null) return "pending";
  if (d.credit_state === "ok") return d.credited_cents > 0 ? "on account" : "nothing on account";
  if (d.credit_state === "in_progress") return "updating...";
  return "see above";
}

function paymentsHistoryPage({
  deposits,
  orderDeposits = [],
  csrfToken,
  notice,
  shopAdminUrl = null,
  depositSku = "DEPOSIT",
}) {
  const noticeText =
    notice && Object.prototype.hasOwnProperty.call(DEPOSIT_NOTICES, notice) ? DEPOSIT_NOTICES[notice] : null;
  const waiting = orderDeposits.filter((d) => d.state !== "ok" && d.state !== "in_progress").length;
  const accountRows = orderDeposits.map((d) => orderDepositRow(d, { csrfToken, shopAdminUrl })).join("");
  const linkRows = deposits
    .map(function (d) {
      const statusColor = d.status === "paid" ? "#2ecc71" : d.status === "order_failed" ? "#e67e22" : "#999";
      const statusLabel = d.status === "order_failed" ? "paid - needs manual entry" : d.status;
      const orderCell = d.shopify_order_name
        ? escapeHtml(d.shopify_order_name)
        : d.status === "order_failed"
          ? "not recorded in Shopify"
          : "-";
      return `<tr>
<td>${escapeHtml(formatDateTime(d.created_at))}</td>
<td>${escapeHtml(d.phone)}</td>
<td>${escapeHtml(formatMoney(d.amount_cents))}</td>
<td>${escapeHtml(d.note || "")}</td>
<td style="color:${statusColor}; font-weight:bold;">${escapeHtml(statusLabel)}</td>
<td>${orderCell}</td>
<td>${escapeHtml(linkCreditLabel(d))}</td>
</tr>`;
    })
    .join("");
  return page({
    title: "Payments",
    maxWidth: 1000,
    body: `<h1 style="color:${ORANGE};">Deposits &amp; payment links</h1>
<p><a href="/">Home</a> &middot; <a href="/payments/send">Send a new link</a></p>
${noticeText ? `<p style="background:#111; color:#fff; padding:10px 14px;">${escapeHtml(noticeText)}</p>` : ""}

<h2>Deposits on account${waiting ? ` <span style="color:${RED};">(${waiting} need${waiting === 1 ? "s" : ""} you)</span>` : ""}</h2>
<p style="color:#444;">A deposit is held as <strong>store credit</strong> on the customer's Shopify profile. It gets there two ways: a paid text payment link, or ringing up the <strong>Customer Deposit</strong> item (SKU ${escapeHtml(depositSku)}) in Shopify POS with the customer attached. At pickup, choose <strong>Store credit</strong> as the payment method. To cancel a deposit, refund the deposit order in Shopify and the credit comes back off by itself.</p>
<table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%;">
<tr><th>Order</th><th>Note</th><th>Store credit issued</th><th>Status</th><th></th></tr>
${accountRows || `<tr><td colspan="5" style="color:#666;">No deposits yet.</td></tr>`}
</table>
<form method="POST" action="/payments/deposits" style="margin: 14px 0 30px;">
${csrfField(csrfToken)}
<input type="hidden" name="action" value="recheck">
<label>Deposit not showing? Check an order:
<input type="text" name="order_name" placeholder="#1234" maxlength="21" required style="padding:6px; width:110px;">
</label>
<button type="submit">Check</button>
</form>

<h2>Payment links</h2>
<table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%;">
<tr><th>Sent</th><th>Phone</th><th>Amount</th><th>Note</th><th>Status</th><th>Shopify order</th><th>Store credit</th></tr>
${linkRows}
</table>`,
  });
}

// ---- Small fixed pages -------------------------------------------------------

function messagePage({ title, heading, message, headingColor = "#111" }) {
  return page({
    title,
    body: `<div style="text-align:center;">
<h1 style="color:${headingColor};">${escapeHtml(heading)}</h1>
<p>${escapeHtml(message)}</p>
</div>`,
  });
}

module.exports = {
  ORANGE,
  escapeHtml,
  formatDateTime,
  formatMoney,
  loginPage,
  loginConfirmPage,
  homePage,
  needsReplyPage,
  sendPaymentPage,
  paymentSentPage,
  paymentErrorPage,
  paymentSmsFailedPage,
  paymentDuplicatePage,
  paymentInProgressPage,
  paymentsHistoryPage,
  messagePage,
};
