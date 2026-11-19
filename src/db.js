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

module.exports = { pool, initSchema, logVoicemail, getOpenVoicemails, markResolved, getResolvedAt };
