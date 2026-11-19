# Smith Creek Texts

Smith Creek Cycle's own customer texting app - a standalone inbox tied into
Shopify (customers, orders, pay links) and Hubtiger (workshop job status).

## Status

- Shopify side is done: a Dev Dashboard app ("Smith Creek Texts") is created
-   and installed on the store, with SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET
-     ready to use. src/shopify.js handles the token exchange (24h tokens via
-   client-credentials grant - there's no permanent Admin API token for this
-     app type).
- - This repo is a minimal running skeleton: health check, Twilio webhook
  -   routes, and the Shopify-relay-to-Hubtiger logic for incoming texts. It is
  -     NOT yet the real inbox UI - that's the next build phase once hosting +
  -   Twilio are live.
 
  -   ## Still needed before this is fully "live"
 
  -   1. A Twilio account and a Canadian SMS-capable number. Nothing here works
      2.    without TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER.
      3.2. Point the Twilio number's incoming-SMS webhook at
           https://<this-app's-render-url>/webhooks/twilio-sms once deployed.
        3. Give Hubtiger the same Twilio credentials in their "Connect Text
        4.    Message Platform" form, so their own outbound status texts still send
        5.   (this app's job is just owning the incoming webhook and relaying to
        6.      Hubtiger's job-card endpoint - see HUBTIGER_INCOMING_SMS_WEBHOOK_URL,
        7.     set as a secret env var on Render, never committed here).
        8. 4. A database for the real inbox (message history, staff notes,
           5.    automation rules) - not added yet; Postgres on Render is the natural
           6.   choice when this grows past the skeleton stage.
          
           7.   ## Local dev
          
           8.   ```
                npm install
                cp .env.example .env
                npm start
                ```

                ## Deploying on Render

                This repo includes a render.yaml Blueprint.

                1. New -> Blueprint, point it at this repo.
                2. 2. Render reads render.yaml and creates the smith-creek-texts web
                   3.    service automatically.
                   4.3. Fill in the secret env vars it leaves blank (SHOPIFY_CLIENT_ID,
                        SHOPIFY_CLIENT_SECRET, HUBTIGER_INCOMING_SMS_WEBHOOK_URL, TWILIO_*) in
                        the Render dashboard - they're marked sync: false on purpose so they're
                        never committed to this public repo.
                     
