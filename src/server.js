require("dotenv").config();
const express = require("express");
const { getAccessToken } = require("./shopify");
const twilio = require("twilio");
const db = require("./db");
const needsReply = require("./needsReply");

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => {
    res.type("html").send(`
        <!doctype html>
            <html>
                  <head><title>Smith Creek Texts</title></head>
                        <body style="font-family: sans-serif; max-width: 640px; margin: 60px auto; color: #111;">
                                <h1 style="color:#FF5A1F;">Smith Creek Texts</h1>
                                        <p>The app is deployed and running. This placeholder page will become
                                                the real texting inbox once Twilio is connected.</p>
                                                        <p>Status: <a href="/health">/health</a></p>
                                                              </body>
                                                                  </html>
                                                                    `);
});

app.get("/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
});

// Quick manual check that the Shopify client-credentials grant actually works
// once SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are set as real env vars here.
app.get("/health/shopify", async (_req, res) => {
    try {
          await getAccessToken();
          res.json({ ok: true });
    } catch (err) {
          res.status(500).json({ ok: false, error: err.message });
    }
});

// Twilio posts here whenever a customer texts the shop's number.
// This is the webhook Twilio's console (or Hubtiger's Twilio-connect form)
// should point at once a Twilio number exists: https://<this-app>/webhooks/twilio-sms
app.post("/webhooks/twilio-sms", async (req, res) => {
    const { From, Body, MessageSid } = req.body || {};
    console.log("Incoming SMS", { From, Body, MessageSid });

           // TODO: store the message, notify staff, run automation rules.

           // Relay to Hubtiger so job cards stay in sync (see HUBTIGER_INCOMING_SMS_WEBHOOK_URL).
           const hubtigerUrl = process.env.HUBTIGER_INCOMING_SMS_WEBHOOK_URL;
    if (hubtigerUrl) {
          try {
                  await fetch(hubtigerUrl, {
                            method: "POST",
                            headers: { "Content-Type": "application/x-www-form-urlencoded" },
                            body: new URLSearchParams(req.body || {}),
                  });
          } catch (err) {
                  console.error("Failed to relay to Hubtiger", err.message);
          }
    }

           res.type("text/xml").send("<Response></Response>");
});

// Twilio posts delivery/status updates here.
app.post("/webhooks/twilio-status", (req, res) => {
    console.log("Twilio status callback", req.body);
    res.sendStatus(200);
});

    function escapeHtml(str) {
        return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
        });
    }

// Phone module: toggled with PHONE_MODULE_ENABLED. When off, calls get a
// short message instead of the greeting/voicemail flow.
app.post("/webhooks/twilio-voice", (req, res) => {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();

    if (process.env.PHONE_MODULE_ENABLED !== "true") {
        twiml.say("Sorry, phone support isn't available on this number yet. Please text us instead.");
        twiml.hangup();
        return res.type("text/xml").send(twiml.toString());
    }

    twiml.say("Thanks for calling Smith Creek Cycle. Leave a message after the tone and we will text or call you back.");
    twiml.record({
        action: "/webhooks/twilio-voice-recording",
        maxLength: 120,
        playBeep: true,
    });
    twiml.say("We did not receive a recording. Goodbye.");
    res.type("text/xml").send(twiml.toString());
});

app.post("/webhooks/twilio-voice-recording", async (req, res) => {
    const { CallSid, From, To, RecordingUrl, RecordingDuration } = req.body || {};
    try {
        await db.logVoicemail({
            callSid: CallSid,
            from: From,
            to: To,
            recordingUrl: RecordingUrl ? `${RecordingUrl}.mp3` : null,
            durationSeconds: RecordingDuration ? parseInt(RecordingDuration, 10) : null,
        });
    } catch (err) {
        console.error("Failed to log voicemail", err.message);
    }
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();
    twiml.say("Thanks, we got your message. Goodbye.");
    twiml.hangup();
    res.type("text/xml").send(twiml.toString());
});

// Simple staff-facing screen: who still needs a reply, across SMS and voicemail.
app.get("/inbox/needs-reply", async (_req, res) => {
    try {
        const items = await needsReply.getAllNeedingReply();
        const rows = items.map(function (i) {
            const preview = i.channel === "voicemail"
            ? (i.lastMessage ? `<a href="${escapeHtml(i.lastMessage)}">listen</a>` : "(no recording)")
                : escapeHtml(i.lastMessage || "");
            return `<tr>
            <td>${escapeHtml(i.channel)}</td>
            <td>${escapeHtml(i.number)}</td>
            <td>${new Date(i.receivedAt).toLocaleString()}</td>
            <td>${preview}</td>
            <td>
            <form method="POST" action="/inbox/needs-reply/resolve">
            <input type="hidden" name="number" value="${escapeHtml(i.number)}">
            <button type="submit">Mark handled</button>
            </form>
            </td>
            </tr>`;
        }).join("");

        res.type("html").send(`<!doctype html>
        <html>
        <head><title>Needs Reply - Smith Creek Texts</title></head>
        <body style="font-family: sans-serif; max-width: 900px; margin: 40px auto;">
        <h1 style="color:#FF5A1F;">Needs a reply (${items.length})</h1>
        <p><a href="/">Home</a></p>
        <table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%;">
        <tr><th>Channel</th><th>From</th><th>Received</th><th>Message</th><th></th></tr>
        ${rows}
        </table>
        </body>
        </html>`);
    } catch (err) {
        res.status(500).send(`Failed to load needs-reply list: ${escapeHtml(err.message)}`);
    }
});

app.post("/inbox/needs-reply/resolve", async (req, res) => {
    const { number } = req.body || {};
    try {
        if (number) await db.markResolved(number);
    } catch (err) {
        console.error("Failed to mark resolved", err.message);
    }
    res.redirect("/inbox/needs-reply");
});

db.initSchema().catch(function (err) {
    console.error("Failed to initialize database schema", err.message);
});

app.listen(PORT, () => {
    console.log(`Smith Creek Texts listening on port ${PORT}`);
});
