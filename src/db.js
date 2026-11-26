// All database access lives here. Every query is parameterized ($1, $2, ...);
// nothing from a request is ever concatenated into SQL.

const { Pool } = require("pg");
const crypto = require("crypto");

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

// pg emits "error" on the pool when an idle connection drops (database
// restart, network blip). With no listener, Node treats that as an uncaught
// exception and the whole app exits. The pool replaces the dead connection
// on its own, so logging is the right response.
if (pool) {
  pool.on("error", (err) => {
    console.error("Postgres idle connection error (the pool will reconnect)", err.message);
  });
}

// Login tokens are single-use secrets good for 15 minutes; store only a
// SHA-256 hash of each one (never the raw value) so a database read on its
// own - a leaked backup, a stray query - can't be replayed as a valid login,
// the same reasoning as hashing passwords.
function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

// Every statement here is safe to run on every boot.
async function initSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calls (
      id SERIAL PRIMARY KEY,
      call_sid TEXT UNIQUE NOT NULL,
      from_number TEXT NOT NULL,
      to_number TEXT NOT NULL,
      recording_url TEXT,
      duration_seconds INTEGER,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS thread_status (
      phone_number TEXT PRIMARY KEY,
      resolved_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deposits (
      id SERIAL PRIMARY KEY,
      stripe_session_id TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CAD',
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      shopify_order_id TEXT,
      shopify_order_name TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at TIMESTAMPTZ
    )
  `);
  // Deposits moved from Stripe to Helcim. Old Stripe rows stay exactly as
  // they are; these columns let Helcim rows live in the same table. A Helcim
  // deposit has no Stripe session, so that column can no longer be NOT NULL.
  await pool.query(`ALTER TABLE deposits ALTER COLUMN stripe_session_id DROP NOT NULL`);
  await pool.query(`ALTER TABLE deposits ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'stripe'`);
  await pool.query(`ALTER TABLE deposits ADD COLUMN IF NOT EXISTS helcim_invoice_number TEXT`);
  await pool.query(`ALTER TABLE deposits ADD COLUMN IF NOT EXISTS helcim_token TEXT`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS deposits_helcim_invoice_number_idx
      ON deposits (helcim_invoice_number)
      WHERE helcim_invoice_number IS NOT NULL
  `);
  // Store credit issued against deposit orders (see storeCredit.js). One row
  // per Shopify order that contains the deposit item. `credited_cents` is how
  // much store credit this app believes it has put on the customer's account
  // for that order; every change to it goes through claimOrderDepositChange.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_deposits (
      shopify_order_id TEXT PRIMARY KEY,
      order_name TEXT,
      order_note TEXT,
      customer_id TEXT,
      credited_cents INTEGER NOT NULL DEFAULT 0 CHECK (credited_cents >= 0),
      state TEXT NOT NULL DEFAULT 'ok',
      pending_delta_cents INTEGER,
      message TEXT,
      synced_updated_at TIMESTAMPTZ,
      state_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Append-only record of every store credit change this app attempted.
  // Nothing reads it to make a decision; it exists so a person can see what
  // happened and when.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_credit_ledger (
      id SERIAL PRIMARY KEY,
      shopify_order_id TEXT NOT NULL,
      customer_id TEXT,
      delta_cents INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      shopify_transaction_id TEXT,
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS store_credit_ledger_order_idx ON store_credit_ledger (shopify_order_id, id)`,
  );
  // Single-use magic-link login tokens. Rows are cheap to accumulate; the
  // table stays tiny, so old ones aren't pruned.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

// ---- Voicemail / needs-reply -------------------------------------------------

async function logVoicemail({ callSid, from, to, recordingUrl, durationSeconds }) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO calls (call_sid, from_number, to_number, recording_url, duration_seconds)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (call_sid) DO UPDATE
       SET recording_url = EXCLUDED.recording_url, duration_seconds = EXCLUDED.duration_seconds`,
    [callSid, from, to, recordingUrl, durationSeconds],
  );
}

async function getOpenVoicemails() {
  if (!pool) return [];
  const { rows } = await pool.query(`
    SELECT c.from_number, c.recording_url, c.duration_seconds, c.received_at
    FROM calls c
    LEFT JOIN thread_status t ON t.phone_number = c.from_number
    WHERE t.resolved_at IS NULL OR c.received_at > t.resolved_at
    ORDER BY c.received_at DESC
  `);
  return rows;
}

async function markResolved(phoneNumber) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO thread_status (phone_number, resolved_at) VALUES ($1, now())
     ON CONFLICT (phone_number) DO UPDATE SET resolved_at = now()`,
    [phoneNumber],
  );
}

async function getResolvedAt(phoneNumber) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT resolved_at FROM thread_status WHERE phone_number = $1`, [phoneNumber]);
  return rows[0] && rows[0].resolved_at ? rows[0].resolved_at : null;
}

// ---- Deposits: Stripe (dormant backup path, unchanged) -----------------------

async function recordDepositCreated({ stripeSessionId, phone, amountCents, currency, note }) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO deposits (stripe_session_id, phone, amount_cents, currency, note)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (stripe_session_id) DO NOTHING`,
    [stripeSessionId, phone, amountCents, currency, note || null],
  );
}

// Marks a deposit paid, but only transitions it out of a non-paid status -
// the WHERE clause makes this safe to call twice. Returns true only the
// first time (when it actually flipped the status), so the caller knows
// whether to go on and create a Shopify order. Stripe documents that a
// webhook can be delivered more than once for the same event; without this
// guard a redelivery would create a second Shopify order for one payment.
async function markDepositPaid(stripeSessionId, { amountCents, currency }) {
  if (!pool) return false;
  const { rowCount } = await pool.query(
    `UPDATE deposits SET status = 'paid', paid_at = now(), amount_cents = $2, currency = $3
     WHERE stripe_session_id = $1 AND status <> 'paid'`,
    [stripeSessionId, amountCents, currency],
  );
  return rowCount > 0;
}

async function recordDepositOrder(stripeSessionId, { shopifyOrderId, shopifyOrderName }) {
  if (!pool) return;
  await pool.query(`UPDATE deposits SET shopify_order_id = $2, shopify_order_name = $3 WHERE stripe_session_id = $1`, [
    stripeSessionId,
    shopifyOrderId,
    shopifyOrderName,
  ]);
}

async function recordDepositOrderError(stripeSessionId, message) {
  if (!pool) return;
  await pool.query(`UPDATE deposits SET status = 'order_failed', error_message = $2 WHERE stripe_session_id = $1`, [
    stripeSessionId,
    message,
  ]);
}

// ---- Deposits: Helcim (the live path) ----------------------------------------
//
// Separate functions rather than generalizing the Stripe ones in place, so
// the dormant Stripe path above is untouched and still works if it's needed.

// A plain INSERT on purpose. The unique index on helcim_invoice_number is a
// partial index, and Postgres refuses "ON CONFLICT (helcim_invoice_number)"
// against a partial index unless the predicate is repeated - the previous
// version of this statement failed on every single call for that reason. A
// duplicate invoice number should be impossible; if it ever happens, a loud
// error is the right outcome.
async function recordHelcimDepositCreated({ helcimInvoiceNumber, helcimToken, phone, amountCents, currency, note }) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO deposits (provider, helcim_invoice_number, helcim_token, phone, amount_cents, currency, note)
     VALUES ('helcim', $1, $2, $3, $4, $5, $6)`,
    [helcimInvoiceNumber, helcimToken, phone, amountCents, currency, note || null],
  );
}

// The most recent link sent to this number for this amount within the last
// `withinSeconds`, if any - used to catch a double-click or an accidental
// re-send before it creates a second invoice and a second text.
async function findRecentHelcimDeposit({ phone, amountCents, withinSeconds }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT id, created_at FROM deposits
     WHERE provider = 'helcim' AND phone = $1 AND amount_cents = $2
       AND created_at > now() - make_interval(secs => $3)
     ORDER BY created_at DESC LIMIT 1`,
    [phone, amountCents, withinSeconds],
  );
  return rows[0] || null;
}

// Invoice numbers are matched case-insensitively (the processor treats them
// that way); callers should use the returned row's own helcim_invoice_number
// from then on.
async function getDepositByInvoiceNumber(helcimInvoiceNumber) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT * FROM deposits WHERE upper(helcim_invoice_number) = upper($1) ORDER BY id LIMIT 1`,
    [helcimInvoiceNumber],
  );
  return rows[0] || null;
}

// The one-way gate for a Helcim deposit: pending -> paid, exactly once.
// Returns true only for the call that made the transition. Webhooks get
// redelivered and can race each other; whichever call wins this UPDATE is
// the only one allowed to create a Shopify order. It deliberately does NOT
// re-open a deposit that's already 'paid' or 'order_failed' - retrying an
// order that may have half-succeeded is a job for a person.
async function markDepositPaidByInvoiceNumber(helcimInvoiceNumber, { amountCents, currency }) {
  if (!pool) return false;
  const { rowCount } = await pool.query(
    `UPDATE deposits SET status = 'paid', paid_at = now(), amount_cents = $2, currency = $3
     WHERE helcim_invoice_number = $1 AND status = 'pending'`,
    [helcimInvoiceNumber, amountCents, currency],
  );
  return rowCount > 0;
}

async function recordHelcimDepositOrder(helcimInvoiceNumber, { shopifyOrderId, shopifyOrderName }) {
  if (!pool) return;
  await pool.query(
    `UPDATE deposits SET shopify_order_id = $2, shopify_order_name = $3 WHERE helcim_invoice_number = $1`,
    [helcimInvoiceNumber, shopifyOrderId, shopifyOrderName],
  );
}

// The money is in, but the Shopify order needs a person (creation failed, or
// the totals didn't line up). paid_at is left as-is.
async function recordHelcimDepositOrderError(helcimInvoiceNumber, message) {
  if (!pool) return;
  await pool.query(`UPDATE deposits SET status = 'order_failed', error_message = $2 WHERE helcim_invoice_number = $1`, [
    helcimInvoiceNumber,
    String(message || "").slice(0, 500),
  ]);
}

// Payment links, newest first, each with the store-credit state of the
// Shopify order it produced (if it got that far).
async function getRecentDeposits() {
  if (!pool) return [];
  const { rows } = await pool.query(`
    SELECT d.*, od.state AS credit_state, od.credited_cents, od.state_changed_at AS credit_state_changed_at
    FROM deposits d
    LEFT JOIN order_deposits od ON od.shopify_order_id = d.shopify_order_id
    ORDER BY d.created_at DESC
    LIMIT 100
  `);
  return rows;
}

// ---- Store credit for deposit orders -------------------------------------------
//
// The rules these statements enforce, so storeCredit.js can't get them wrong:
//
//   * credited_cents only ever changes together with a state change, in one
//     UPDATE, guarded by the value the caller last read (compare-and-swap).
//     Two webhooks for the same order can't both win.
//   * While a row is 'in_progress', 'unknown' or 'blocked' nothing automatic
//     can touch it. 'in_progress' clears itself when the Shopify call
//     returns; the other two wait for a person.

// A row is "stuck" if it has sat in_progress longer than any Shopify call
// could take - the process died mid-change. Stuck rows are treated like
// 'unknown' and wait for a person.
const STUCK_AFTER_SECONDS = 120;
const FROZEN_FOR_STAFF = `(state IN ('unknown', 'blocked')
  OR (state = 'in_progress' AND state_changed_at < now() - make_interval(secs => ${STUCK_AFTER_SECONDS})))`;

async function getOrderDeposit(shopifyOrderId) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT *, (state = 'in_progress' AND state_changed_at < now() - make_interval(secs => ${STUCK_AFTER_SECONDS})) AS stuck
     FROM order_deposits WHERE shopify_order_id = $1`,
    [shopifyOrderId],
  );
  return rows[0] || null;
}

// Creates the row the first time a deposit order is seen and refreshes the
// descriptive columns after that. Never touches credited_cents or state.
async function upsertOrderDeposit({ shopifyOrderId, orderName, orderNote }) {
  if (!pool) return null;
  await pool.query(
    `INSERT INTO order_deposits (shopify_order_id, order_name, order_note)
     VALUES ($1, $2, $3)
     ON CONFLICT (shopify_order_id) DO UPDATE
       SET order_name = EXCLUDED.order_name, order_note = EXCLUDED.order_note, updated_at = now()`,
    [shopifyOrderId, orderName || null, String(orderNote || "").slice(0, 500) || null],
  );
  return getOrderDeposit(shopifyOrderId);
}

// Records that the store credit for this order matches the order as Shopify
// had it at `shopifyUpdatedAt`. The sweep skips orders that haven't changed
// since; it is only ever set after a reconcile has fully finished.
async function markOrderDepositSynced(shopifyOrderId, shopifyUpdatedAt) {
  if (!pool) return;
  await pool.query(`UPDATE order_deposits SET synced_updated_at = $2 WHERE shopify_order_id = $1 AND state = 'ok'`, [
    shopifyOrderId,
    shopifyUpdatedAt || null,
  ]);
}

// The gate. Moves credited_cents from `expectedCents` to `newCents` and marks
// the row in_progress, but only if nobody else has changed it since the
// caller read it and it isn't frozen. Returns true for the one caller that
// wins; that caller - and only that caller - then makes the Shopify call.
async function claimOrderDepositChange({ shopifyOrderId, expectedCents, newCents, customerId }) {
  if (!pool) return false;
  const { rowCount } = await pool.query(
    `UPDATE order_deposits
     SET credited_cents = $3::int, pending_delta_cents = $3::int - $2::int, customer_id = $4,
         state = 'in_progress', message = NULL, state_changed_at = now(), updated_at = now()
     WHERE shopify_order_id = $1 AND credited_cents = $2::int AND state IN ('ok', 'needs_review')`,
    [shopifyOrderId, expectedCents, newCents, customerId],
  );
  return rowCount > 0;
}

// The Shopify call succeeded: the claimed amount stands.
async function finishOrderDepositChange(shopifyOrderId) {
  if (!pool) return;
  await pool.query(
    `UPDATE order_deposits
     SET state = 'ok', pending_delta_cents = NULL, message = NULL, state_changed_at = now(), updated_at = now()
     WHERE shopify_order_id = $1 AND state = 'in_progress'`,
    [shopifyOrderId],
  );
}

// Shopify definitely did NOT make the change: undo the claim. The row is
// left unfrozen ('needs_review') so the next event or sweep tries again.
async function releaseOrderDepositChange(shopifyOrderId, message) {
  if (!pool) return;
  await pool.query(
    `UPDATE order_deposits
     SET credited_cents = credited_cents - pending_delta_cents, pending_delta_cents = NULL,
         state = 'needs_review', message = $2, state_changed_at = now(), updated_at = now()
     WHERE shopify_order_id = $1 AND state = 'in_progress'`,
    [shopifyOrderId, String(message || "").slice(0, 500)],
  );
}

// Freezes the row with the claim still in place, for a person to settle:
//   'unknown'  Shopify may or may not have made the change
//   'blocked'  Shopify refused, and trying again on its own won't help
async function freezeOrderDepositChange(shopifyOrderId, state, message) {
  if (!pool) return;
  if (state !== "unknown" && state !== "blocked") throw new Error(`Can't freeze a deposit row as '${state}'`);
  await pool.query(
    `UPDATE order_deposits
     SET state = $2, message = $3, state_changed_at = now(), updated_at = now()
     WHERE shopify_order_id = $1 AND state = 'in_progress'`,
    [shopifyOrderId, state, String(message || "").slice(0, 500)],
  );
}

// Raises or clears a note for staff on a row that isn't mid-change. No money
// moves; credited_cents is untouched.
async function setOrderDepositNote(shopifyOrderId, message) {
  if (!pool) return;
  await pool.query(
    `UPDATE order_deposits
     SET state = CASE WHEN $2::text IS NULL THEN 'ok' ELSE 'needs_review' END,
         message = $2::text, updated_at = now()
     WHERE shopify_order_id = $1 AND state IN ('ok', 'needs_review')`,
    [shopifyOrderId, message == null ? null : String(message).slice(0, 500)],
  );
}

// A person has looked and settled a frozen row. `keep: true` accepts the
// claimed amount as final; `keep: false` undoes the claim so the change can
// be attempted again. Returns the row as it was before settling (so the
// caller can write the ledger), or null if the row wasn't frozen.
async function settleFrozenOrderDeposit(shopifyOrderId, { keep }) {
  if (!pool) return null;
  const before = await getOrderDeposit(shopifyOrderId);
  if (!before) return null;
  // Guarded by the values just read, so two people pressing different
  // buttons at once can't both be applied.
  const { rowCount } = await pool.query(
    `UPDATE order_deposits
     SET credited_cents = CASE WHEN $2::boolean THEN credited_cents ELSE credited_cents - COALESCE(pending_delta_cents, 0) END,
         pending_delta_cents = NULL, state = 'ok', message = NULL, state_changed_at = now(), updated_at = now()
     WHERE shopify_order_id = $1 AND ${FROZEN_FOR_STAFF}
       AND state = $3 AND credited_cents = $4::int AND COALESCE(pending_delta_cents, 0) = $5::int`,
    [shopifyOrderId, Boolean(keep), before.state, before.credited_cents, before.pending_delta_cents || 0],
  );
  return rowCount > 0 ? before : null;
}

async function recordStoreCreditLedger({
  shopifyOrderId,
  customerId,
  deltaCents,
  outcome,
  shopifyTransactionId,
  detail,
}) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO store_credit_ledger (shopify_order_id, customer_id, delta_cents, outcome, shopify_transaction_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      shopifyOrderId,
      customerId || null,
      deltaCents,
      outcome,
      shopifyTransactionId || null,
      detail ? String(detail).slice(0, 500) : null,
    ],
  );
}

// For the staff page: anything waiting on a person first, then newest.
async function getRecentOrderDeposits() {
  if (!pool) return [];
  const { rows } = await pool.query(`
    SELECT *, (state = 'in_progress' AND state_changed_at < now() - make_interval(secs => ${STUCK_AFTER_SECONDS})) AS stuck
    FROM order_deposits
    ORDER BY (state <> 'ok') DESC, created_at DESC
    LIMIT 100
  `);
  return rows;
}

// ---- Login tokens --------------------------------------------------------------

async function createLoginToken(token, email, expiresAt) {
  if (!pool) return;
  await pool.query(`INSERT INTO login_tokens (token, email, expires_at) VALUES ($1, $2, $3)`, [
    hashToken(token),
    email,
    expiresAt,
  ]);
}

// Atomically marks a token used and returns its email, but only if it
// exists, hasn't been used yet, and hasn't expired. Returns null otherwise.
async function consumeLoginToken(token) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `UPDATE login_tokens SET used_at = now()
     WHERE token = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING email`,
    [hashToken(token)],
  );
  return rows[0] ? rows[0].email : null;
}

module.exports = {
  pool,
  initSchema,
  logVoicemail,
  getOpenVoicemails,
  markResolved,
  getResolvedAt,
  recordDepositCreated,
  markDepositPaid,
  recordDepositOrder,
  recordDepositOrderError,
  recordHelcimDepositCreated,
  findRecentHelcimDeposit,
  getDepositByInvoiceNumber,
  markDepositPaidByInvoiceNumber,
  recordHelcimDepositOrder,
  recordHelcimDepositOrderError,
  getRecentDeposits,
  getOrderDeposit,
  upsertOrderDeposit,
  markOrderDepositSynced,
  claimOrderDepositChange,
  finishOrderDepositChange,
  releaseOrderDepositChange,
  freezeOrderDepositChange,
  setOrderDepositNote,
  settleFrozenOrderDeposit,
  recordStoreCreditLedger,
  getRecentOrderDeposits,
  createLoginToken,
  consumeLoginToken,
};
