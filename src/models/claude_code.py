"""Claude Code provider — long-running JSONL subprocess with process pooling.

Inspired by NeoClaw's architecture:
1. One long-running Claude CLI process per conversation (JSONL streaming protocol)
2. Session persistence & resume across idle reaps
3. Custom tools via MCP server (stdio)
4. Claude Code's built-in tools (Bash, Edit, Read, etc.) remain available
5. Idle process reaping (configurable timeout)

This provider bypasses OpenAgent's StreamAgent ReAct loop — Claude Code
manages its own internal tool loop. The provider yields AgentStreamEvents
directly for the engine to forward.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncGenerator

from src.types import AgentStreamEvent, ChatMessage, StreamChunk, TokenUsage, ToolDefinition
from src.utils.logger import create_logger

log = create_logger("provider:claude-code")

IDLE_TIMEOUT_S = 20 * 60  # 20 minutes
CLEANUP_INTERVAL_S = 60   # 1 minute
SESSIONS_DIR = Path.home() / ".openagent" / "cache"
SESSIONS_FILE = SESSIONS_DIR / "claude-sessions.json"
WORKSPACES_DIR = Path.home() / ".openagent" / "workspaces"

# ── JSONL Protocol Types ──────────────────────────────────────


@dataclass
class CliEvent:
    """Parsed event from Claude Code CLI stdout."""
    type: str
    raw: dict


# ── ClaudeProcess: one long-running claude subprocess ─────────


class ClaudeProcess:
    """Manages a single long-running Claude CLI subprocess using JSONL protocol."""

    def __init__(
        self,
        *,
        model: str | None = None,
        system_prompt: str | None = None,
        cwd: str | None = None,
        resume_session_id: str | None = None,
        mcp_config_path: str | None = None,
        disallowed_tools: list[str] | None = None,
    ) -> None:
        self._model = model
        self._system_prompt = system_prompt
        self._cwd = cwd
        self._resume_session_id = resume_session_id
        self._mcp_config_path = mcp_config_path
        self._disallowed_tools = disallowed_tools or []
        self._proc: asyncio.subprocess.Process | None = None
        self._session_id: str | None = None
        self._lock = asyncio.Lock()
        self._buffer = ""

    @property
    def is_running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    @property
    def session_id(self) -> str | None:
        return self._session_id

    def _build_args(self) -> list[str]:
        args = [
            "claude",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
        ]
        if self._resume_session_id:
            args.extend(["--resume", self._resume_session_id])
        if self._model:
            args.extend(["--model", self._model])

        # Bypass permissions for tool execution (agent runs in controlled env)
        args.append("--dangerously-skip-permissions")

        if self._disallowed_tools:
            args.extend(["--disallowedTools", ",".join(self._disallowed_tools)])

        if self._system_prompt:
            args.extend(["--append-system-prompt", self._system_prompt])

        if self._mcp_config_path:
            args.extend(["--mcp-config", self._mcp_config_path])

        return args

    async def start(self) -> None:
        if self.is_running:
            raise RuntimeError("Process already running")

        env = {**os.environ}
        # Prevent nested Claude Code invocations from inheriting env
        env.pop("CLAUDECODE", None)
        env.pop("CLAUDE_CODE_ENTRYPOINT", None)

        args = self._build_args()
        log.info("Starting Claude process", {"args": args[:6], "cwd": self._cwd})

        self._proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._cwd,
            env=env,
        )
        self._buffer = ""

    async def exchange(
        self, text: str
    ) -> AsyncGenerator[CliEvent, None]:
        """Send a user message and yield parsed CLI events until result arrives."""
        async with self._lock:
            if not self.is_running:
                raise RuntimeError("Process is not running")

            # Write user message as JSONL
            user_input = json.dumps({
                "type": "user",
                "message": {"role": "user", "content": text},
            })
            await self._writeln(user_input)

            # Read events until we get a result
            while True:
                line = await self._read_line()
                if line is None:
                    break

                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue

                event_type = data.get("type", "")

                # Capture session ID from init event
                if event_type == "system" and data.get("subtype") == "init":
                    self._session_id = data.get("session_id")
                    continue

                if event_type == "result":
                    if data.get("session_id"):
                        self._session_id = data["session_id"]
                    yield CliEvent(type="result", raw=data)
                    return

                yield CliEvent(type=event_type, raw=data)

    async def terminate(self) -> None:
        if not self._proc:
            return

        if self.is_running:
            try:
                if self._proc.stdin:
                    self._proc.stdin.close()
                # Wait up to 5 seconds for graceful exit
                try:
                    await asyncio.wait_for(self._proc.wait(), timeout=5.0)
                except asyncio.TimeoutError:
                    self._proc.kill()
                    await self._proc.wait()
            except Exception:
                pass

        self._proc = None

    # ── I/O helpers ──

    async def _writeln(self, data: str) -> None:
        if not self._proc or not self._proc.stdin:
            raise RuntimeError("Process stdin not available")
        self._proc.stdin.write((data + "\n").encode())
        await self._proc.stdin.drain()

    async def _read_line(self) -> str | None:
        if not self._proc or not self._proc.stdout:
            return None
        try:
            while True:
                nl = self._buffer.find("\n")
                if nl != -1:
                    line = self._buffer[:nl].strip()
                    self._buffer = self._buffer[nl + 1:]
                    if line:
                        return line
                    continue
                chunk = await self._proc.stdout.read(8192)
                if not chunk:
                    return None
                self._buffer += chunk.decode("utf-8", errors="replace")
        except Exception:
            return None


# ── ClaudeCodeProvider: process pool + session management ─────


class ClaudeCodeProvider:
    """Claude Code as core agent runner with process pooling and session resume."""

    def __init__(
        self,
        model: str | None = None,
        system_prompt: str | None = None,
        disallowed_tools: list[str] | None = None,
    ) -> None:
        self._model = model
        self._system_prompt = system_prompt
        self._disallowed_tools = disallowed_tools or []
        self._pool: dict[str, ClaudeProcess] = {}
        self._last_used: dict[str, float] = {}
        self._session_ids: dict[str, str] = {}
        self._mcp_config_path: str | None = None
        self._cleanup_task: asyncio.Task | None = None
        self._load_sessions()

    @property
    def name(self) -> str:
        return "claude-code"

    # ── LLMProvider interface (for consolidation and other callers) ──

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[ToolDefinition] | None = None,
        system_prompt: str | None = None,
    ) -> AsyncGenerator[StreamChunk, None]:
        """LLMProvider.chat() — single-shot call for consolidation etc.

        Uses a temporary process (no pooling) since consolidation calls
        don't need session persistence.
        """
        user_message = ""
        for msg in reversed(messages):
            if msg.role == "user":
                user_message = msg.content or ""
                break

        if not user_message:
            yield StreamChunk(type="text", content="No user message found.")
            return

        mcp_config = self._ensure_mcp_config()

        proc = ClaudeProcess(
            model=self._model,
            system_prompt=system_prompt,
            mcp_config_path=mcp_config,
            disallowed_tools=self._disallowed_tools,
        )
        await proc.start()

        try:
            text_parts: list[str] = []
            usage: TokenUsage | None = None

            async for event in proc.exchange(user_message):
                if event.type == "content_block_delta":
                    delta = event.raw.get("delta", {})
                    if delta.get("type") == "text_delta":
                        text = delta["text"]
                        text_parts.append(text)
                        yield StreamChunk(type="text", content=text)

                elif event.type == "result":
                    u = event.raw.get("usage", {})
                    usage = TokenUsage(
                        prompt_tokens=u.get("input_tokens", 0),
                        completion_tokens=u.get("output_tokens", 0),
                        total_tokens=u.get("input_tokens", 0) + u.get("output_tokens", 0),
                    )

                    if event.raw.get("is_error"):
                        yield StreamChunk(type="error", error=event.raw.get("result", "Error"))
                        return

                    if not text_parts:
                        result = event.raw.get("result", "")
                        if result:
                            yield StreamChunk(type="text", content=result)

            yield StreamChunk(type="done", usage=usage)
        finally:
            await proc.terminate()

    # ── Core agent interface (replaces StreamAgent for claude-code mode) ──

    async def run_agent(
        self,
        session_id: str,
        user_message: str,
        system_prompt: str | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> AsyncGenerator[AgentStreamEvent, None]:
        """Run a full agent turn with process pooling and session resume.

        This replaces StreamAgent.run() when using Claude Code as provider.
        Claude Code manages its own internal tool loop.
        """
        proc = await self._get_or_create(session_id, system_prompt)

        text_parts: list[str] = []
        t0 = time.time()

        try:
            async for event in proc.exchange(user_message):
                if cancel_event and cancel_event.is_set():
                    return

                if event.type == "content_block_delta":
                    delta = event.raw.get("delta", {})
                    delta_type = delta.get("type")

                    if delta_type == "text_delta":
                        text = delta["text"]
                        text_parts.append(text)
                        yield AgentStreamEvent(type="text", content=text)

                    elif delta_type == "thinking_delta":
                        # Thinking content — log but don't send to user
                        pass

                elif event.type == "content_block_start":
                    block = event.raw.get("content_block", {})
                    if block.get("type") == "tool_use":
                        yield AgentStreamEvent(
                            type="tool_start",
                            tool_name=block.get("name", ""),
                            tool_args=block.get("input"),
                        )

                elif event.type == "result":
                    result_data = event.raw

                    # Persist session ID for resume
                    if result_data.get("session_id"):
                        self._session_ids[session_id] = result_data["session_id"]
                        self._flush_sessions()

                    if result_data.get("is_error"):
                        yield AgentStreamEvent(
                            type="error", error=result_data.get("result", "Error")
                        )
                        return

                    # Extract usage
                    u = result_data.get("usage", {})
                    usage = TokenUsage(
                        prompt_tokens=u.get("input_tokens", 0),
                        completion_tokens=u.get("output_tokens", 0),
                        total_tokens=u.get("input_tokens", 0) + u.get("output_tokens", 0),
                    )

                    elapsed = int((time.time() - t0) * 1000)
                    cost = result_data.get("total_cost_usd")
                    model = result_data.get("model", "")

                    log.info("Claude Code turn complete", {
                        "session": session_id,
                        "model": model,
                        "elapsed_ms": elapsed,
                        "cost_usd": cost,
                        "turns": result_data.get("num_turns"),
                        "input_tokens": u.get("input_tokens"),
                        "output_tokens": u.get("output_tokens"),
                    })

                    # If we didn't get streaming text, use result field
                    if not text_parts:
                        result_text = result_data.get("result", "")
                        if result_text:
                            yield AgentStreamEvent(type="text", content=result_text)

                    yield AgentStreamEvent(type="done", usage=usage)

        except Exception as e:
            log.error("Claude Code exchange error", {"session": session_id, "error": str(e)})
            yield AgentStreamEvent(type="error", error=str(e))

    # ── Session management ──

    async def clear_conversation(self, session_id: str) -> None:
        proc = self._pool.get(session_id)
        if proc:
            await proc.terminate()
            del self._pool[session_id]
            self._last_used.pop(session_id, None)
        self._session_ids.pop(session_id, None)
        self._flush_sessions()
        log.info("Conversation cleared", {"session": session_id})

    async def dispose(self) -> None:
        if self._cleanup_task:
            self._cleanup_task.cancel()
            self._cleanup_task = None
        for proc in self._pool.values():
            await proc.terminate()
        self._pool.clear()
        self._last_used.clear()
        log.info("Claude Code provider disposed")

    def health_check(self) -> bool:
        import shutil
        return shutil.which("claude") is not None

    # ── Process pool management ──

    async def _get_or_create(
        self, session_id: str, system_prompt: str | None = None
    ) -> ClaudeProcess:
        existing = self._pool.get(session_id)
        if existing and existing.is_running:
            self._last_used[session_id] = time.time()
            return existing

        resume_session_id = self._session_ids.get(session_id)
        mcp_config = self._ensure_mcp_config()

        # Prepare isolated workspace
        workspace = self._prepare_workspace(session_id)

        prompt = system_prompt or self._system_prompt
        proc = ClaudeProcess(
            model=self._model,
            system_prompt=prompt,
            cwd=workspace,
            resume_session_id=resume_session_id,
            mcp_config_path=mcp_config,
            disallowed_tools=self._disallowed_tools,
        )
        await proc.start()
        self._pool[session_id] = proc
        self._last_used[session_id] = time.time()
        self._schedule_cleanup()

        log.info("Started Claude process", {
            "session": session_id,
            "pool_size": len(self._pool),
            "resuming": resume_session_id[:8] + "..." if resume_session_id else None,
        })
        return proc

    def _prepare_workspace(self, session_id: str) -> str:
        """Create an isolated workspace directory for the conversation."""
        dir_name = session_id.replace(":", "_")
        workspace = str(WORKSPACES_DIR / dir_name)
        os.makedirs(workspace, exist_ok=True)
        return workspace

    def _ensure_mcp_config(self) -> str:
        """Create MCP config file pointing to our tool server."""
        if self._mcp_config_path and os.path.exists(self._mcp_config_path):
            return self._mcp_config_path

        python_exe = sys.executable
        project_root = os.getcwd()

        config = {
            "mcpServers": {
                "openagent": {
                    "command": python_exe,
                    "args": ["-m", "src.tools.mcp_server"],
                    "cwd": project_root,
                }
            }
        }

        os.makedirs(SESSIONS_DIR, exist_ok=True)
        path = str(SESSIONS_DIR / "mcp-config.json")
        with open(path, "w") as f:
            json.dump(config, f)

        self._mcp_config_path = path
        log.info("MCP config created", {"path": path})
        return path

    # ── Idle reaping ──

    def _schedule_cleanup(self) -> None:
        if self._cleanup_task and not self._cleanup_task.done():
            return

        async def _cleanup_loop():
            while True:
                await asyncio.sleep(CLEANUP_INTERVAL_S)
                await self._reap_idle()
                if not self._pool:
                    break

        self._cleanup_task = asyncio.create_task(_cleanup_loop())

    async def _reap_idle(self) -> None:
        cutoff = time.time() - IDLE_TIMEOUT_S
        stale = [sid for sid, ts in self._last_used.items() if ts < cutoff]

        for sid in stale:
            log.info("Reaping idle process", {"session": sid})
            proc = self._pool.pop(sid, None)
            if proc:
                await proc.terminate()
            self._last_used.pop(sid, None)

    # ── Session persistence ──

    def _load_sessions(self) -> None:
        try:
            if SESSIONS_FILE.exists():
                data = json.loads(SESSIONS_FILE.read_text())
                self._session_ids = data
                log.info("Loaded sessions", {"count": len(data)})
        except Exception:
            pass

    def _flush_sessions(self) -> None:
        try:
            os.makedirs(SESSIONS_DIR, exist_ok=True)
            SESSIONS_FILE.write_text(json.dumps(self._session_ids, indent=2))
        except Exception as e:
            log.warn("Failed to flush sessions", {"error": str(e)})
