# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install              # Install dependencies
bun run start            # Start gateway server (HTTP + WebSocket)
bun run dev              # Start with hot-reload
bun run chat             # Interactive REPL chat
bun run chat:verbose     # Chat with tool call visibility
bun run agent -- -m "message"  # One-shot message
bun run doctor           # Check configuration

# PM2 daemon mode
bun run daemon           # Start
bun run daemon:stop      # Stop
bun run daemon:logs      # View logs
```

There are no test scripts defined. TypeScript type-checking can be run via `bunx tsc --noEmit`.

## Configuration

Config is loaded from `openagent.json` (in project root) merged with environment variables. Env vars override file config:

| Env Var | Config Path |
|---|---|
| `OPENAI_API_KEY` | `providers.openai.apiKey` |
| `OPENAI_BASE_URL` | `providers.openai.baseUrl` |
| `OPENAI_MODEL` | `providers.openai.model` |
| `OPENAI_QUERY_AK` | `providers.openai.queryParams.ak` |
| `ANTHROPIC_API_KEY` | `providers.anthropic.apiKey` |
| `ANTHROPIC_MODEL` | `providers.anthropic.model` |
| `DEFAULT_PROVIDER` | `agent.defaultProvider` |
| `LARK_APP_ID` / `LARK_APP_SECRET` | `channels.feishu.*` (also auto-enables Feishu) |
| `LARK_ENCRYPT_KEY` / `LARK_VERIFICATION_TOKEN` | `channels.feishu.*` |
| `GATEWAY_PORT` / `GATEWAY_HOST` / `GATEWAY_AUTH_TOKEN` | `gateway.*` |
| `LOG_LEVEL` | `logging.level` |
| `FEISHU_REPLY_MODE` | `sync` or `async` reply mode for Feishu |

Gateway defaults to `http://127.0.0.1:19090`. Config schema is defined in `src/config/schema.ts` (Zod).

**ByteDance GenAI** is auto-detected when `OPENAI_QUERY_AK` is set and `OPENAI_BASE_URL` contains `byteintl.net` or `tiktok-row.org` — it uses a separate provider (`ByteDanceGenAIProvider`).

## Architecture

### Request Flow

**Sync path** (WebSocket / `POST /api/chat`): Request → `runAgent()` → LLM provider → stream events back.

**Async path** (`POST /api/chat/async`, Feishu webhook): Request → `enqueueMessage()` → Bunqueue (embedded SQLite-backed queue) → Worker processes job → `runAgent()` → stream events via callback.

### Core Agent Loop (`src/agent/index.ts`)

`runAgent(channel, peerId, message)` is an async generator that:
1. Gets or creates a SQLite-persisted session keyed by `channel:peerId`
2. Builds system prompt by prepending SOUL/USER/WORLD memory files
3. Runs up to `MAX_TOOL_ROUNDS` (10) iterations of: LLM stream → collect tool calls → execute tools → append results
4. After completion, triggers async `reflectOnConversation()` for self-evolution

### LLM Providers (`src/agent/providers/`)

Three providers sharing the `LLMProvider` base interface:
- `OpenAIProvider` — standard OpenAI-compatible (used for most deployments)
- `AnthropicProvider` — direct Anthropic SDK
- `ByteDanceGenAIProvider` — ByteDance's Responses API (ak-param auth)

Provider selection logic is in `initAgent()` with auto-detection for ByteDance.

### Tool System (`src/agent/tools/`)

- `registry.ts` — global `Map<name, ToolHandler>` singleton; `registerTool`, `executeTool`, `getAllToolDefinitions`
- Built-in tools: `datetime`, `web-search`, `shell`, `file-ops` (read/write/list in `user-space/workspace/`), `evolution-tools` (memory read/write/update, skill_create, self_modify)
- Dynamic skills: TypeScript files in `user-space/skills/*.skill.ts`, loaded via `SkillLoader` at startup. Skills must export a default object with `{ name, description, parameters, execute }`. Registered as `skill_<name>`.

### Self-Evolution System (`src/evolution/`)

Three evolution layers:
1. **Memory** (`memory.ts`) — `MemoryStore` reads/writes `user-space/memory/{SOUL,USER,WORLD}.md`. `updateSection` replaces markdown sections; `appendEntry` adds timestamped log entries.
2. **Skills** (`skill-loader.ts`) — `SkillLoader` dynamically imports `*.skill.ts` files. Supports hot-reload by busting module cache with `?gen=N` query suffix.
3. **Self-modify** (`self-modify.ts`) — Restricted source-code modifications within safety boundaries.
4. **Reflection** (`reflection.ts`) — Post-conversation analysis that updates memory asynchronously.

### Gateway (`src/gateway/`)

Hono app with:
- `GET /ws` — WebSocket (Bun native, streaming agent events to browser)
- `POST /api/chat` — Sync chat
- `POST /api/chat/async` — Async chat (enqueued)
- `POST /api/webhook/feishu/webhook` — Feishu/Lark event webhook
- `POST /api/webhook/generic` — Generic webhook
- `GET /api/sessions`, `POST /api/sessions/:id/reset` — Session management
- `GET /api/tools` — List registered tools
- `GET|PUT /api/config` — Config read/write (masked API keys on GET)
- `GET /api/config/schema` — JSON Schema for the config UI
- `GET /api/memory/:file`, `GET /api/skills` — Evolution data
- `GET /` — Unified SPA (webchat + settings UI)

Auth: Bearer token on `/api/*` except `/api/webhook/*` routes.

### Sessions (`src/sessions/manager.ts`)

SQLite via `bun:sqlite`. Session ID is `channel:peerId`. Messages stored as JSON array, trimmed to `maxHistoryMessages` (default 50) on each append. WAL mode enabled.

### Channels (`src/channels/`)

- `webchat.ts` — WebSocket-based browser chat
- `feishu.ts` — Feishu/Lark webhook handler (challenge verification, event dedup via `idempotencyStore`, sync/async reply modes)
- `feishu-ws.ts` — Feishu WebSocket long connection (no webhook/tunnel needed)
- `feishu-api.ts` — Feishu API calls for sending replies

### Queue (`src/queue/index.ts`)

Bunqueue in embedded mode (no separate Redis). `initQueue` and `initWorker` are both called in the same process for the gateway (co-located). Concurrency: 2 workers.

### User-Space Layout

```
user-space/
  memory/     # SOUL.md, USER.md, WORLD.md
  skills/     # *.skill.ts — agent-created tools
  workspace/  # Agent working directory for file ops
data/
  openagent.db  # SQLite (sessions)
```
