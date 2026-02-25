# OpenAgent: From 0 to 1

Step-by-step guide to initialize and run your own self-evolving AI agent.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Bun | 1.1+ | `curl -fsSL https://bun.sh/install \| bash` |
| PM2 | 5+ | `npm install -g pm2` (optional, for daemon mode) |
| ngrok or cloudflared | latest | For exposing webhooks to Feishu/Telegram |

You also need at least one LLM API key:
- **OpenAI**: Get a key at [platform.openai.com](https://platform.openai.com)
- **Anthropic**: Get a key at [console.anthropic.com](https://console.anthropic.com)

---

## Step 1: Clone and Install

```bash
cd /path/to/your/workspace
git clone <your-repo-url> openagent
cd openagent
bun install
```

## Step 2: Configure

You have three ways to configure OpenAgent (all are equivalent):

### Option A: Environment File (quickest)

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
# Pick one provider (at minimum)
OPENAI_API_KEY=sk-your-key-here
DEFAULT_PROVIDER=openai

# Or use Anthropic
# ANTHROPIC_API_KEY=sk-ant-your-key-here
# DEFAULT_PROVIDER=anthropic
```

### Option B: JSON Config File

Create `openagent.json` in the project root:

```json
{
  "agent": {
    "defaultProvider": "anthropic"
  },
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant-your-key"
    }
  }
}
```

### Option C: Web Config UI

Start the gateway first (Step 3), then open `http://localhost:18789/config` in your browser. The UI auto-generates forms from the JSON Schema — every config field is editable visually.

## Step 3: Verify Setup

```bash
bun run doctor
```

Expected output:

```
  🩺 OpenAgent Doctor

  Bun:       1.x.x
  Config:    loaded
  Provider:  openai
  API Key:   set (sk-xxxx...)
  SOUL.md    ✓
  USER.md    ✓
  WORLD.md   ✓
  PM2:       5.x.x
```

If "API Key" shows "NOT SET", go back to Step 2.

## Step 4: Start the Gateway

```bash
# Development mode (auto-reload on code changes)
bun run dev

# Or production mode
bun run start
```

Output:

```
  🤖 OpenAgent Gateway
  ─────────────────────────────────
  HTTP    http://127.0.0.1:18789
  WS      ws://127.0.0.1:18789/ws
  WebChat http://127.0.0.1:18789/
  ─────────────────────────────────
  Provider: openai
  PID:      12345
```

Your agent is now running. Open:
- `http://localhost:18789/` — **WebChat** (talk to your agent)
- `http://localhost:18789/config` — **Settings UI** (configure everything visually)

## Step 5: Talk to Your Agent

### Via WebChat (browser)

Open `http://localhost:18789/` and start chatting.

### Via CLI (interactive REPL)

```bash
bun run chat
```

Slash commands inside the REPL:
| Command | Description |
|---------|-------------|
| `/tools` | List available tools |
| `/memory` | Show memory file sizes |
| `/skills` | List loaded dynamic skills |
| `/reset` | Clear session history |
| `/exit` | Quit |

### Via CLI (one-shot)

```bash
bun run agent -- -m "What is the weather today?"
```

### Via HTTP API

```bash
# Synchronous (waits for full response)
curl -X POST http://localhost:18789/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!"}'

# Asynchronous (queued, returns taskId)
curl -X POST http://localhost:18789/api/chat/async \
  -H "Content-Type: application/json" \
  -d '{"message": "Summarize today news", "channel": "api"}'
```

---

## Step 6: Connect a Channel (Optional)

### Feishu Bot

See [docs/feishu-setup.md](./feishu-setup.md) for full setup.

Quick version:

1. Create a bot at [open.feishu.cn/app](https://open.feishu.cn/app)
2. Set env vars: `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_ENCRYPT_KEY`, `LARK_VERIFICATION_TOKEN`
3. Expose gateway: `ngrok http 18789`
4. Set webhook URL: `https://xxxx.ngrok-free.app/api/webhook/feishu/webhook`

### Telegram Bot (planned)

Set `TELEGRAM_BOT_TOKEN` in `.env` and enable in config.

---

## Step 7: Daemon Mode (Production)

Use PM2 to run gateway + worker as background processes:

```bash
# Start
bun run daemon

# Monitor
bun run daemon:monit

# View logs
bun run daemon:logs

# Restart
bun run daemon:restart

# Stop
bun run daemon:stop
```

---

## Architecture Overview

```
┌─────────────┐    ┌──────────────┐    ┌────────────┐
│  Feishu Bot  │───>│              │    │            │
│  WebChat UI  │───>│   Gateway    │───>│  Bunqueue   │───> Worker ───> Agent (LLM)
│  Telegram    │───>│  (Hono HTTP) │    │  (Task Q)  │        │
│  HTTP API    │───>│              │    │            │        ▼
└─────────────┘    └──────┬───────┘    └────────────┘    Tools + Memory
                          │
                   /api/config/schema
                          │
                   ┌──────▼───────┐
                   │  Config UI   │  ← JSON Schema + uiHints
                   │  (auto-gen)  │    drive all form fields
                   └──────────────┘
```

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Gateway** | Hono HTTP server — handles webhooks, API, WebSocket, config UI |
| **Worker** | Separate process consuming the Bunqueue task queue |
| **Agent** | LLM runner with tool calling loop and streaming |
| **Session** | Per-user conversation history (channel + peerId) |
| **Memory** | `SOUL.md`, `USER.md`, `WORLD.md` — agent's persistent knowledge |
| **Skills** | Dynamic `.skill.ts` files hot-loaded at runtime |
| **Self-Modify** | Agent can edit its own code within safety boundaries |
| **Reflection** | Post-conversation analysis to update `USER.md` automatically |
| **Plugin Manifest** | `openagent.plugin.json` — declares channels, tools, config schemas |

---

## Config System

### How It Works

```
  Zod Schema (schema.ts)
       │
       ▼
  zodToJsonSchema() ──> JSON Schema
       │
       + uiHints (json-schema.ts)
       │
       ▼
  GET /api/config/schema ──> { schema, uiHints }
       │
       ▼
  Config UI (config-ui.ts) renders forms dynamically
```

### Adding a New Config Section

1. Add to the Zod schema in `src/config/schema.ts`:

```typescript
export const configSchema = z.object({
  // ... existing ...
  myNewFeature: z.object({
    enabled: z.boolean().default(false),
    apiKey: z.string().default(""),
  }).default({}),
});
```

2. Add uiHints in `src/config/json-schema.ts`:

```typescript
const UI_HINTS: UiHints = {
  // ... existing ...
  "myNewFeature": { label: "My Feature", order: 8, group: "core" },
  "myNewFeature.enabled": { label: "Enabled" },
  "myNewFeature.apiKey": { label: "API Key", sensitive: true, placeholder: "key-..." },
};
```

3. The config UI auto-generates the form — no HTML changes needed.

### Plugin Manifest (`openagent.plugin.json`)

External plugins can declare their config requirements:

```json
{
  "id": "my-plugin",
  "channels": [{
    "id": "slack",
    "label": "Slack",
    "configSchema": {
      "type": "object",
      "properties": {
        "enabled": { "type": "boolean", "default": false },
        "botToken": { "type": "string" },
        "signingSecret": { "type": "string" }
      }
    },
    "uiHints": {
      "botToken": { "label": "Bot Token", "sensitive": true },
      "signingSecret": { "label": "Signing Secret", "sensitive": true }
    }
  }]
}
```

---

## File Structure

```
openagent/
├── .env.example              # Environment variable template
├── openagent.json            # Runtime config (created on first save)
├── openagent.plugin.json     # Plugin manifest (channels, tools, schemas)
├── package.json
├── pm2.config.cjs            # PM2 daemon config
├── tsconfig.json
│
├── docs/
│   ├── getting-started.md    # This file
│   └── feishu-setup.md       # Feishu channel setup guide
│
├── user-space/
│   ├── memory/               # Agent's persistent memory
│   │   ├── SOUL.md           #   Identity, personality, capabilities
│   │   ├── USER.md           #   Learned user preferences
│   │   └── WORLD.md          #   General knowledge, project context
│   └── skills/               # Dynamic .skill.ts files
│       └── example-hello.skill.ts
│
└── src/
    ├── index.ts              # CLI entry point
    ├── worker.ts             # Queue worker process
    ├── agent.ts              # (re-export)
    ├── audit.ts              # Audit logging
    ├── logger.ts             # Structured logger
    │
    ├── config/
    │   ├── schema.ts         # Zod config schema (source of truth)
    │   ├── json-schema.ts    # Zod → JSON Schema + uiHints converter
    │   └── index.ts          # Config loader (file + env merge)
    │
    ├── agent/
    │   ├── index.ts          # Agent runner (LLM + tools loop)
    │   ├── providers/        # LLM provider adapters
    │   │   ├── base.ts
    │   │   ├── openai.ts
    │   │   └── anthropic.ts
    │   └── tools/
    │       ├── registry.ts   # Tool registration
    │       └── builtin/      # Built-in tools
    │
    ├── channels/
    │   ├── feishu.ts         # Feishu webhook handler
    │   ├── feishu-api.ts     # Feishu API client (token, send, reply)
    │   ├── webchat.ts        # WebChat channel
    │   └── manager.ts        # Channel manager
    │
    ├── gateway/
    │   ├── server.ts         # Hono server setup
    │   ├── routes.ts         # API routes (/api/*)
    │   ├── config-ui.ts      # Schema-driven config UI
    │   ├── webchat-ui.ts     # WebChat frontend
    │   └── websocket.ts      # WebSocket handler
    │
    ├── evolution/
    │   ├── memory.ts         # SOUL/USER/WORLD reader/writer
    │   ├── skill-loader.ts   # Dynamic .skill.ts hot-loader
    │   ├── self-modify.ts    # Safe code self-modification
    │   └── reflection.ts     # Post-conversation learning
    │
    ├── sessions/
    │   └── manager.ts        # Session store
    │
    └── middleware/
        ├── auth.ts           # Bearer + Lark signature verification
        └── idempotency.ts    # Event deduplication
```

---

## Common Tasks

### Add a new LLM provider

1. Create `src/agent/providers/my-provider.ts` implementing the base interface
2. Add config in `schema.ts` under `providers`
3. Add uiHints in `json-schema.ts`
4. Register in `src/agent/index.ts`

### Add a new tool

1. Create `src/agent/tools/builtin/my-tool.ts`
2. Register in `src/agent/index.ts` via `registerTool()`

### Create a dynamic skill

```bash
cat > user-space/skills/my-skill.skill.ts << 'EOF'
export const skill = {
  name: "my_skill",
  description: "Does something useful",
  parameters: { type: "object", properties: { input: { type: "string" } } },
  handler: async (args: { input: string }) => {
    return JSON.stringify({ result: "Processed: " + args.input });
  },
};
EOF
```

Skills are hot-loaded — no restart needed.

### Add a new channel

1. Create `src/channels/my-channel.ts` (webhook handler)
2. Add config section in `schema.ts`
3. Add uiHints in `json-schema.ts`
4. Wire in `routes.ts`
5. Add delivery handler in `worker.ts`
