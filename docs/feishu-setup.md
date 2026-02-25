# Feishu Bot Setup Guide

Connect your OpenAgent to Feishu (Lark) so users can chat with your agent directly in Feishu.

## Architecture

```
Feishu Cloud  ──webhook POST──>  OpenAgent Gateway  ──queue──>  Worker
                                     ↑                            │
                                     │                            ▼
                                  Feishu API  <──reply──  Agent (LLM + tools)
```

Two reply modes:
- **async** (default): message is queued, worker processes it, then replies via Feishu API. Best for multi-tool/long-running agent tasks.
- **sync**: gateway runs the agent inline and replies in the same HTTP request cycle. Lower latency for simple Q&A.

---

## Step 1: Create a Feishu Bot

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) and log in.
2. Click **Create Custom App**.
3. Fill in app name (e.g. "OpenAgent") and description.
4. After creation, note down:
   - **App ID** (`cli_xxxxxxxx`)
   - **App Secret**

## Step 2: Configure Bot Capabilities

1. In your app's dashboard, go to **Add Capabilities** > enable **Bot**.
2. Go to **Event Subscriptions**:
   - Set the **Request URL** to your public endpoint:
     ```
     https://your-domain.com/api/webhook/feishu/webhook
     ```
   - Add event: `im.message.receive_v1` (Receive messages)
3. Go to **Permissions & Scopes**, add these permissions:
   - `im:message` — Send messages
   - `im:message:send_as_bot` — Send messages as bot
   - `im:message.receive` — Receive messages (if not auto-added)
4. **Publish** the app version (or enable it for testing in your org).

## Step 3: Security Configuration (Optional but Recommended)

1. In **Event Subscriptions** settings:
   - Set **Encrypt Key** — used to verify webhook signatures
   - Note the **Verification Token**

## Step 4: Configure OpenAgent

### Option A: Environment Variables (`.env`)

```bash
cp .env.example .env
```

Edit `.env`:

```env
LARK_APP_ID=cli_xxxxxxxx
LARK_APP_SECRET=your_app_secret_here
LARK_ENCRYPT_KEY=your_encrypt_key_here
LARK_VERIFICATION_TOKEN=your_verification_token_here

# Optional: "sync" for inline reply, "async" for queue-based (default)
FEISHU_REPLY_MODE=async
```

### Option B: Config File (`openagent.json`)

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "cli_xxxxxxxx",
      "appSecret": "your_app_secret_here",
      "encryptKey": "your_encrypt_key_here",
      "verificationToken": "your_verification_token_here"
    }
  }
}
```

### Option C: Config UI

Navigate to `http://localhost:18789/config` and fill in the Feishu fields under the **Channels** tab.

## Step 5: Expose Your Gateway

Feishu needs a public HTTPS URL to send webhook events. Options:

### For Development (ngrok / cloudflared)

```bash
# Using ngrok
ngrok http 18789

# Using cloudflared (recommended)
cloudflared tunnel --url http://localhost:18789
```

Copy the public URL and set it as the webhook URL in Feishu:

```
https://xxxxx.ngrok-free.app/api/webhook/feishu/webhook
```

### For Production

Deploy behind a reverse proxy (Nginx, Caddy) with valid TLS:

```nginx
server {
    listen 443 ssl;
    server_name bot.yourdomain.com;

    ssl_certificate     /etc/ssl/cert.pem;
    ssl_certificate_key /etc/ssl/key.pem;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Step 6: Start OpenAgent

```bash
# Start gateway (foreground)
bun run start

# Or start gateway + worker as daemons via PM2
bun run daemon:start
```

## Step 7: Verify the Webhook

1. In Feishu Open Platform, after entering the Request URL, Feishu will send a **URL Verification** challenge. OpenAgent handles this automatically and responds with the `challenge` value.
2. You should see a success checkmark in the Feishu console.
3. If it fails, check:
   - Gateway is running and reachable from the internet
   - The URL path is correct: `/api/webhook/feishu/webhook`
   - Logs: `bun run start` shows incoming requests

## Step 8: Test the Bot

1. In Feishu, search for your bot by name and start a chat.
2. Send a text message, e.g. "Hello!"
3. The bot should reply with the agent's response.

---

## Troubleshooting

### Bot doesn't reply

1. Check gateway logs for `"Feishu event received"` — confirms webhook is working.
2. Check for `"Feishu reply delivery failed"` — means token or permissions issue.
3. Verify `appId` and `appSecret` are correct (check for typos/extra spaces).
4. Ensure the bot has `im:message` and `im:message:send_as_bot` permissions.
5. Make sure the app version is published/approved in your org.

### "Invalid signature" error

- Ensure `LARK_ENCRYPT_KEY` matches what's configured in Feishu console.
- If you don't need signature verification, leave `encryptKey` empty.

### Duplicate messages

OpenAgent has built-in idempotency based on `event_id`. If you still see duplicates, check if Feishu is sending retries due to slow response (increase timeout or use async mode).

### Group chat

The bot responds to messages in group chats when @mentioned. The `@_user_xxx` mention prefix is automatically stripped from the message text.

---

## API Reference

### Webhook Endpoint

```
POST /api/webhook/feishu/webhook
```

Handles:
- `url_verification` — responds with `{ "challenge": "..." }`
- `im.message.receive_v1` — processes text messages, queues or sync-replies

### Manual Send (via API)

You can also proactively send messages to Feishu users:

```bash
# Send via chat API
curl -X POST http://localhost:18789/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello from API", "peerId": "feishu-user-open-id"}'
```

---

## Configuration Reference

| Variable | Env Var | Config Key | Description |
|----------|---------|------------|-------------|
| App ID | `LARK_APP_ID` | `channels.feishu.appId` | Feishu app identifier |
| App Secret | `LARK_APP_SECRET` | `channels.feishu.appSecret` | Feishu app secret |
| Encrypt Key | `LARK_ENCRYPT_KEY` | `channels.feishu.encryptKey` | Webhook signature key |
| Verification Token | `LARK_VERIFICATION_TOKEN` | `channels.feishu.verificationToken` | Event verification |
| Reply Mode | `FEISHU_REPLY_MODE` | — | `sync` or `async` (default) |
