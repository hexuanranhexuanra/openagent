# Background Services Design

## 1. Overview

Three tightly-coupled background services give OpenAgent proactive, time-driven autonomy — the agent acts without being messaged.

```
┌─────────────────────────────────────────────────────────┐
│                  Background Services                     │
│                                                         │
│  CronService          HeartbeatService                  │
│  (jobs.json)          (HEARTBEAT.md)                    │
│      │                      │                           │
│      └──────────┬───────────┘                           │
│                 │  runAgent(channel, peerId, task)       │
│                 ▼                                        │
│           StreamAgent (stateless)                       │
│                 │                                        │
│                 │  AgentStreamEvent[]                    │
│                 ▼                                        │
│           OutboxWorker                                   │
│          /           \                                   │
│    webchat            feishu                            │
│  broadcastEvent()   sendFeishuMessage()                  │
└─────────────────────────────────────────────────────────┘
```

## 2. Module Specifications

### 2.1 OutboxWorker (`src/background/outbox.ts`)

Central message router. Background services push `OutboxMessage` objects here; the worker delivers them to the correct channel.

**Message schema:**
```ts
interface OutboxMessage {
  id: string;
  source: "cron" | "heartbeat";
  target: { channel: "webchat" | "feishu"; peerId: string };
  content: string;
  jobId?: string;
  timestamp: number;
}
```

**Delivery routing:**
| `target.channel` | Mechanism |
|---|---|
| `webchat` | `broadcastEvent("agent_proactive", ...)` to all WebSocket clients |
| `feishu` | `sendFeishuMessage(token, peerId, content)` via feishu-api |

**Persistence:** every outbox message is also appended to
`user-space/sessions/<source>_outbox.jsonl` for observability.

**Key functions:**
- `getOutbox(): OutboxWorker` — singleton
- `OutboxWorker.push(msg)` — deliver + persist
- `OutboxWorker.onDeliver(cb)` — register custom delivery hook (for testing)

---

### 2.2 CronService (`src/background/cron.ts`)

Schedules recurring agent tasks using standard 5-field cron expressions.

**Job schema (`user-space/cron/jobs.json`):**
```json
[
  {
    "id": "job-abc123",
    "name": "Daily digest",
    "cron": "0 9 * * *",
    "task": "Prepare a brief daily summary of anything important",
    "target": { "channel": "feishu", "peerId": "<open_id>" },
    "enabled": true,
    "createdAt": 1741234567890,
    "lastRunAt": null,
    "nextRunAt": 1741320000000
  }
]
```

**Lifecycle:**
```
start()
  └─ loadJobs() from jobs.json
  └─ scheduleAll() — compute nextRunAt for each job
  └─ tick loop (1s interval)
        └─ for each job: if nextRunAt <= now → executeJob()
              └─ runAgent("cron", jobId, task)
              └─ collect output → OutboxWorker.push()
              └─ update lastRunAt + nextRunAt, persist jobs.json
```

**Session key:** `cron:<jobId>` — each job has its own persistent memory.

**Cron expression support:** standard 5-field (`min hour dom month dow`).
Supported field syntax: `*`, `*/n`, `n`. Comma lists (`n,m`) are not needed for typical use cases.

**Concurrency:** a job that is still running when its next trigger fires is skipped (logged as warning), preventing pile-up.

**Key functions:**
- `getCronService(): CronService` — singleton
- `CronService.start()` / `.stop()`
- `CronService.addJob(params) → CronJob`
- `CronService.removeJob(id)`
- `CronService.listJobs() → CronJob[]`
- `CronService.triggerNow(id)` — manual trigger for testing

---

### 2.3 HeartbeatService (`src/background/heartbeat.ts`)

Periodically reads `user-space/memory/HEARTBEAT.md` and dispatches each unchecked task to the agent. Gives the agent a mechanism for self-directed, asynchronous thinking.

**File format (`user-space/memory/HEARTBEAT.md`):**
```markdown
- [ ] Check calendar and remind of upcoming events
- [ ] Scan inbox for urgent emails
- [x] Already done task (skipped)
```

**Lifecycle:**
```
start(intervalMs = 30min)
  └─ setInterval(tick, intervalMs)

tick()
  └─ readTasks() — parse "- [ ]" lines from HEARTBEAT.md
  └─ for each unchecked task:
        └─ runAgent("heartbeat", "default", task)
        └─ collect output → OutboxWorker.push()
```

**Session key:** `heartbeat:default` — all heartbeat tasks share one session, giving continuity between ticks.

**Target:** configurable via `HeartbeatService` constructor; defaults to webchat broadcast.

**Key functions:**
- `getHeartbeatService(): HeartbeatService` — singleton
- `HeartbeatService.start(intervalMs?)` / `.stop()`
- `HeartbeatService.tick()` — exposed for manual trigger / testing

---

## 3. Data Files

```
user-space/
  cron/
    jobs.json          # Cron job definitions (read/write by CronService)
  memory/
    HEARTBEAT.md       # Task checklist (read by HeartbeatService, written by agent)
  sessions/
    cron_outbox.jsonl  # Persisted cron output (append-only, observability)
    heartbeat_outbox.jsonl
```

## 4. Agent Tools

### `cron` tool
Allows the agent to manage its own scheduled tasks.

```
cron(action="add", name, cron_expr, task, target_channel, target_peer) → job
cron(action="remove", job_id)
cron(action="list") → jobs[]
cron(action="trigger", job_id)   # run immediately
```

### `heartbeat` tool
Allows the agent to manage the HEARTBEAT.md task list.

```
heartbeat(action="read") → tasks[]
heartbeat(action="add", task)
heartbeat(action="clear")
```

## 5. API Additions

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/cron/jobs` | List all cron jobs |
| `POST` | `/api/cron/jobs` | Add a new job |
| `DELETE` | `/api/cron/jobs/:id` | Remove a job |
| `POST` | `/api/cron/jobs/:id/trigger` | Trigger a job immediately |
| `GET` | `/api/heartbeat` | Read HEARTBEAT.md tasks |

## 6. Integration

Background services are started in the `gateway` CLI command after `initAgent()`:

```ts
await initAgent();
const bg = initBackgroundServices();
bg.cron.start();
bg.heartbeat.start();
```

The outbox is wired to channel delivery inside `initBackgroundServices()`:
- WebSocket: `broadcastEvent()` from `gateway/websocket.ts`
- Feishu: `sendFeishuMessage()` from `channels/feishu-api.ts`

## 7. Error Handling

| Scenario | Behavior |
|---|---|
| Job execution fails (LLM error) | Log error, update `lastRunAt`, compute next `nextRunAt` (job is not disabled) |
| Outbox delivery fails (Feishu API down) | Log error, message is already persisted to `.jsonl` — no retry for now |
| HEARTBEAT.md missing | Skip tick, log debug |
| `jobs.json` corrupted | Log error, start with empty job list |
| Concurrent job execution | Skip trigger, log warning |
