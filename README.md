# OpenAgent

Self-evolving personal AI assistant — Python + FastAPI.

## Quick Start

```bash
# Setup Python environment
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e .

# Configure (edit openagent.json or set env vars)
export ANTHROPIC_API_KEY="sk-ant-..."
# or
export OPENAI_API_KEY="sk-..."

# Start interactive chat
python -m src chat

# Or start the gateway server
python -m src gateway
```

## Commands

```bash
python -m src gateway           # Start HTTP + WebSocket server
python -m src chat              # Interactive REPL chat
python -m src chat --verbose    # Chat with tool call visibility
python -m src agent -m "msg"    # One-shot message
python -m src doctor            # Check configuration
python -m src status            # Show running server status
```

## Architecture

```
src/
  agents/              # Agent loop, engine, context, subagent
  models/              # LLM providers (OpenAI, Anthropic, ByteDance, Claude Code)
  tools/               # Tool registry
    builtins/           # Built-in tools (shell, file_ops, memory, cron, etc.)
  gateway/             # FastAPI HTTP + WebSocket server
    routers/            # API route modules
    app.py              # App factory + lifecycle hooks
  evolution/           # Self-evolution (memory, skills, reflection, consolidation)
  channels/            # Channel adapters (webchat, feishu)
  background/          # Cron, heartbeat, outbox services
  sessions/            # SQLite session persistence
  config/              # Pydantic v2 configuration
  middleware/          # Auth, idempotency
  queue/               # Async job queue
  utils/               # Logger, audit
  types.py             # Shared type definitions
  cli.py               # Typer CLI entry point

user-space/
  memory/               # Agent memory (SOUL.md, USER.md, WORLD.md)
  skills/               # Dynamic skill scripts (*.skill.py)
  workspace/            # Agent working directory
```

## Self-Evolution

The agent can evolve itself in three layers:

1. **Memory** (SOUL.md/USER.md/WORLD.md) — Learn preferences, accumulate knowledge
2. **Skills** (user-space/skills/*.skill.py) — Create new tools via dynamic import
3. **Code** (restricted self_modify) — Modify source files within safety boundaries

## Web UI

Visit `http://127.0.0.1:19090` after starting the gateway. The SPA includes:

- **Chat** — Real-time streaming chat with the agent
- **Settings** — Schema-driven configuration editor
- **Memory** — View/edit agent memory files
- **Skills** — List loaded dynamic skills
- **Status** — System health, tools, sessions

## Tech Stack

- **Runtime**: Python 3.11+
- **HTTP/WS**: FastAPI + Uvicorn
- **LLM**: OpenAI + Anthropic SDKs
- **Validation**: Pydantic v2
- **Database**: aiosqlite (SQLite WAL)
- **CLI**: Typer
