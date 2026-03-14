# OpenAgent Python Backend — Technical Design Document

> Date: 2026-03-10
> Branch: `feat/redesign_be`
> Status: Draft

---

## 1. Overview

将现有 TypeScript/Bun 后端（~9,700 LOC, 62 files）用 Python 重写，保持功能等价、目录结构对齐，方便对照和渐进式迁移。

### 1.1 Goals

- 功能完全等价（所有 API、WebSocket、Channel、Tool、Evolution 行为不变）
- 保持相同的 `openagent.json` 配置格式和环境变量覆盖
- 保持相同的 `user-space/` 文件布局（memory, skills, workspace）
- 保持相同的 SQLite 会话存储和审计日志格式
- Python 3.11+，纯 asyncio，无重量级框架

### 1.2 Non-Goals

- 不改变产品功能或 API 接口
- 不迁移前端 UI（HTML 模板字符串直接复用）
- 不改变 `openagent.json` schema

---

## 2. Technology Stack

| 层         | TS 原方案              | Python 方案                 | 说明 |
|-----------|----------------------|---------------------------|------|
| Runtime   | Bun                  | CPython 3.11+             | asyncio 原生 |
| HTTP      | Hono                 | FastAPI + Uvicorn         | 自带 OpenAPI、WebSocket |
| WebSocket | Bun native WS        | FastAPI WebSocket         | Starlette 内置 |
| Validation| Zod                  | Pydantic v2               | 同为 schema-first |
| SQLite    | bun:sqlite           | aiosqlite                 | WAL mode 支持 |
| LLM SDK   | openai / @anthropic  | openai / anthropic        | Python SDK 同样成熟 |
| 飞书 SDK   | @larksuiteoapi/node  | lark-oapi (Python)        | 官方 Python SDK |
| Task Queue| Bunqueue (embedded)  | asyncio.Queue + worker    | 无需 Redis |
| CLI       | Commander            | Typer (click-based)       | |
| Logging   | Custom JSON logger   | structlog                 | JSON structured logging |
| Process   | PM2                  | supervisord / systemd     | |

---

## 3. Directory Structure

```
openagent/
├── pyproject.toml                 # project metadata, deps
├── openagent.json                 # config (unchanged)
├── openagent/                     # Python package root
│   ├── __main__.py                # python -m openagent
│   ├── cli.py                     # Typer CLI (gateway, chat, agent, doctor)
│   ├── main.py                    # FastAPI app factory
│   ├── logger.py                  # structlog setup
│   ├── audit.py                   # JSONL audit logger
│   │
│   ├── config/
│   │   ├── schema.py              # Pydantic models (AppConfig)
│   │   ├── loader.py              # load/reload/getConfig
│   │   └── json_schema.py         # Pydantic → JSON Schema + uiHints
│   │
│   ├── agent/
│   │   ├── types.py               # ChatMessage, ToolCall, StreamChunk, AgentStreamEvent
│   │   ├── engine.py              # AgentEngine (task lifecycle, cancellation)
│   │   ├── context.py             # ContextBuilder (system prompt, memory bootstrap)
│   │   ├── stream_agent.py        # StreamAgent (ReAct loop)
│   │   ├── loop_detector.py       # LoopDetector (repeat/pingpong/circuit breaker)
│   │   ├── init.py                # initAgent(), runAgent(), cancelAgent()
│   │   ├── subagent.py            # SubagentRegistry, spawnSubagent()
│   │   │
│   │   ├── providers/
│   │   │   ├── base.py            # LLMProvider protocol
│   │   │   ├── openai_provider.py
│   │   │   ├── anthropic_provider.py
│   │   │   ├── bytedance_genai.py
│   │   │   └── claude_code.py
│   │   │
│   │   └── tools/
│   │       ├── registry.py        # registerTool, executeTool, getAllToolDefinitions
│   │       └── builtin/
│   │           ├── datetime_tool.py
│   │           ├── web_search.py
│   │           ├── shell.py
│   │           ├── file_ops.py
│   │           ├── memory_tool.py     # per-peer isolated memory
│   │           ├── evolution_tools.py # memory_update/append/read, skill_*, self_modify
│   │           ├── cron_tool.py
│   │           ├── heartbeat_tool.py
│   │           ├── read_config.py
│   │           └── write_config.py
│   │
│   ├── sessions/
│   │   └── manager.py             # SQLite session CRUD
│   │
│   ├── evolution/
│   │   ├── memory.py              # MemoryStore (SOUL/USER/WORLD.md)
│   │   ├── reflection.py          # reflectOnConversation()
│   │   ├── consolidation.py       # context window consolidation
│   │   ├── skill_loader.py        # dynamic .skill.py loading
│   │   └── self_modify.py         # safe self-modification
│   │
│   ├── channels/
│   │   ├── base.py                # Channel protocol
│   │   ├── manager.py             # ChannelManager
│   │   ├── message_queue.py       # inbound/outbound async queues
│   │   ├── gateway_adapter.py     # bridge channels ↔ agent
│   │   ├── feishu.py              # Feishu webhook routes
│   │   ├── feishu_ws.py           # Feishu WebSocket long connection
│   │   ├── feishu_api.py          # Feishu REST API helpers
│   │   └── webchat.py             # WebSocket chat channel
│   │
│   ├── gateway/
│   │   ├── routes.py              # FastAPI APIRouter
│   │   ├── websocket.py           # WebSocket handler
│   │   └── ui.py                  # HTML template strings (copy from TS)
│   │
│   ├── background/
│   │   ├── outbox.py              # OutboxWorker
│   │   ├── heartbeat.py           # HeartbeatService
│   │   ├── cron.py                # CronService + cron parser
│   │   └── init.py                # initBackgroundServices()
│   │
│   ├── queue/
│   │   └── worker.py              # asyncio.Queue based job processing
│   │
│   └── middleware/
│       ├── auth.py                # Bearer token + Feishu signature
│       └── idempotency.py         # in-memory dedup store
│
├── user-space/                    # unchanged
│   ├── memory/
│   ├── skills/                    # *.skill.py (Python format)
│   └── workspace/
│
├── data/                          # unchanged
│   ├── openagent.db
│   ├── audit/
│   └── backups/
│
└── tests/
    ├── test_config.py
    ├── test_agent.py
    ├── test_session.py
    ├── test_tools.py
    └── test_loop_detector.py
```

---

## 4. Module Design — Detailed Mapping

### 4.1 Config (`config/`)

**TS → Python 映射：**

| TS (Zod)                   | Python (Pydantic)              |
|---------------------------|-------------------------------|
| `z.object({...})`         | `class XxxConfig(BaseModel)`  |
| `z.string().default(...)` | `field: str = "default"`      |
| `z.optional()`            | `field: str \| None = None`   |
| `z.coerce.number()`       | `field: int = Field(default=...)` |
| `configSchema.parse(raw)` | `AppConfig.model_validate(raw)` |

```python
# config/schema.py
from pydantic import BaseModel, Field

class GatewayConfig(BaseModel):
    port: int = 19090
    host: str = "127.0.0.1"
    auth_token: str | None = None

class OpenAIProviderConfig(BaseModel):
    api_key: str | None = None
    base_url: str | None = None
    model: str = "gpt-4o"
    query_params: dict[str, str] | None = None

class AnthropicProviderConfig(BaseModel):
    api_key: str | None = None
    model: str = "claude-sonnet-4-20250514"
    setup_token: str | None = None

class ProvidersConfig(BaseModel):
    openai: OpenAIProviderConfig = OpenAIProviderConfig()
    anthropic: AnthropicProviderConfig = AnthropicProviderConfig()

class FeishuChannelConfig(BaseModel):
    enabled: bool = False
    app_id: str | None = None
    app_secret: str | None = None
    encrypt_key: str | None = None
    verification_token: str | None = None

class WebchatChannelConfig(BaseModel):
    enabled: bool = True

class ChannelsConfig(BaseModel):
    webchat: WebchatChannelConfig = WebchatChannelConfig()
    feishu: FeishuChannelConfig = FeishuChannelConfig()

class AgentConfig(BaseModel):
    default_provider: str = "openai"
    system_prompt: str = "You are a helpful assistant."
    max_history_messages: int = 50
    max_tool_rounds: int = 10
    context_window: int = 128000
    bootstrap_max_chars: int = 8000
    bootstrap_total_max_chars: int = 40000

class EvolutionConfig(BaseModel):
    memory_path: str = "user-space/memory"
    skills_path: str = "user-space/skills"
    self_modify_enabled: bool = True
    reflection_enabled: bool = True

class LoggingConfig(BaseModel):
    level: str = "info"

class StorageConfig(BaseModel):
    db_path: str = "data/openagent.db"

class AppConfig(BaseModel):
    gateway: GatewayConfig = GatewayConfig()
    agent: AgentConfig = AgentConfig()
    providers: ProvidersConfig = ProvidersConfig()
    channels: ChannelsConfig = ChannelsConfig()
    evolution: EvolutionConfig = EvolutionConfig()
    logging: LoggingConfig = LoggingConfig()
    storage: StorageConfig = StorageConfig()
```

**Config Loader (`config/loader.py`):**

```python
_config: AppConfig | None = None

def load_config(path: str = "openagent.json") -> AppConfig:
    """Load from JSON file, overlay env vars, validate with Pydantic."""
    global _config
    raw = json.loads(Path(path).read_text()) if Path(path).exists() else {}
    _apply_env_overrides(raw)
    _config = AppConfig.model_validate(raw)
    return _config

def get_config() -> AppConfig:
    if _config is None:
        return load_config()
    return _config

def reload_config() -> AppConfig:
    global _config
    _config = None
    return load_config()
```

**JSON Schema for UI (`config/json_schema.py`):**
- 使用 `AppConfig.model_json_schema()` 生成 JSON Schema
- 手动附加 `uiHints`（labels, sensitive flags, groups）

---

### 4.2 Agent Types (`agent/types.py`)

```python
from dataclasses import dataclass, field
from typing import Literal

MessageRole = Literal["system", "user", "assistant", "tool"]

@dataclass
class ToolCallFunction:
    name: str
    arguments: str  # JSON string

@dataclass
class ToolCall:
    id: str
    type: str = "function"
    function: ToolCallFunction

@dataclass
class ChatMessage:
    role: MessageRole
    content: str
    name: str | None = None
    tool_call_id: str | None = None
    tool_calls: list[ToolCall] | None = None
    timestamp: int | None = None

@dataclass
class StreamChunk:
    type: Literal["text_delta", "tool_call", "error", "usage"]
    content: str | None = None
    tool_call: ToolCall | None = None
    error: str | None = None
    usage: "TokenUsage | None" = None

@dataclass
class TokenUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0

@dataclass
class AgentStreamEvent:
    type: Literal["text", "tool_start", "tool_result", "done", "error", "progress"]
    content: str | None = None
    tool_name: str | None = None
    tool_args: dict | None = None
    tool_result: str | None = None
    usage: TokenUsage | None = None
    error: str | None = None
    round: int | None = None
    max_rounds: int | None = None

@dataclass
class ToolDefinition:
    name: str
    description: str
    parameters: dict  # JSON Schema object

@dataclass
class ToolHandler:
    definition: ToolDefinition
    execute: "Callable[[dict], Awaitable[str]]"
```

---

### 4.3 LLM Providers (`agent/providers/`)

**Base Protocol:**

```python
from typing import Protocol, AsyncGenerator

class LLMProvider(Protocol):
    name: str

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[ToolDefinition] | None = None,
        system_prompt: str | None = None,
    ) -> AsyncGenerator[StreamChunk, None]: ...
```

**OpenAI Provider (`openai_provider.py`):**
- `openai.AsyncOpenAI` client
- Streaming via `client.chat.completions.create(stream=True)`
- Tool call delta accumulation (same logic as TS)
- 支持 `query_params` 注入 (用于 ByteDance ak auth)

**Anthropic Provider (`anthropic_provider.py`):**
- `anthropic.AsyncAnthropic` client
- `client.messages.stream()` with system parameter
- OAuth mode (setup_token) vs API key mode
- `max_tokens=4096`
- Content block handling: text_delta, input_json_delta, tool_use

**ByteDance GenAI Provider (`bytedance_genai.py`):**
- Non-streaming, Responses API
- POST `/responses?ak={ak}` with manual redirect handling
- Uses `httpx.AsyncClient` with `follow_redirects=False` + manual 3xx handling

**Claude Code Provider (`claude_code.py`):**
- Subprocess: `claude --print --output-format=stream-json ...`
- `asyncio.create_subprocess_exec()` for async process management
- JSONL stdout parsing

---

### 4.4 Tool System (`agent/tools/`)

**Registry (`registry.py`):**

```python
_tools: dict[str, ToolHandler] = {}

def register_tool(handler: ToolHandler) -> None:
    _tools[handler.definition.name] = handler

async def execute_tool(name: str, args: dict) -> str:
    handler = _tools.get(name)
    if not handler:
        return json.dumps({"error": f"Unknown tool: {name}"})
    try:
        result = await handler.execute(args)
        return result if isinstance(result, str) else json.dumps(result)
    except Exception as e:
        return json.dumps({"error": str(e)})

def get_all_tool_definitions() -> list[ToolDefinition]:
    return [h.definition for h in _tools.values()]
```

**Built-in Tools — 逐个映射：**

| TS Tool              | Python Tool           | 关键差异 |
|---------------------|-----------------------|---------|
| `get_current_datetime` | `datetime_tool.py`  | `zoneinfo` 替代 `Intl` |
| `web_search`         | `web_search.py`      | Placeholder, 无变化 |
| `run_shell`          | `shell.py`           | `asyncio.create_subprocess_shell()` 替代 `Bun.spawn` |
| `read/write/list_file` | `file_ops.py`     | `aiofiles` 或 `pathlib` |
| `memory`             | `memory_tool.py`     | 同逻辑，`pathlib` 路径处理 |
| `memory_update/append/read` | `evolution_tools.py` | 调用 MemoryStore |
| `skill_use/create/list/read` | `evolution_tools.py` | `.skill.py` 格式 |
| `self_modify`        | `evolution_tools.py`  | `ast.parse()` 替代 `Bun.Transpiler` |
| `sessions_spawn`     | `evolution_tools.py`  | 调用 SubagentRegistry |
| `cron`               | `cron_tool.py`       | 同逻辑 |
| `heartbeat`          | `heartbeat_tool.py`  | 同逻辑 |
| `read_config`        | `read_config.py`     | 同 masking 逻辑 |
| `write_config`       | `write_config.py`    | 同 deep-merge 逻辑 |

**Shell Tool 关键变化：**

```python
async def execute_shell(args: dict) -> str:
    command = args["command"]
    cwd = args.get("cwd", str(PROJECT_ROOT))
    timeout = args.get("timeout", 10)

    proc = await asyncio.create_subprocess_shell(
        command,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=timeout
        )
    except asyncio.TimeoutError:
        proc.kill()
        return json.dumps({"error": "timeout", "timeout": timeout})

    return json.dumps({
        "exitCode": proc.returncode,
        "stdout": stdout.decode()[:10240],
        "stderr": stderr.decode()[:5120],
    })
```

**Skill System 变化（.skill.ts → .skill.py）：**

```python
# user-space/skills/example.skill.py
skill = {
    "name": "example",
    "description": "An example skill",
    "parameters": {
        "type": "object",
        "properties": {"input": {"type": "string"}},
    },
}

async def execute(args: dict) -> str:
    return f"Result: {args.get('input', '')}"
```

Loader 使用 `importlib.util.spec_from_file_location()` + `module_from_spec()` 动态加载。

---

### 4.5 Agent Core Loop (`agent/`)

**StreamAgent (`stream_agent.py`) — ReAct Loop:**

```
async def run(ctx: AgentContext, signal: asyncio.Event) -> AsyncGenerator[AgentStreamEvent]:
    loop_detector = LoopDetector()

    for round in range(ctx.max_rounds):
        if signal.is_set():
            return

        yield AgentStreamEvent(type="progress", round=round, max_rounds=ctx.max_rounds)

        # 1. Stream LLM
        text_parts, tool_calls = [], []
        async for chunk in provider.chat(ctx.messages, ctx.tools, ctx.system_prompt):
            if chunk.type == "text_delta":
                text_parts.append(chunk.content)
                yield AgentStreamEvent(type="text", content=chunk.content)
            elif chunk.type == "tool_call":
                tool_calls.append(chunk.tool_call)
            elif chunk.type == "error":
                yield AgentStreamEvent(type="error", error=chunk.error)
                return

        # 2. Append assistant message
        assistant_msg = ChatMessage(role="assistant", content="".join(text_parts), tool_calls=tool_calls or None)
        append_message(ctx.session_id, assistant_msg)

        # 3. No tool calls → done
        if not tool_calls:
            break

        # 4. Execute tools
        for tc in tool_calls:
            # Loop detection
            check = loop_detector.check(tc.function.name, tc.function.arguments)
            if check.stuck and check.level == "critical":
                yield AgentStreamEvent(type="error", error=check.message)
                return

            # Parse args, execute
            args = json.loads(tc.function.arguments)
            yield AgentStreamEvent(type="tool_start", tool_name=tc.function.name, tool_args=args)
            result = await execute_tool(tc.function.name, args)
            result = result[:24000]  # cap

            if check.stuck and check.level == "warning":
                result += f"\n\n⚠️ {check.message}"

            yield AgentStreamEvent(type="tool_result", tool_name=tc.function.name, tool_result=result)
            append_message(ctx.session_id, ChatMessage(role="tool", content=result, tool_call_id=tc.id))

    yield AgentStreamEvent(type="done", usage=usage)
```

**AgentEngine (`engine.py`) — Task Lifecycle:**

```python
class AgentEngine:
    _tasks: dict[str, TaskInfo]  # session_key → TaskInfo

    async def start_task(self, channel, peer_id, message) -> AsyncGenerator[AgentStreamEvent]:
        key = f"{channel}:{peer_id}"

        # Cancel existing
        if key in self._tasks and self._tasks[key].status == "running":
            await self.cancel_task(channel, peer_id)

        cancel_event = asyncio.Event()
        task_info = TaskInfo(status="running", cancel_event=cancel_event)
        self._tasks[key] = task_info

        try:
            ctx = context_builder.build(channel, peer_id, message)
            async for event in stream_agent.run(ctx, cancel_event):
                yield event
            task_info.status = "done"
            # async reflection (fire-and-forget)
            asyncio.create_task(reflect_on_conversation(...))
        except Exception as e:
            if cancel_event.is_set():
                task_info.status = "cancelled"
            else:
                task_info.status = "error"
                yield AgentStreamEvent(type="error", error=str(e))

    async def cancel_task(self, channel, peer_id) -> bool:
        key = f"{channel}:{peer_id}"
        task = self._tasks.get(key)
        if task and task.status == "running":
            task.cancel_event.set()
            return True
        return False
```

**LoopDetector (`loop_detector.py`):**
- `hashlib.sha256` 替代 Bun SHA256
- 完全相同的算法：generic repeat (5 warn / 8 critical), ping-pong (6 recent), circuit breaker (30)

---

### 4.6 Session Manager (`sessions/manager.py`)

```python
import aiosqlite

DB_PATH = "data/openagent.db"

async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                channel TEXT NOT NULL,
                peer_id TEXT NOT NULL,
                messages TEXT DEFAULT '[]',
                metadata TEXT DEFAULT '{}',
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                last_consolidated TEXT
            )
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS idx_channel_peer ON sessions(channel, peer_id)")
        await db.commit()

async def get_or_create_session(channel: str, peer_id: str) -> Session:
    session_id = f"{channel}:{peer_id}"
    async with aiosqlite.connect(DB_PATH) as db:
        row = await db.execute_fetchone("SELECT * FROM sessions WHERE id = ?", (session_id,))
        if row:
            return _row_to_session(row)
        await db.execute(
            "INSERT INTO sessions (id, channel, peer_id) VALUES (?, ?, ?)",
            (session_id, channel, peer_id),
        )
        await db.commit()
        return Session(id=session_id, channel=channel, peer_id=peer_id, messages=[])

async def append_message(session_id: str, msg: ChatMessage):
    # Load, append, trim to max_history, save
    ...
```

---

### 4.7 Gateway (`gateway/`)

**FastAPI App (`main.py`):**

```python
from fastapi import FastAPI, WebSocket
import uvicorn

def create_app() -> FastAPI:
    app = FastAPI(title="OpenAgent")
    app.include_router(api_router, prefix="/api")
    app.add_api_websocket_route("/ws", websocket_handler)
    app.get("/")(serve_ui)
    return app
```

**Routes (`routes.py`) — 完整映射：**

| TS Route                    | Python Route                  |
|----------------------------|-------------------------------|
| `GET /health`              | `GET /api/health`             |
| `GET /status`              | `GET /api/status`             |
| `POST /api/chat`           | `POST /api/chat`              |
| `POST /api/chat/async`     | `POST /api/chat/async`        |
| `GET /api/sessions`        | `GET /api/sessions`           |
| `POST /api/sessions/:id/reset` | `POST /api/sessions/{id}/reset` |
| `GET /api/tools`           | `GET /api/tools`              |
| `GET /api/config`          | `GET /api/config`             |
| `PUT /api/config`          | `PUT /api/config`             |
| `GET /api/config/schema`   | `GET /api/config/schema`      |
| `GET /api/memory/:file`    | `GET /api/memory/{file}`      |
| `GET /api/skills`          | `GET /api/skills`             |
| `GET /api/cron/jobs`       | `GET /api/cron/jobs`          |
| `POST /api/cron/jobs`      | `POST /api/cron/jobs`         |
| `DELETE /api/cron/jobs/:id`| `DELETE /api/cron/jobs/{id}`  |
| `GET /api/subagents`       | `GET /api/subagents`          |
| `GET /api/heartbeat`       | `GET /api/heartbeat`          |
| `POST /api/heartbeat/tick` | `POST /api/heartbeat/tick`    |
| `POST /webhook/feishu/webhook` | `POST /api/webhook/feishu` |
| `POST /webhook/generic`   | `POST /api/webhook/generic`   |

**WebSocket Protocol（不变）：**
```json
// Client → Server
{"type": "req", "id": "xxx", "method": "chat", "params": {"content": "hello"}}

// Server → Client
{"type": "event", "event": "agent_text", "payload": {"content": "Hi"}}
{"type": "event", "event": "agent_tool_start", "payload": {"tool": "...", "args": {}}}
{"type": "event", "event": "agent_tool_result", "payload": {"tool": "...", "result": "..."}}
{"type": "event", "event": "agent_done", "payload": {"usage": {...}}}
```

**Auth Middleware:**
- `Depends(verify_bearer_token)` on `/api/*` routes（exclude webhooks）
- Feishu signature verification as dependency

---

### 4.8 Channels (`channels/`)

**Channel Protocol:**

```python
from typing import Protocol

class Channel(Protocol):
    type: str
    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def send(self, message: OutgoingMessage) -> None: ...
    def on_message(self, handler: MessageHandler) -> None: ...
```

**FeishuChannel (`feishu_ws.py`):**
- `lark_oapi` Python SDK for WebSocket long connection
- 事件处理：`im.message.receive_v1`, `im.chat.member.bot.*`
- `send()` 调用 `im.message.create` / `im.message.reply`

**ChannelManager (`manager.py`):**
- `register()`, `start_all()`, `stop_all()`
- Outbound dispatch loop: consume from queue, route to channel

**MessageQueue (`message_queue.py`):**
- `asyncio.Queue` for inbound/outbound
- Same buffer + waiter pattern

---

### 4.9 Evolution (`evolution/`)

**MemoryStore (`memory.py`):**
- 完全相同的逻辑：`read()`, `write()`, `update_section()`, `append_entry()`
- Markdown section regex: `^## heading` matching
- 使用 `aiofiles` 异步文件 I/O

**Reflection (`reflection.py`):**
- 完全相同：word frequency heuristic, append to USER.md
- No LLM call

**Consolidation (`consolidation.py`):**
- 完全相同的算法：65% compact ratio, 35% keep ratio, min 3 turns
- Large slice split + parallel summarization
- Token estimation: `len(text) / 4 * 1.2`

**SkillLoader (`skill_loader.py`):**
- `.skill.ts` → `.skill.py` 格式变化
- `importlib` 动态加载替代 `import()` with cache-busting
- Hot reload: `importlib.invalidate_caches()` + reload

**SelfModifier (`self_modify.py`):**
- Same allowed/denied path lists
- `ast.parse()` 替代 `Bun.Transpiler` 做语法校验
- Same backup strategy

---

### 4.10 Background Services (`background/`)

**CronService:**
- Same 5-field cron parser
- `asyncio.create_task()` for tick loop (check every 1s)
- Jobs persisted to `user-space/cron/jobs.json`

**HeartbeatService:**
- Parse `HEARTBEAT.md` for unchecked tasks
- Execute via `runAgent()`, post results to outbox
- Default 30 min interval

**OutboxWorker:**
- Delivery handlers dict: `{"webchat": ws_broadcast, "feishu": feishu_send}`
- JSONL persistence in `user-space/sessions/`

---

### 4.11 Queue (`queue/`)

**Embedded async queue（替代 Bunqueue）：**

```python
import asyncio
from dataclasses import dataclass

@dataclass
class MessageJob:
    task_id: str
    channel: str
    peer_id: str
    content: str
    ws_client_id: str | None = None
    feishu_message_id: str | None = None
    priority: int = 0

_queue: asyncio.Queue[MessageJob] | None = None
_workers: list[asyncio.Task] = []

async def init_queue():
    global _queue
    _queue = asyncio.Queue()

async def enqueue_message(job: MessageJob):
    await _queue.put(job)

async def init_worker(concurrency: int = 2):
    for _ in range(concurrency):
        task = asyncio.create_task(_worker_loop())
        _workers.append(task)

async def _worker_loop():
    while True:
        job = await _queue.get()
        try:
            async for event in run_agent(job.channel, job.peer_id, job.content):
                _emit_stream(job.task_id, event)
        except Exception as e:
            logger.error("Worker error", error=str(e))
        finally:
            _queue.task_done()
```

---

### 4.12 CLI (`cli.py`)

```python
import typer

app = typer.Typer()

@app.command()
def gateway(port: int = None, host: str = None):
    """Start HTTP + WebSocket gateway server."""
    ...

@app.command()
def chat(verbose: bool = False):
    """Interactive REPL chat."""
    ...

@app.command()
def agent(message: str = typer.Option(..., "-m")):
    """One-shot message."""
    ...

@app.command()
def doctor():
    """Check configuration and system health."""
    ...
```

---

## 5. Key Design Decisions

### 5.1 异步模型

| 方面 | TS 原方案 | Python 方案 |
|------|----------|------------|
| 并发 | Single-threaded event loop | asyncio event loop |
| Generator | `async function*` | `async def ... yield` |
| Cancellation | `AbortController` + `signal` | `asyncio.Event` |
| Background tasks | `Promise` fire-and-forget | `asyncio.create_task()` |
| Timer | `setTimeout` / `setInterval` | `asyncio.sleep()` in loop |

### 5.2 Bun-Specific 替换

| Bun API | Python 替换 |
|---------|------------|
| `bun:sqlite` | `aiosqlite` |
| `Bun.spawn()` | `asyncio.create_subprocess_shell()` |
| `Bun.write()` / `Bun.file()` | `pathlib.Path` / `aiofiles` |
| `Bun.Transpiler` | `ast.parse()` |
| `Bun.Glob` | `pathlib.Path.glob()` |
| `Bun.serve()` + WebSocket | `uvicorn` + FastAPI WebSocket |
| `bunqueue` | `asyncio.Queue` |

### 5.3 JSON 配置兼容

`openagent.json` 格式不变。Python 使用 `model_config = ConfigDict(alias_generator=to_camel)` 让 Pydantic 读写 camelCase JSON，内部使用 snake_case。

### 5.4 Skill 文件格式

TS `.skill.ts` → Python `.skill.py`。两种格式不兼容，迁移时需要用户手动转换现有 skills（通常很少或没有）。

---

## 6. Implementation Plan

### Phase 1: Foundation（Day 1）

| # | 模块 | 文件 | 依赖 | 可验证 |
|---|------|------|------|--------|
| 1.1 | pyproject.toml | `pyproject.toml` | - | `pip install -e .` |
| 1.2 | Logger | `openagent/logger.py` | structlog | import test |
| 1.3 | Config Schema | `openagent/config/schema.py` | pydantic | unit test |
| 1.4 | Config Loader | `openagent/config/loader.py` | 1.3 | load openagent.json |
| 1.5 | Types | `openagent/agent/types.py` | - | import test |
| 1.6 | Session Manager | `openagent/sessions/manager.py` | aiosqlite, 1.5 | CRUD test |
| 1.7 | Audit Logger | `openagent/audit.py` | 1.2 | write JSONL |

### Phase 2: Agent Core（Day 2）

| # | 模块 | 文件 | 依赖 | 可验证 |
|---|------|------|------|--------|
| 2.1 | Tool Registry | `openagent/agent/tools/registry.py` | 1.5 | register + execute |
| 2.2 | Built-in Tools | `openagent/agent/tools/builtin/*.py` | 2.1, 1.3 | tool execution |
| 2.3 | LLM Provider Base | `openagent/agent/providers/base.py` | 1.5 | protocol check |
| 2.4 | OpenAI Provider | `openagent/agent/providers/openai_provider.py` | 2.3 | stream test |
| 2.5 | Anthropic Provider | `openagent/agent/providers/anthropic_provider.py` | 2.3 | stream test |
| 2.6 | ByteDance Provider | `openagent/agent/providers/bytedance_genai.py` | 2.3 | API call test |
| 2.7 | Loop Detector | `openagent/agent/loop_detector.py` | - | unit test |
| 2.8 | StreamAgent | `openagent/agent/stream_agent.py` | 2.1-2.7, 1.6 | mock provider test |
| 2.9 | ContextBuilder | `openagent/agent/context.py` | 1.3, 1.6 | prompt assembly |
| 2.10 | AgentEngine | `openagent/agent/engine.py` | 2.8, 2.9 | lifecycle test |
| 2.11 | Agent Init | `openagent/agent/init.py` | 2.1-2.10 | `init_agent()` |

### Phase 3: Gateway & WebSocket（Day 3）

| # | 模块 | 文件 | 依赖 | 可验证 |
|---|------|------|------|--------|
| 3.1 | Auth Middleware | `openagent/middleware/auth.py` | 1.3 | unit test |
| 3.2 | Idempotency | `openagent/middleware/idempotency.py` | - | unit test |
| 3.3 | API Routes | `openagent/gateway/routes.py` | 2.11, 1.3, 1.6 | curl tests |
| 3.4 | WebSocket | `openagent/gateway/websocket.py` | 2.11 | wscat test |
| 3.5 | UI Templates | `openagent/gateway/ui.py` | - | browser test |
| 3.6 | App Factory | `openagent/main.py` | 3.1-3.5 | server start |
| 3.7 | Queue/Worker | `openagent/queue/worker.py` | 2.11 | async enqueue test |
| 3.8 | CLI | `openagent/cli.py` | 3.6, 3.7 | `python -m openagent gateway` |

### Phase 4: Channels（Day 4）

| # | 模块 | 文件 | 依赖 | 可验证 |
|---|------|------|------|--------|
| 4.1 | Channel Base | `openagent/channels/base.py` | 1.5 | protocol def |
| 4.2 | Message Queue | `openagent/channels/message_queue.py` | - | unit test |
| 4.3 | Feishu API | `openagent/channels/feishu_api.py` | httpx | token test |
| 4.4 | Feishu Webhook | `openagent/channels/feishu.py` | 4.3, 3.1 | webhook test |
| 4.5 | Feishu WS Channel | `openagent/channels/feishu_ws.py` | 4.3 | connection test |
| 4.6 | WebChat Channel | `openagent/channels/webchat.py` | 3.4 | WS test |
| 4.7 | Channel Manager | `openagent/channels/manager.py` | 4.1-4.6 | multi-channel test |
| 4.8 | Gateway Adapter | `openagent/channels/gateway_adapter.py` | 4.7, 2.11 | E2E test |

### Phase 5: Evolution & Background（Day 5）

| # | 模块 | 文件 | 依赖 | 可验证 |
|---|------|------|------|--------|
| 5.1 | MemoryStore | `openagent/evolution/memory.py` | - | section update test |
| 5.2 | Reflection | `openagent/evolution/reflection.py` | 5.1 | heuristic test |
| 5.3 | Consolidation | `openagent/evolution/consolidation.py` | 5.1, 2.4 | mock test |
| 5.4 | SkillLoader | `openagent/evolution/skill_loader.py` | 2.1 | load/exec test |
| 5.5 | SelfModifier | `openagent/evolution/self_modify.py` | - | path check test |
| 5.6 | Subagent | `openagent/agent/subagent.py` | 2.10 | spawn test |
| 5.7 | Outbox | `openagent/background/outbox.py` | - | delivery test |
| 5.8 | Cron Service | `openagent/background/cron.py` | 2.11, 5.7 | schedule test |
| 5.9 | Heartbeat | `openagent/background/heartbeat.py` | 2.11, 5.7 | tick test |
| 5.10 | Background Init | `openagent/background/init.py` | 5.7-5.9 | startup test |
| 5.11 | Integration | - | all | full E2E |

---

## 7. Testing Strategy

```
tests/
├── unit/
│   ├── test_config.py           # Pydantic validation, env override
│   ├── test_types.py            # serialization roundtrip
│   ├── test_session.py          # SQLite CRUD
│   ├── test_loop_detector.py    # repeat/pingpong/breaker
│   ├── test_tool_registry.py    # register/execute
│   ├── test_memory_store.py     # section update/append
│   ├── test_cron_parser.py      # next run date calculation
│   └── test_self_modify.py      # path allow/deny
├── integration/
│   ├── test_agent_loop.py       # mock provider + tools
│   ├── test_consolidation.py    # token estimation + trim
│   └── test_gateway.py          # FastAPI TestClient
└── conftest.py                  # fixtures (tmp dirs, mock config)
```

Framework: `pytest` + `pytest-asyncio`

---

## 8. Migration Checklist

- [ ] Phase 1: Foundation (config, logger, session, types)
- [ ] Phase 2: Agent core (providers, tools, ReAct loop, engine)
- [ ] Phase 3: Gateway (HTTP, WebSocket, CLI)
- [ ] Phase 4: Channels (Feishu, WebChat, manager)
- [ ] Phase 5: Evolution & background (memory, skills, cron, heartbeat)
- [ ] Smoke test: `python -m openagent chat` 交互式对话
- [ ] Smoke test: `python -m openagent gateway` 启动服务
- [ ] Smoke test: WebSocket 连接 + 消息收发
- [ ] Smoke test: Feishu channel 消息收发
- [ ] 删除或归档 TS 源码（可选）

---

## 9. Risk & Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| lark-oapi Python SDK WebSocket 接口与 Node SDK 差异 | 飞书 WS 不可用 | 提前验证 SDK API；fallback 到 webhook 模式 |
| Skill 格式不兼容 (.ts → .py) | 已有 skills 需手动迁移 | 提供迁移脚本或文档 |
| asyncio.Queue 无持久化 | 进程重启丢失队列 | 对齐 TS 原方案（Bunqueue 也是内存优先） |
| aiosqlite 性能差异 | 高并发下延迟 | WAL mode + connection pool |
| Claude Code subprocess 在 Python 环境行为 | 路径/env 差异 | 测试覆盖 |
