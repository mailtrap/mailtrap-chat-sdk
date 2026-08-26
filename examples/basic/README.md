# Basic Mailtrap Chat SDK example

Inbound acknowledgement / echo bot on Mailtrap Inbound.

For opted-in / inbound conversations only — not cold outreach.

```bash
cp .env.example .env
# fill MAILTRAP_API_TOKEN, MAILTRAP_WEBHOOK_SECRET, FROM_ADDRESS
npm install
npm start
```

Point the Mailtrap Inbound webhook at `http://<host>:3000/webhook` (use a tunnel such as ngrok for local testing).

Uses the production Email API with `category: chat-sdk` on outbound replies — not Sandbox.
