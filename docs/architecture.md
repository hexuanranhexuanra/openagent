# OpenAgent Architecture

## Overview

OpenAgent is a self-evolving personal AI assistant built with **Bun + Hono + TypeScript**. It uses a frameworkless agent architecture — no LangChain, no LangGraph — implementing the full ReAct loop, tool execution, session management, and multi-channel communication from scratch.

```
                          ┌─────────────────────────────┐
                          │        Gateway (Hono)        │
                          │   HTTP + WebSocket Server    │
                          └──────────┬──────────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
     ┌────────▼────────┐   ┌────────▼────────┐   ┌────────▼────────┐
     │  Channel Layer  │   │  Agent Runtime   │   │ Background Svc  │
     │ Feishu/Telegram │   │ Engine + ReAct   │   │ Cron/Heartbeat  │
     │    /WebChat     │   │                  │   │    /Outbox       │
     └────────┬────────┘   └────────┬────────┘   └────────┬────────┘
              │                     │                      │
              └──────────┬──────────┘──────────────────────┘
                         │
              ┌──────────▼──────────┐
              │   Session + Memory  │
              │  SQLite / Markdown  │
              └─────────────────────┘
```

### Design Principles

1. **No framework dependency.** The ReAct loop is ~180 lines. Tool dispatch is a registry + execute function. Full control and debuggability.
2. **Stateless core, stateful shell.** StreamAgent is a pure function (context in, events out). All state management lives in AgentEngine and SessionManager.
3. **Single-process simplicity.** One Bun process runs everything: HTTP server, WebSocket, agent runtime, background services, channel adapters. No microservices, no message brokers.
4. **Self-evolution by design.** The agent can modify its own memory, create new skills, and (with opt-in) edit its own source code — all through the same tool interface.
5. **Channel-agnostic agent.** The agent runtime has zero knowledge of messaging platforms. Channels are adapters that translate platform-specific protocols to `IncomingMessage` / `OutgoingMessage`.

---

## Agent Runtime

The agent runtime is a three-layer architecture, each layer with a single responsibility:

```
AgentEngine  (Stateful)         — task lifecycle, cancellation, one-task-per-session
    └── StreamAgent (Stateless) — ReAct loop, LLM streaming, tool dispatch
            └── ContextBuilder  — system prompt assembly, tool/memory injection
```

### AgentEngine (`src/agent/engine.ts`)

Stateful singleton that manages the task lifecycle per session.

**Responsibilities:**
- Enforces one-task-per-session: if a new message arrives while a task is running, the previous task is cancelled
- Tracks task state via a simple FSM
- Retains task info for 60 seconds post-completion (for observability via API)
- Fires reflection as a non-blocking background task on success

**Task State Machine:**

```
         startTask()
             │
             ▼
         [running] ──── cancelTask() ──► [cancelled]
             │
        (stream ends)
             │
         (success) ──► [done]  ──► reflection (fire-and-forget)
             │
          (error) ──► [error]
```

**Key API:**

| Method | Description |
|--------|-------------|
| `startTask(channel, peerId, message)` | Returns `AsyncGenerator<AgentStreamEvent>`. Builds context, runs StreamAgent, yields events |
| `cancelTask(channel, peerId)` | Aborts running task via `AbortController`. Returns `false` if no task running |
| `isRunning(channel, peerId)` | Check if a task is active for this session |
| `getTaskInfo(channel, peerId)` | Returns task metadata (status, timing, error) |
| `cancelAll()` | Cancel all running tasks (graceful shutdown) |

**Session identity:** `"${channel}:${peerId}"` — e.g., `"feishu:ou_abc123"`, `"webchat:ws_xyz"`

### StreamAgent (`src/agent/stream-agent.ts`)

Stateless ReAct (Reasoning + Acting) execution engine. Has no knowledge of sessions, channels, or task lifecycle — those are AgentEngine's concern.

**ReAct Loop:**

```
while (round < maxRounds) {
    1. Check abort signal
    2. Fetch session messages from SQLite
    3. Call provider.chat(messages, tools, systemPrompt)     ← streaming
    4. Collect text chunks + tool calls from stream
    5. Append assistant message to session (text + tool_calls)
    6. If no tool calls → break (natural end)
    7. For each tool call:
       a. Parse JSON arguments
       b. Check LoopDetector (warning → append hint, critical → abort)
       c. Execute tool via registry
       d. Truncate result if > 24KB (MAX_TOOL_RESULT_CHARS)
       e. Append tool result message to session
    8. Next round
}
```

**Stream events yielded:**

| Event Type | Fields | When |
|------------|--------|------|
| `progress` | `round`, `maxRounds` | Start of each round |
| `text` | `content` | Each text chunk from LLM |
| `tool_start` | `toolName`, `toolArgs` | Before tool execution |
| `tool_result` | `toolName`, `toolResult` | After tool execution |
| `error` | `error` | Provider error or max rounds exceeded |

**Design properties:**
- **Reusable**: called by AgentEngine (user chat), CronService, HeartbeatService, and subagents
- **Cancellation-aware**: checks `signal.aborted` at round start, between LLM chunks, and between tool calls
- **Does NOT yield the final `done` event** — that is AgentEngine's responsibility
- **Full history per round**: each LLM call includes the complete session message history, so the model maintains full context

### ContextBuilder (`src/agent/context.ts`)

Assembles an immutable `AgentContext` snapshot before each task run.

```typescript
interface AgentContext {
  sessionId: string;        // "channel:peerId"
  channel: string;
  peerId: string;
  depth: number;            // 0 = main agent, >0 = subagent
  systemPrompt: string;     // fully assembled prompt
  tools: ToolDefinition[];  // all available tool definitions
  maxRounds: number;        // from config.agent.maxToolRounds
}
```

**System prompt structure (built dynamically):**

```
┌─────────────────────────────────────┐
│ Identity                            │  ← config.agent.systemPrompt
│ Safety Guidelines                   │  ← hardcoded safety rules
│ Tool Call Style                     │  ← concise instructions
│ Workspace Paths                     │  ← user-space/workspace/
│ Runtime Info                        │  ← OS, shell, model, time
├─────────────────────────────────────┤
│ Skills Catalog (depth=0 only)       │  ← loaded skill descriptions (max 30KB)
│ Memory Recall (depth=0 only)        │  ← instructions for memory use
│ Evolution (depth=0 only)            │  ← self-modification guidance
├─────────────────────────────────────┤
│ Bootstrap Memory Files              │
│   SOUL.md   (always)                │  ← identity, values
│   USER.md   (depth=0 only)          │  ← user preferences
│   WORLD.md  (depth=0 only)          │  ← external knowledge
│   MEMORY.md (depth=0 only)          │  ← long-term summaries
└─────────────────────────────────────┘
```

Subagents (depth > 0) receive a stripped-down prompt without skills, memory, or evolution — keeping them focused and lightweight. Max depth is 3. Each memory file is capped at `bootstrapMaxChars` (8KB), total at `bootstrapTotalMaxChars` (40KB).

---

## LLM Provider Layer

```
LLMProvider (interface)
    ├── AnthropicProvider       — Claude models via @anthropic-ai/sdk
    ├── OpenAIProvider          — GPT models + any OpenAI-compatible API
    ├── ClaudeCodeProvider      — Claude Code CLI as a provider
    └── ByteDanceGenAIProvider  — ByteDance internal models
```

### Provider Interface (`src/agent/providers/base.ts`)

```typescript
interface LLMProvider {
  readonly name: string;
  chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    systemPrompt?: string
  ): AsyncGenerator<StreamChunk>;
}
```

All providers convert OpenAgent's internal message format to the provider-specific API format, stream the response, and yield normalized `StreamChunk` events:

| Chunk Type | Content |
|------------|---------|
| `text` | Incremental text content |
| `tool_call` | Complete tool call object (id, name, arguments) |
| `done` | Completion signal with token usage |
| `error` | Error message |

### Provider Selection (`src/agent/index.ts`)

```
1. setupToken set?                    → AnthropicProvider (OAuth)
2. defaultProvider == "claude-code"?  → ClaudeCodeProvider
3. ByteDance endpoint detected?       → ByteDanceGenAIProvider
4. defaultProvider == "anthropic"?    → AnthropicProvider
5. Default                            → OpenAIProvider
```

---

## Tool System

### Tool Registry (`src/agent/tools/registry.ts`)

A global registry that maps tool names to handlers.

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;  // JSON Schema
}

interface ToolHandler {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<string>;
}
```

| Function | Description |
|----------|-------------|
| `registerTool(handler)` | Add tool to global registry |
| `getTool(name)` | Look up tool by name |
| `getAllToolDefinitions()` | Get all definitions (passed to LLM) |
| `executeTool(name, args)` | Execute tool, return result string. Errors wrapped as JSON |

### Built-in Tools

| Category | Tools | Description |
|----------|-------|-------------|
| **Workspace** | `datetime`, `web_search`, `shell` | Time, search, command execution |
| **File I/O** | `read_file`, `write_file`, `list_files` | File operations in workspace |
| **Config** | `read_config`, `write_config` | Read/modify `openagent.json` at runtime |
| **Memory** | `memory_update`, `memory_append`, `memory_read` | SOUL/USER/WORLD file operations |
| **Skills** | `skill_use`, `skill_create`, `skill_list`, `skill_read` | Dynamic skill management |
| **Evolution** | `self_modify` | Source code modification (opt-in via config) |
| **Subagent** | `subagent_spawn` | Spawn nested agent execution |
| **Scheduling** | `cron`, `heartbeat` | Schedule and manage background tasks |

### Loop Detector (`src/agent/loop-detector.ts`)

Detects when the agent gets stuck in repetitive tool call patterns.

| Strategy | Threshold | Level | Action |
|----------|-----------|-------|--------|
| Circuit breaker | ≥30 total calls | `critical` | Abort run immediately |
| Ping-pong (ABABAB) | 6-window alternation | `critical` | Abort run |
| Same call repeat | ≥8 identical (name+args) | `critical` | Abort run |
| Same call repeat | ≥5 identical (name+args) | `warning` | Append warning to tool result |

Uses a rolling window of hashed `(toolName, stableStringify(args))` pairs via SHA256 for deterministic comparison.

### Dynamic Skills (`src/evolution/skill-loader.ts`)

Runtime-loadable tool extensions stored as `*.skill.ts` files in `user-space/skills/`.

```typescript
// user-space/skills/my-skill.skill.ts
export const skill = {
  name: "my_skill",
  description: "What this skill does",
  parameters: { /* JSON Schema */ }
};

export async function execute(args: Record<string, unknown>): Promise<string> {
  return "result";
}
```

Skills are registered as `skill_{name}` in the tool registry. Hot-reload support allows the agent to create and immediately use new skills within the same session.

---

## Session Management (`src/sessions/manager.ts`)

SQLite-backed session persistence with WAL mode enabled.

**Schema:**

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Session ID (UUID) |
| `channel` | TEXT | Channel type |
| `peer_id` | TEXT | Peer identifier |
| `messages` | TEXT | JSON array of ChatMessage |
| `metadata` | TEXT | JSON object |
| `created_at` | INTEGER | Unix timestamp |
| `updated_at` | INTEGER | Unix timestamp |

**Key behaviors:**
- Session key: `"channel:peerId"` — one session per user per channel
- Max history: `config.agent.maxHistoryMessages` (default 50), trimmed from start on each append
- Transcript repair on load: injects synthetic tool results for orphaned tool calls (from interrupted runs)

---

## Channel Layer

```
ChannelManager
    ├── WebChatChannel     — WebSocket (via gateway)
    ├── FeishuChannel      — Feishu/Lark bot (REST + WebSocket)
    ├── TelegramChannel    — Telegram Bot API
    └── MockChannel        — Testing
```

### Channel Interface (`src/channels/base.ts`)

```typescript
interface Channel {
  readonly type: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutgoingMessage): Promise<void>;
  onMessage(handler: MessageHandler): void;
}
```

### Message Flow

```
External Platform                      OpenAgent
     │                                     │
     │  incoming message                   │
     ▼                                     │
  Channel impl ──► MessageQueue ──► dispatch loop
                  .publishInbound()        │
                                      AgentEngine
                                      .startTask()
                                           │
                                      StreamAgent
                                      .run()
                                           │
                                    (events stream)
                                           │
                                           ▼
  Channel impl ◄── MessageQueue ◄── response
     │            .publishOutbound()
     ▼
External Platform
```

### Message Queue (`src/channels/message-queue.ts`)

Dual async queue (inbound + outbound) that decouples channel I/O from agent execution.

| Method | Description |
|--------|-------------|
| `publishInbound(msg)` | Enqueue incoming message |
| `consumeInbound()` | Block until message available |
| `publishOutbound(msg)` | Enqueue outgoing reply |
| `consumeOutbound()` | Block until message available |
| `stop()` | Unblock consumers with sentinel for graceful shutdown |

---

## Self-Evolution System

Three layers of runtime self-improvement, each with increasing capability and risk:

```
Layer 1: Memory        — Persistent knowledge files       (lowest risk)
Layer 2: Skills        — Dynamic tool creation             (medium risk)
Layer 3: Self-Modify   — Source code changes               (highest risk, opt-in)
```

Plus two automated processes:

```
Reflection     — Post-conversation learning (fire-and-forget)
Consolidation  — Context window compression (threshold-triggered)
```

### Memory Store (`src/evolution/memory.ts`)

Persistent knowledge stored as markdown files in `user-space/memory/`:

| File | Purpose | Write Pattern |
|------|---------|---------------|
| `SOUL.md` | Agent personality, values, identity | Overwrite sections |
| `USER.md` | User preferences, interaction history | Append entries |
| `WORLD.md` | External world knowledge | Append entries |
| `MEMORY.md` | Consolidated long-term memory | Overwrite (after consolidation) |
| `HISTORY.md` | Historical session summaries | Append-only |
| `HEARTBEAT.md` | Periodic task definitions | Checkbox items |

**Operations:**
- `read(file)` — full file content
- `write(file, content)` — overwrite entire file
- `updateSection(file, section, content)` — replace markdown `## section`
- `appendEntry(file, section, entry)` — add timestamped bullet: `- [YYYY-MM-DD HH:MM] entry`

Memory files are injected into the system prompt at depth 0, giving the agent persistent context across sessions.

### Reflection Engine (`src/evolution/reflection.ts`)

Post-conversation learning that runs as fire-and-forget after each successful task.

1. Extract user messages and count tool calls from session
2. Compute topic distribution (top 5 words by frequency, supports CJK)
3. Generate summary: channel, peer, message count, tool usage, topics
4. Append timestamped entry to `USER.md` under "Interaction History Summary"

### Memory Consolidation (`src/evolution/consolidation.ts`)

Triggered when session messages exceed 65% of context window:

```
Token estimate = (total_chars / 4) * 1.2

If tokens > 0.65 * context_window:
  1. Call LLM to summarize old messages
  2. Merge summary into MEMORY.md
  3. Remove old messages from session
  4. Log summary in HISTORY.md
```

---

## Subagent System (`src/agent/subagent-registry.ts`)

The agent can spawn child agents for concurrent task execution:

```
Main Agent (depth=0)
  │
  ├─ subagent_spawn(task="research X")
  │    └─ Subagent (depth=1)
  │         ├─ Reduced system prompt (no memory/skills/evolution)
  │         ├─ Own session: "subagent:<runId>"
  │         └─ On completion: result injected into parent session
  │
  └─ subagent_spawn(task="analyze Y")
       └─ Subagent (depth=1)
```

- **Depth limit**: Max 3 levels
- **Context isolation**: `setCurrentRunContext()` exposes parent identity to tools like `subagent_spawn`
- **Result delivery**: subagent result is automatically injected into the parent's session as a user message

---

## Background Services

### Cron Service (`src/background/cron.ts`)

Scheduled task execution using standard 5-field cron expressions.

```
Format: minute hour day-of-month month day-of-week
Example: "30 9 * * 1-5"  → 9:30 AM on weekdays
```

- Jobs persisted to `user-space/cron/jobs.json`
- Tick loop checks `nextRunAt` every 60 seconds
- On trigger: `runAgent("cron", "cron:{jobId}", task)` → collect text events → push to outbox
- Created/managed by agent via `cron` tool

### Heartbeat Service (`src/background/heartbeat.ts`)

Periodic polling service (default interval: 30 minutes).

1. Reads unchecked items from `user-space/memory/HEARTBEAT.md` (format: `- [ ] task text`)
2. Executes each as an agent task
3. Pushes non-empty results to outbox

### Outbox Service (`src/background/outbox.ts`)

Reliable message delivery with persistence.

- Messages appended to `user-space/sessions/{source}_outbox.jsonl`
- Delivery handlers broadcast to WebSocket clients and forward to channel adapters
- Used by CronService, HeartbeatService, and any background agent run

---

## Configuration (`src/config/schema.ts`)

```
AppConfig
    ├── gateway         — host (127.0.0.1), port (19090), authToken
    ├── agent           — defaultProvider, systemPrompt, maxHistoryMessages (50),
    │                     maxToolRounds (10), contextWindow (128K),
    │                     bootstrapMaxChars (8K), bootstrapTotalMaxChars (40K)
    ├── providers
    │   ├── openai      — apiKey, baseUrl, model, queryParams
    │   └── anthropic   — apiKey, model, setupToken
    ├── channels
    │   ├── webchat     — enabled (true)
    │   ├── feishu      — enabled, appId, appSecret, encryptKey, verificationToken
    │   └── telegram    — enabled, botToken
    ├── evolution       — memoryPath, skillsPath, selfModifyEnabled, reflectionEnabled
    ├── logging         — level (debug | info | warn | error)
    └── storage         — dbPath (./data/openagent.db)
```

Config file: `openagent.json` in project root. Uses Zod schema validation with camelCase aliasing. The agent can read and modify its own config at runtime via `read_config` / `write_config` tools.

---

## Data Types (`src/types/index.ts`)

### Core Types

```typescript
type MessageRole = "system" | "user" | "assistant" | "tool";

interface ChatMessage {
  role: MessageRole;
  content: string;
  name?: string;              // tool name (for tool messages)
  toolCallId?: string;        // links tool result to tool_call
  toolCalls?: ToolCall[];     // tool calls from assistant
  timestamp: number;
}

interface ToolCall {
  id: string;                 // e.g., "call_abc123"
  function: { name: string; arguments: string };  // arguments as JSON string
  type: "function";
}

interface StreamChunk {
  type: "text" | "tool_call" | "done" | "error";
  content?: string;
  toolCall?: ToolCall;
  error?: string;
  usage?: TokenUsage;
}

interface AgentStreamEvent {
  type: "text" | "tool_start" | "tool_result" | "done" | "error" | "progress";
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  error?: string;
  round?: number;
  maxRounds?: number;
}
```

### Channel Types

```typescript
interface IncomingMessage {
  channel: string;            // "webchat", "feishu", "telegram"
  peerId: string;
  content: string;
  mediaUrl?: string;
  timestamp: number;
}

interface OutgoingMessage {
  channel: string;
  peerId: string;
  content: string;
  replyToId?: string;
}
```

---

## End-to-End Request Flow

```
1. User sends message
   │
   ├── via WebSocket   ──► Gateway ──► GatewayAdapter
   ├── via Feishu      ──► FeishuChannel ──► MessageQueue
   └── via Telegram    ──► TelegramChannel ──► MessageQueue
                                                  │
2. AgentEngine.startTask(channel, peerId, message)
   │
   ├── Cancel any existing task for this session
   ├── ContextBuilder.build()
   │   ├── Get or create session (SQLite)
   │   ├── Append user message
   │   ├── Build system prompt (identity + safety + memory + skills)
   │   └── Collect tool definitions from registry
   │
   └── StreamAgent.run(context, abortSignal)
       │
       ├── Round 1: provider.chat() → text + tool_calls
       │   ├── Tool: web_search({query: "..."}) → results
       │   └── Tool: write_file({path: "...", content: "..."}) → ok
       │
       ├── Round 2: provider.chat() → text (no tool calls)
       │   └── Natural end of ReAct loop
       │
       └── Events streamed back to client

3. Post-task
   ├── AgentEngine yields { type: "done" }
   ├── Reflection (fire-and-forget) → USER.md updated
   └── Task info retained 60s for observability
```

---

## Project Layout

```
src/
  agent/                        # Agent runtime core
    engine.ts                   #   Task lifecycle management (singleton)
    stream-agent.ts             #   Stateless ReAct loop (~180 lines)
    context.ts                  #   System prompt builder
    loop-detector.ts            #   Infinite loop detection
    subagent-registry.ts        #   Subagent depth/context tracking
    index.ts                    #   initAgent(), runAgent(), cancelAgent()
    types.ts                    #   AgentStreamEvent type
    providers/                  #   LLM provider abstraction
      base.ts                  #     Provider interface
      anthropic.ts             #     Anthropic (direct SDK)
      openai.ts                #     OpenAI / OpenAI-compatible
      claude-code.ts           #     Claude Code CLI delegation
      bytedance-genai.ts       #     ByteDance internal models
    tools/                     #   Tool system
      registry.ts              #     Global tool registry
      builtin/                 #     Built-in tool implementations
        file-ops.ts            #       read_file, write_file, list_files
        shell.ts               #       shell command execution
        web-search.ts          #       web search
        datetime.ts            #       current time
        memory.ts              #       per-peer isolated memory
        evolution-tools.ts     #       memory/skill/self-modify/subagent
        cron-tool.ts           #       cron job management
        heartbeat-tool.ts      #       heartbeat task processing
        read-config.ts         #       config reader
        write-config.ts        #       config writer
  evolution/                   #   Self-evolution system
    memory.ts                  #     Memory file store (SOUL/USER/WORLD/MEMORY)
    skill-loader.ts            #     Dynamic .skill.ts import + hot-reload
    self-modify.ts             #     Restricted source code modification
    reflection.ts              #     Post-conversation learning
    consolidation.ts           #     Context window compression
  gateway/                     #   HTTP + WebSocket server
    server.ts                  #     Hono app factory + lifecycle
    routes.ts                  #     REST API endpoints
    websocket.ts               #     WebSocket protocol handler
    app-ui.ts                  #     Web UI serving
    config-ui.ts               #     Config editor UI
    webchat-ui.ts              #     Chat interface UI
    status.ts                  #     Runtime status endpoint
  channels/                    #   Channel adapters
    base.ts                    #     Channel interface
    manager.ts                 #     Channel lifecycle + dispatch
    message-queue.ts           #     Dual async queue (inbound/outbound)
    gateway-adapter.ts         #     Channel-to-agent bridge
    webchat.ts                 #     WebSocket channel
    feishu.ts                  #     Feishu REST API adapter
    feishu-ws.ts               #     Feishu WebSocket connection
    feishu-api.ts              #     Feishu API client
    mock.ts                    #     Mock channel for testing
  sessions/                    #   Persistence
    manager.ts                 #     SQLite session CRUD (WAL mode)
    index.ts                   #     Exports
  background/                  #   Background services
    cron.ts                    #     Cron scheduler (5-field expression)
    heartbeat.ts               #     Periodic polling (30min default)
    outbox.ts                  #     Message delivery with persistence
    index.ts                   #     Service initialization
  config/                      #   Configuration
    schema.ts                  #     Zod config schema with defaults
    index.ts                   #     Config loader
    json-schema.ts             #     JSON Schema generation for UI
  middleware/                  #   HTTP middleware
    auth.ts                    #     Bearer token authentication
    idempotency.ts             #     Request deduplication
  cli/                         #   CLI entry point
    index.ts                   #     Commands: chat, start, dev, agent, doctor
  types/                       #   Shared TypeScript types
  logger.ts                    #   Structured logger
  audit.ts                     #   Audit logging (JSONL)

user-space/                    #   Agent working space (persisted)
  memory/                      #     SOUL.md, USER.md, WORLD.md, MEMORY.md, HISTORY.md
  skills/                      #     *.skill.ts dynamic tools
  workspace/                   #     Agent file operations sandbox
  sessions/                    #     Outbox JSONL files
  cron/                        #     jobs.json
```
