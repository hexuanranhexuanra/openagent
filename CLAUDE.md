# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Setup
python3.11 -m venv .venv && source .venv/bin/activate
pip install -e .

# Run
python -m src gateway           # Start HTTP + WebSocket server
python -m src chat              # Interactive REPL chat
python -m src chat --verbose    # Chat with tool call visibility
python -m src agent -m "message"  # One-shot message
python -m src doctor            # Check configuration
python -m src status            # Show running server status
```

There are no test scripts defined yet. Type-checking can be run via `mypy src/` (not configured).

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

Gateway defaults to `http://127.0.0.1:19090`. Config schema is defined in `src/config/schema.py` (Pydantic v2).

**ByteDance GenAI** is auto-detected when `OPENAI_QUERY_AK` is set and `OPENAI_BASE_URL` contains `byteintl.net` or `tiktok-row.org` — it uses a separate provider (`ByteDanceGenAIProvider`).

## Architecture

Python 3.11+ backend using FastAPI + Uvicorn.

### Request Flow

**Sync path** (WebSocket / `POST /api/chat`): Request → `run_agent()` → LLM provider → stream events back.

**Async path** (`POST /api/chat/async`, Feishu webhook): Request → `enqueue_message()` → asyncio.Queue worker → `run_agent()` → stream events via callback.

### Core Agent Loop (`src/agents/`)

`run_agent(channel, peer_id, message)` is an async generator that:
1. Gets or creates a SQLite-persisted session keyed by `channel:peer_id`
2. Builds system prompt by prepending SOUL/USER/WORLD memory files
3. Runs up to `max_tool_rounds` (10) iterations of: LLM stream → collect tool calls → execute tools → append results
4. After completion, triggers async `reflect_on_conversation()` for self-evolution

Key modules:
- `stream_agent.py` — ReAct loop with loop detection
- `engine.py` — Task lifecycle (start/cancel/track) with `asyncio.Event` for cancellation
- `context.py` — System prompt builder with memory/skills/identity sections
- `loop_detector.py` — SHA256-based repeat/ping-pong detection with circuit breaker
- `init.py` — Bootstrap: register tools, select provider, load skills

### LLM Providers (`src/agents/providers/`)

Four providers sharing the `LLMProvider` base class:
- `OpenAIProvider` — standard OpenAI-compatible (used for most deployments)
- `AnthropicProvider` — direct Anthropic SDK (supports setup_token OAuth)
- `ByteDanceGenAIProvider` — ByteDance's Responses API (ak-param auth)
- `ClaudeCodeProvider` — delegates to Claude Code CLI subprocess

Provider selection logic is in `init_agent()` with auto-detection for ByteDance.

### Tool System (`src/agents/tools/`)

- `registry.py` — global `dict[name, ToolHandler]` singleton; `register_tool`, `execute_tool`, `get_all_tool_definitions`
- Built-in tools (in `builtin/`): `datetime`, `web_search`, `shell`, `file_ops` (read/write/list in `user-space/workspace/`), `read_config`, `write_config`, `evolution_tools` (memory read/write/update, skill_create, self_modify, sessions_spawn), `memory` (per-peer isolated), `cron`, `heartbeat`
- Dynamic skills: Python files in `user-space/skills/*.skill.py`, loaded via `SkillLoader` at startup. Skills must have a module-level `skill` dict + async `execute` function. Registered as `skill_<name>`.

### Self-Evolution System (`src/evolution/`)

Four evolution layers:
1. **Memory** (`memory.py`) — `MemoryStore` reads/writes `user-space/memory/{SOUL,USER,WORLD}.md`. `update_section` replaces markdown sections; `append_entry` adds timestamped log entries.
2. **Skills** (`skill_loader.py`) — `SkillLoader` dynamically imports `*.skill.py` files via `importlib.util`. Supports hot-reload and skill creation.
3. **Self-modify** (`self_modify.py`) — Restricted source-code modifications with allowlist/denylist, backup, and AST validation.
4. **Reflection** (`reflection.py`) — Post-conversation analysis that updates memory asynchronously.
5. **Consolidation** (`consolidation.py`) — Context window management: summarizes old messages when tokens exceed 65% of context window.

### Gateway (`src/gateway/`)

FastAPI app (`src/gateway/app.py`) with:
- `GET /ws` — WebSocket (streaming agent events to browser)
- `POST /api/chat` — Sync chat
- `POST /api/chat/async` — Async chat (enqueued)
- `POST /api/webhook/feishu` — Feishu/Lark event webhook
- `POST /api/webhook/generic` — Generic webhook
- `GET /api/sessions`, `POST /api/sessions/:id/reset` — Session management
- `GET /api/tools` — List registered tools
- `GET|PUT /api/config` — Config read/write (masked API keys on GET)
- `GET /api/config/schema` — JSON Schema for the config UI
- `GET /api/memory/:file`, `GET /api/skills` — Evolution data
- `GET /api/cron/jobs`, `POST /api/cron/jobs` — Cron management
- `GET /api/heartbeat`, `POST /api/heartbeat/tick` — Heartbeat
- `GET /` — Unified SPA (webchat + settings + memory + skills + status)

Auth: Bearer token on `/api/*` except `/api/webhook/*` and `/api/health`.

### Sessions (`src/sessions/manager.py`)

SQLite via `aiosqlite`. Session ID is `channel:peer_id`. Messages stored as JSON array, trimmed to `max_history_messages` (default 50) on each append. WAL mode enabled.

### Channels (`src/channels/`)

- `base.py` — `Channel` protocol definition
- `manager.py` — Channel lifecycle and outbound dispatch
- `gateway_adapter.py` — Bridges channels to agent with per-session serialization
- `feishu_ws.py` — Feishu WebSocket long connection (lark-oapi)
- `feishu_api.py` — Feishu REST API calls (tenant token, send/reply)
- `message_queue.py` — Dual asyncio.Queue for inbound/outbound

### Background Services (`src/background/`)

- `cron.py` — 5-field cron parser with scheduled agent task execution
- `heartbeat.py` — Periodic HEARTBEAT.md task processing (30min interval)
- `outbox.py` — Proactive message routing to channels

### Queue (`src/queue/worker.py`)

asyncio.Queue-based job processing (no external dependencies). Concurrency: 2 workers.

### Middleware (`src/middleware/`)

- `auth.py` — Bearer token verification (FastAPI dependency) + Feishu signature verification
- `idempotency.py` — TTL-based event dedup store (5 min default)

### Project Layout

```
src/                        # Python backend package
  agents/                   # Agent loop, engine, context, subagent
  models/                   # LLM providers (OpenAI, Anthropic, ByteDance, Claude Code)
  tools/                    # Tool registry
    builtins/               # Built-in tools (shell, file_ops, cron, memory, etc.)
  gateway/                  # FastAPI application
    routers/                # API route modules
    app.py                  # App factory + lifecycle hooks
    websocket.py            # WebSocket handler
    ui.py                   # SPA HTML
  config/                   # Pydantic config schema and loader
  sessions/                 # SQLite session manager
  evolution/                # Memory, skills, reflection, consolidation
  channels/                 # Channel abstractions (feishu, webchat)
  background/               # Cron, heartbeat, outbox services
  middleware/               # Auth, idempotency
  queue/                    # Async job queue
  utils/                    # Logger, audit
  types.py                  # Shared type definitions
  cli.py                    # Typer CLI entry point
user-space/
  memory/                   # SOUL.md, USER.md, WORLD.md, HEARTBEAT.md
  skills/                   # *.skill.py — dynamic agent-created tools
  workspace/                # Agent working directory for file ops
  cron/                     # Cron job definitions (jobs.json)
data/
  openagent.db              # SQLite (sessions)
  audit/                    # Daily audit JSONL logs
```
