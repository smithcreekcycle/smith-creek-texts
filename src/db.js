const { Pool } = require("pg");

const pool = process.env.DATABASE_URL
  ? new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: { rejectUnauthorized: false },
  })
    : null;

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
                                                      );
                                                        `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS thread_status (
              phone_number TEXT PRIMARY KEY,
                    resolved_at TIMESTAMPTZ
                        );
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
                                                                                    );
                                                                                      `);
    // Single-use magic-link login tokens. Rows are cheap to accumulate; we
  // don't bother pruning old ones since the table will stay tiny.
  await pool.query(`
      CREATE TABLE IF NOT EXISTS login_tokens (
            token TEXT PRIMARY KEY,
                  email TEXT NOT NULL,
                        expires_at TIMESTAMPTZ NOT NULL,
                              used_at TIMESTAMPTZ,
                                    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                                        );
                                          `);
}

async function logVoicemail({ callSid, from, to, recordingUrl, durationSeconds }) {
    if (!pool) return;
    await pool.query(
          `INSERT INTO calls (call_sid, from_number, to_number, recording_url, duration_seconds)
               VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (call_sid) DO UPDATE SET recording_url = EXCLUDED.recording_url, duration_seconds = EXCLUDED.duration_seconds`,
          [callSid, from, to, recordingUrl, durationSeconds]
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
          [phoneNumber]
        );
}

async function getResolvedAt(phoneNumber) {
    if (!pool) return null;
    const { rows } = await pool.query(
          `SELECT resolved_at FROM thread_status WHERE phone_number = $1`,
          [phoneNumber]
        );
    return rows[0] && rows[0].resolved_at ? rows[0].resolved_at : null;
}

async function recordDepositCreated({ stripeSessionId, phone, amountCents, currency, note }) {
    if (!pool) return;
    await pool.query(
          `INSERT INTO deposits (stripe_session_id, phone, amount_cents, currency, note)
               VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (stripe_session_id) DO NOTHING`,
          [stripeSessionId, phone, amountCents, currency, note || null]
        );
}

// Marks a deposit paid, but only transitions it out of a non-paid status -
// the WHERE clause makes this safe to call twice. Returns true only the
// first time (when it actually flipped the status), so callers can use that
// to decide whether to go on and create a Shopify order. Stripe explicitly
// documents that webhooks can be delivered more than once for the same
// event, so this is a real scenario, not just theoretical: without this
// guard, a redelivered "checkout.session.completed" event would create a
// second Shopify order for the same payment.
async function markDepositPaid(stripeSessionId, { amountCents, currency }) {
    if (!pool) return false;
    const { rowCount } = await pool.query(
          `UPDATE deposits SET status = 'paid', paid_at = now(), amount_cents = $2, currency = $3
               WHERE stripe_session_id = $1 AND status <> 'paid'`,
          [stripeSessionId, amountCents, currency]
        );
    return rowCount > 0;
}

async function recordDepositOrder(stripeSessionId, { shopifyOrderId, shopifyOrderName }) {
    if (!pool) return;
    await pool.query(
          `UPDATE deposits SET shopify_order_id = $2, shopify_order_name = $3 WHERE stripe_session_id = $1`,
          [stripeSessionId, shopifyOrderId, shopifyOrderName]
        );
}

async function recordDepositOrderError(stripeSessionId, message) {
    if (!pool) return;
    await pool.query(
          `UPDATE deposits SET status = 'order_failed', error_message = $2 WHERE stripe_session_id = $1`,
          [stripeSessionId, message]
        );
}

async function getRecentDeposits() {
    if (!pool) return [];
    const { rows } = await pool.query(
          `SELECT * FROM deposits ORDER BY created_at DESC LIMIT 100`
        );
    return rows;
}

async function createLoginToken(token, email, expiresAt) {
    if (!pool) return;
    await pool.query(
          `INSERT INTO login_tokens (token, email, expires_at) VALUES ($1, $2, $3)`,
          [token, email, expiresAt]
        );
}

// Atomically marks a token used and returns its email, but only if it
// exists, hasn't been used yet, and hasn't expired. Returns null otherwise.
async function consumeLoginToken(token) {
    if (!pool) return null;
    const { rows } = await pool.query(
          `UPDATE login_tokens SET used_at = now()
               WHERE token = $1 AND used_at IS NULL AND expires_at > now()
                    RETURNING email`,
          [token]
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
    getRecentDeposits,
    createLoginToken,
    consumeLoginToken,
};
