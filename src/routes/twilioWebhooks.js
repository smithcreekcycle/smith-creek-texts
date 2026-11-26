// Webhooks from Twilio. Twilio's servers call these - not staff, not
// customers - so there's no login and no geo-restriction; every route
// verifies Twilio's request signature instead (security.js).

const express = require("express");
const twilio = require("twilio");
const asyncHandler = require("./asyncHandler");
const security = require("../security");
const { maskPhone } = require("../phone");

// Twilio gives up on a webhook after 15 seconds. Hubtiger gets less than
// that, so a slow relay can never cost us the reply to Twilio.
const HUBTIGER_TIMEOUT_MS = 8_000;

function createTwilioWebhookRouter({ db }) {
  const router = express.Router();
  const verified = security.requireTwilioSignature;

  // A customer texted the shop's number.
  router.post(
    "/webhooks/twilio-sms",
    verified,
    asyncHandler(async (req, res) => {
      const { From, MessageSid } = req.body || {};
      // The message text itself stays out of the logs.
      console.log("Incoming SMS", { from: maskPhone(From), MessageSid });
      // TODO: store the message, notify staff, run automation rules.

      // Relay to Hubtiger so job cards stay in sync.
      const hubtigerUrl = process.env.HUBTIGER_INCOMING_SMS_WEBHOOK_URL;
      if (hubtigerUrl) {
        try {
          const relay = await fetch(hubtigerUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(req.body || {}),
            signal: AbortSignal.timeout(HUBTIGER_TIMEOUT_MS),
          });
          if (!relay.ok) {
            console.error("Hubtiger relay was not accepted", { status: relay.status, MessageSid });
          }
        } catch (err) {
          console.error("Failed to relay to Hubtiger", { error: err.message, MessageSid });
        }
      }
      res.type("text/xml").send("<Response></Response>");
    }),
  );

  // Delivery/status updates for texts we sent.
  router.post("/webhooks/twilio-status", verified, (req, res) => {
    const { MessageSid, MessageStatus, ErrorCode } = req.body || {};
    console.log("Twilio status callback", { MessageSid, MessageStatus, ErrorCode });
    res.sendStatus(200);
  });

  // Phone module: toggled with PHONE_MODULE_ENABLED. When off, callers get a
  // short message instead of the greeting/voicemail flow.
  router.post("/webhooks/twilio-voice", verified, (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    if (process.env.PHONE_MODULE_ENABLED !== "true") {
      twiml.say("Sorry, phone support isn't available on this number yet. Please text us instead.");
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }
    twiml.say(
      "Thanks for calling Smith Creek Cycle. Leave a message after the tone and we will text or call you back.",
    );
    twiml.record({
      action: "/webhooks/twilio-voice-recording",
      maxLength: 120,
      playBeep: true,
    });
    twiml.say("We did not receive a recording. Goodbye.");
    res.type("text/xml").send(twiml.toString());
  });

  router.post(
    "/webhooks/twilio-voice-recording",
    verified,
    asyncHandler(async (req, res) => {
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
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say("Thanks, we got your message. Goodbye.");
      twiml.hangup();
      res.type("text/xml").send(twiml.toString());
    }),
  );

  return router;
}

module.exports = createTwilioWebhookRouter;
