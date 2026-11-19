const twilio = require("twilio");
const db = require("./db");

function getClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return twilio(sid, token);
}

async function getSmsThreadsNeedingReply() {
  const client = getClient();
  const ourNumber = process.env.TWILIO_PHONE_NUMBER;
  if (!client || !ourNumber) return [];

const [inbound, outbound] = await Promise.all([
  client.messages.list({ to: ourNumber, limit: 200 }),
  client.messages.list({ from: ourNumber, limit: 200 }),
  ]);

const lastByNumber = new Map();

for (const msg of inbound) {
  const key = msg.from;
  const existing = lastByNumber.get(key);
  if (!existing || msg.dateSent > existing.dateSent) {
    lastByNumber.set(key, { dateSent: msg.dateSent, direction: "inbound", body: msg.body });
  }
}
  for (const msg of outbound) {
    const key = msg.to;
    const existing = lastByNumber.get(key);
    if (!existing || msg.dateSent > existing.dateSent) {
      lastByNumber.set(key, { dateSent: msg.dateSent, direction: "outbound", body: msg.body });
    }
  }

const needingReply = [];
  for (const [number, info] of lastByNumber.entries()) {
    if (info.direction !== "inbound") continue;
    const resolvedAt = await db.getResolvedAt(number);
    if (resolvedAt && new Date(resolvedAt) > new Date(info.dateSent)) continue;
    needingReply.push({ channel: "sms", number, lastMessage: info.body, receivedAt: info.dateSent });
  }
  return needingReply;
}

async function getVoicemailsNeedingReply() {
  const voicemails = await db.getOpenVoicemails();
  return voicemails.map(function (v) {
    return {
      channel: "voicemail",
      number: v.from_number,
      lastMessage: v.recording_url,
      receivedAt: v.received_at,
    };
  });
}

async function getAllNeedingReply() {
  const [sms, voicemail] = await Promise.all([
    getSmsThreadsNeedingReply(),
    getVoicemailsNeedingReply(),
    ]);
  return [...sms, ...voicemail].sort(function (a, b) {
    return new Date(b.receivedAt) - new Date(a.receivedAt);
  });
}

module.exports = { getAllNeedingReply };
