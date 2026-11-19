require("dotenv").config();
const express = require("express");
const { getAccessToken } = require("./shopify");
const twilio = require("twilio");
const db = require("./db");
const needsReply = require("./needsReply");
const stripePayments = require("./stripePayments");
const shopifyOrders = require("./shopifyOrders");
const sms = require("./sms");

const app = express();

// Stripe needs the raw request body to verify its signature, so this route
// is registered before the urlencoded/json body parsers below touch the
// request stream.
app.post(
    "/webhooks/stripe",
    express.raw({ type: "application/json" }),
    async (req, res) => {
        const stripe = stripePayments.getClient();
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
        if (!stripe || !webhookSecret) {
            console.error("Stripe webhook received but Stripe is not configured");
            return res.sendStatus(500);
        }

    let event;
        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                req.headers["stripe-signature"],
                webhookSecret
                );
        } catch (err) {
            console.error("Stripe webhook signature verification failed", err.message);
            return res.sendStatus(400);
        }

    if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        try {
            await handleCheckoutCompleted(session);
        } catch (err) {
            console.error("Failed to handle Stripe checkout completion", err.message);
        }
    }

    res.sendStatus(200);
    }
    );

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
    <p><a href="/inbox/needs-reply">Needs reply</a> &middot; <a href="/payments">Payment links</a></p>
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
            <td><a href="/payments/send?phone=${encodeURIComponent(i.number)}">Send payment link</a></td>
            </tr>`;
        }).join("");

    res.type("html").send(`<!doctype html>
    <html>
    <head><title>Needs Reply - Smith Creek Texts</title></head>
    <body style="font-family: sans-serif; max-width: 900px; margin: 40px auto;">
    <h1 style="color:#FF5A1F;">Needs a reply (${items.length})</h1>
    <p><a href="/">Home</a> &middot; <a href="/payments">Payment history</a></p>
    <table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%;">
    <tr><th>Channel</th><th>From</th><th>Received</th><th>Message</th><th></th><th></th></tr>
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

// Staff-facing form to text a Stripe payment link to a customer.
app.get("/payments/send", (req, res) => {
    const phone = req.query.phone || "";
    res.type("html").send(`<!doctype html>
    <html>
    <head><title>Send Payment Link - Smith Creek Texts</title></head>
    <body style="font-family: sans-serif; max-width: 480px; margin: 60px auto;">
    <h1 style="color:#FF5A1F;">Send a payment link</h1>
    <p><a href="/inbox/needs-reply">Needs reply</a> &middot; <a href="/payments">Payment history</a></p>
    <form method="POST" action="/payments/send">
    <label>Phone number<br>
    <input type="text" name="phone" value="${escapeHtml(phone)}" placeholder="+12505551234" required style="width:100%; padding:8px;">
    </label><br><br>
    <label>Amount (CAD)<br>
    <input type="number" name="amount" step="0.01" min="0.50" placeholder="50.00" required style="width:100%; padding:8px;">
    </label><br><br>
    <label>Note (shows on the receipt, e.g. bike model)<br>
    <input type="text" name="note" placeholder="Trek Fuel EX deposit" style="width:100%; padding:8px;">
    </label><br><br>
    <button type="submit" style="padding:10px 20px; background:#FF5A1F; color:white; border:none; border-radius:4px;">Create &amp; text link</button>
    </form>
    </body>
    </html>`);
});

app.post("/payments/send", async (req, res) => {
    const { phone, amount, note } = req.body || {};
    try {
        const amountCents = Math.round(parseFloat(amount) * 100);
        if (!phone || !amountCents || amountCents < 50) {
            throw new Error("A phone number and an amount of at least $0.50 are required");
        }
        const session = await stripePayments.createDepositCheckout({ phone, amountCents, note });
        await db.recordDepositCreated({
            stripeSessionId: session.id,
            phone,
            amountCents,
            currency: "CAD",
            note: note || "",
        });
        await sms.sendSms(
            phone,
            `Smith Creek Cycle: here's your secure payment link${note ? ` for ${note}` : ""}: ${session.url}`
            );
        res.type("html").send(`<!doctype html>
        <html><body style="font-family: sans-serif; max-width: 480px; margin: 60px auto;">
        <h1 style="color:#FF5A1F;">Link sent</h1>
        <p>Texted a $${(amountCents / 100).toFixed(2)} payment link to ${escapeHtml(phone)}.</p>
        <p><a href="/payments/send">Send another</a> &middot; <a href="/payments">Payment history</a></p>
        </body></html>`);
    } catch (err) {
        res.status(400).send(`<!doctype html>
        <html><body style="font-family: sans-serif; max-width: 480px; margin: 60px auto;">
        <h1 style="color:#c0392b;">Couldn't send link</h1>
        <p>${escapeHtml(err.message)}</p>
        <p><a href="/payments/send">Try again</a></p>
        </body></html>`);
    }
});

app.get("/payments/success", (_req, res) => {
    res.type("html").send(`<!doctype html>
    <html><body style="font-family: sans-serif; max-width: 480px; margin: 60px auto; text-align:center;">
    <h1 style="color:#FF5A1F;">Payment received</h1>
    <p>Thanks! Your payment to Smith Creek Cycle was successful. You will get a receipt shortly.</p>
    </body></html>`);
});

app.get("/payments/cancelled", (_req, res) => {
    res.type("html").send(`<!doctype html>
    <html><body style="font-family: sans-serif; max-width: 480px; margin: 60px auto; text-align:center;">
    <h1>Payment cancelled</h1>
    <p>No charge was made. Contact Smith Creek Cycle if you still need to pay.</p>
    </body></html>`);
});

// Staff-facing history of payment links sent and their Shopify order status.
app.get("/payments", async (_req, res) => {
    try {
        const deposits = await db.getRecentDeposits();
        const rows = deposits.map(function (d) {
            const statusColor = d.status === "paid" ? "#2ecc71" : d.status === "order_failed" ? "#e67e22" : "#999";
            const orderCell = d.shopify_order_name
            ? escapeHtml(d.shopify_order_name)
                : (d.status === "order_failed" ? "needs manual entry" : "-");
            return `<tr>
            <td>${new Date(d.created_at).toLocaleString()}</td>
            <td>${escapeHtml(d.phone)}</td>
            <td>$${(d.amount_cents / 100).toFixed(2)}</td>
            <td>${escapeHtml(d.note || "")}</td>
            <td style="color:${statusColor}; font-weight:bold;">${escapeHtml(d.status)}</td>
            <td>${orderCell}</td>
            </tr>`;
        }).join("");
        res.type("html").send(`<!doctype html>
        <html>
        <head><title>Payments - Smith Creek Texts</title></head>
        <body style="font-family: sans-serif; max-width: 900px; margin: 40px auto;">
        <h1 style="color:#FF5A1F;">Payment links</h1>
        <p><a href="/">Home</a> &middot; <a href="/payments/send">Send a new link</a></p>
        <table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%;">
        <tr><th>Sent</th><th>Phone</th><th>Amount</th><th>Note</th><th>Status</th><th>Shopify order</th></tr>
        ${rows}
        </table>
        </body>
        </html>`);
    } catch (err) {
        res.status(500).send(`Failed to load payments: ${escapeHtml(err.message)}`);
    }
});

// Called from the Stripe webhook once a text-a-payment-link checkout completes.
// Records the payment as paid, then creates a real Shopify order for it (matched
// to an existing customer by phone when possible) so it shows up as a deposit.
async function handleCheckoutCompleted(session) {
    const phone = (session.metadata && session.metadata.phone) || null;
    const note = (session.metadata && session.metadata.note) || "";
    const amountCents = session.amount_total;
    const currency = (session.currency || "cad").toUpperCase();

await db.markDepositPaid(session.id, { amountCents, currency });

try {
    const customer = phone ? await shopifyOrders.findCustomerByPhone(phone) : null;
    const order = await shopifyOrders.createDepositOrder({
        customerId: customer ? customer.id : null,
        amountCents,
        note,
        stripeSessionId: session.id,
    });
    await db.recordDepositOrder(session.id, {
        shopifyOrderId: order.id,
        shopifyOrderName: order.name,
    });
} catch (err) {
    console.error("Failed to create Shopify deposit order", err.message);
    await db.recordDepositOrderError(session.id, err.message);
}
}

db.initSchema().catch(function (err) {
    console.error("Failed to initialize database schema", err.message);
});

app.listen(PORT, () => {
    console.log(`Smith Creek Texts listening on port ${PORT}`);
});
