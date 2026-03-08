# Agent Engine Design

## Overview

Refactor the monolithic `runAgent()` into a layered architecture:

```
AgentEngine (Stateful)          — task lifecycle, FSM, cancel
    └── StreamAgent (Stateless) — ReAct loop, LLM calls, tool execution
            └── ContextBuilder  — context assembly (system prompt + history + tools)
```

Inspired by the ByteDance BackendAgent design (AgentEngine/StreamAgent split).

---

## File Structure

```
src/agent/
  types.ts          # AgentStreamEvent type
  context.ts        # ContextBuilder — assembles AgentContext
  stream-agent.ts   # StreamAgent — stateless ReAct loop
  engine.ts         # AgentEngine — task FSM, cancel, singleton
  index.ts          # initAgent(), backwards-compat shims (runAgent, cancelAgent)
  providers/        # (unchanged)
  tools/            # (unchanged)
```

---

## Components

### 1. AgentContext (`context.ts`)

Immutable snapshot assembled before each task run.

```typescript
interface AgentContext {
  sessionId: string;       // "channel:peerId"
  messages: ChatMessage[]; // history snapshot at build time
  systemPrompt: string;    // base + SOUL + USER + WORLD memory
  tools: ToolDefinition[]; // registered tool definitions
  maxRounds: number;       // from config.agent.maxToolRounds
}
```

`ContextBuilder.build(channel, peerId, userMessage)`:
1. `getOrCreateSession` → persist user message
2. Build system prompt: base + memory files (SOUL/USER/WORLD)
3. Load tool definitions
4. Return frozen `AgentContext`

### 2. StreamAgent (`stream-agent.ts`)

Stateless ReAct execution engine. Pure function semantics.

```
Input:  AgentContext + AbortSignal
Output: AsyncGenerator<AgentStreamEvent>

Loop:
  1. Check signal.aborted → return
  2. provider.chat(messages, tools, systemPrompt)
  3. Collect text chunks + tool calls
  4. Persist assistant message
  5. If no tool calls → break (natural end)
  6. Execute each tool call (check abort between each)
  7. Persist tool result messages
  8. Repeat up to maxRounds
```

- No knowledge of sessions, channels, or task lifecycle
- Checks `signal.aborted` at round start + after each LLM chunk + between tool calls
- Does NOT yield the final `done` event (that's AgentEngine's responsibility)
- Can be reused by CronService, HeartbeatService, SubAgent, etc.

### 3. AgentEngine (`engine.ts`)

Stateful task lifecycle manager. Singleton per process.

#### Task State Machine

```
         startTask()
             │
             ▼
         [running] ──────────── cancelTask() ──► [cancelled]
             │                                        │
      (stream done)                              (abort.abort())
             │
         (no error) ──► [done]
             │
          (error) ──► [error]
```

States:
- `running`: task is actively executing in StreamAgent
- `done`: StreamAgent returned normally, reflection triggered
- `cancelled`: explicitly cancelled via `cancelTask()`
- `error`: StreamAgent threw an unhandled exception

Task info is retained for 60s after completion for inspection.

#### Key Methods

```typescript
startTask(channel, peerId, message): AsyncGenerator<AgentStreamEvent>
  // Cancel any existing running task for this session first
  // Build context, run StreamAgent
  // Yield events, then yield { type: "done" } on normal completion

cancelTask(channel, peerId): boolean
  // Abort running task, set status = "cancelled"
  // Returns false if no running task

isRunning(channel, peerId): boolean
  // Check if a task is currently in "running" state

getTaskInfo(channel, peerId): TaskInfo | undefined
  // Returns task info for observability

cancelAll(): void
  // Cancel all running tasks (used in graceful shutdown)
```

---

## Wiring

### `index.ts` (thin shim)

```typescript
// initAgent() — same external interface
//   1. Register tools
//   2. Load skills
//   3. Build LLMProvider
//   4. Call initAgentEngine(provider)

// runAgent() — backwards-compat shim
export async function* runAgent(channel, peerId, message) {
  yield* getAgentEngine().startTask(channel, peerId, message);
}

// New export
export function cancelAgent(channel, peerId): boolean {
  return getAgentEngine().cancelTask(channel, peerId);
}
```

### `gateway-adapter.ts` (updated)

- Remove own `sessionAborts: Map<string, AbortController>`
- Use `getAgentEngine().isRunning(channel, peerId)` for session-busy check
- Call `cancelAgent(channel, peerId)` in `stop()` via `getAgentEngine().cancelAll()`

### `websocket.ts` (updated)

- Replace `sessionActive: Set<string>` with `getAgentEngine().isRunning()`
- Keep `sessionQueue` for message buffering
- Add `cancel` method: `{ type: "req", method: "cancel" }` → `cancelAgent()`

---

## Event Flow

```
Client ──ws──► handleWsMessage
                  │
            handleRequest("chat")
                  │
           AgentEngine.startTask()
                  │
           ContextBuilder.build()   ← session + memory + tools
                  │
           StreamAgent.run()
                  │
           ┌──── LLM stream ────────────────────────────┐
           │  yield { type: "text", content }            │
           │  yield { type: "tool_start", toolName }     │
           │  yield { type: "tool_result", toolResult }  │
           └─────────────────────────────────────────────┘
                  │
           yield { type: "done" }  (AgentEngine)
                  │
           sendStreamEvent(ws, event)  ──ws──► Client
```

---

## Cancellation Flow

```
Client sends: { type: "req", method: "cancel" }
    │
    ▼
cancelAgent("webchat", peerId)
    │
    ▼
AgentEngine.cancelTask()
    │── abort.abort()
    │── info.status = "cancelled"
    │
    ▼
StreamAgent.run() checks signal.aborted → returns
    │
    ▼
AgentEngine.startTask() detects abort.signal.aborted → skips done event
    │
    ▼
Session queue drains next buffered message (if any)
```
