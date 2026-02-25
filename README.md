# OpenAgent

Self-evolving personal AI assistant — Bun + Hono + TypeScript.

## Quick Start

```bash
# Install dependencies
bun install

# Configure API keys
cp .env.example .env
# Edit .env with your API keys

# Start interactive chat
bun run chat

# Or start the gateway server
bun run start
```

## Commands

```bash
bun run chat          # Interactive REPL chat
bun run chat:verbose  # Chat with tool call visibility
bun run start         # Start gateway server (HTTP + WebSocket)
bun run dev           # Start with hot-reload
bun run doctor        # Check configuration
bun run agent -- -m "your message"  # One-shot message
```

## Architecture

```
src/
  agent/           # Agent runtime (LLM loop + tool execution)
    providers/     # LLM providers (OpenAI, Anthropic)
    tools/         # Tool registry + built-in tools
  evolution/       # Self-evolution engine
    memory.ts      # SOUL/USER/WORLD memory read/write
    skill-loader.ts # Dynamic .skill.ts loading
    self-modify.ts # Source code self-modification (with safety)
    reflection.ts  # Post-conversation learning
  gateway/         # Hono HTTP + WebSocket server
  channels/        # Channel adapters (webchat, feishu, ...)
  sessions/        # SQLite session persistence
  config/          # Zod-validated configuration
  cli/             # CLI (Commander.js + REPL)
  queue/           # Bunqueue task queue

user-space/
  memory/          # Agent memory (SOUL.md, USER.md, WORLD.md)
  skills/          # Dynamic skill scripts (*.skill.ts)
  workspace/       # Agent working directory
```

## Self-Evolution

The agent can evolve itself in three layers:

1. **Memory** (SOUL.md/USER.md/WORLD.md) — Learn preferences, accumulate knowledge
2. **Skills** (user-space/skills/*.skill.ts) — Create new tools via dynamic import
3. **Code** (restricted self_modify) — Modify source files within safety boundaries

## Deployment

```bash
# PM2 daemon mode
bun run daemon        # Start
bun run daemon:stop   # Stop
bun run daemon:logs   # View logs
bun run daemon:monit  # Monitor
```

## Tech Stack

- **Runtime**: Bun
- **HTTP**: Hono
- **LLM**: OpenAI + Anthropic SDKs
- **Queue**: Bunqueue
- **Database**: bun:sqlite
- **Process**: PM2
- **Schema**: Zod
