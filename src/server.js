require("dotenv").config();
const express = require("express");
const { getAccessToken } = require("./shopify");

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

app.listen(PORT, () => {
    console.log(`Smith Creek Texts listening on port ${PORT}`);
});
