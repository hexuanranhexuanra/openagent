"""AgentEngine — task lifecycle manager, matching TS agent/engine.ts.

Supports two execution modes:
1. StreamAgent mode (default) — ReAct loop with tool calls via LLM provider
2. Claude Code mode — delegates to Claude Code CLI subprocess with its own tool loop
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, AsyncGenerator, Literal
from secrets import token_hex

from src.agents.context import get_context_builder
from src.agents.stream_agent import StreamAgent
from src.types import AgentStreamEvent
from src.utils.logger import create_logger

if TYPE_CHECKING:
    from src.models.base import LLMProvider
    from src.models.claude_code import ClaudeCodeProvider

log = create_logger("agent:engine")

TaskStatus = Literal["running", "done", "cancelled", "error"]


@dataclass
class TaskInfo:
    task_id: str
    session_key: str
    status: TaskStatus
    started_at: float
    ended_at: float | None = None
    error: str | None = None


@dataclass
class _ActiveTask:
    info: TaskInfo
    cancel_event: asyncio.Event


class AgentEngine:
    def __init__(self, provider: LLMProvider, use_claude_code: bool = False) -> None:
        self._provider = provider
        self._use_claude_code = use_claude_code
        self._stream_agent = StreamAgent(provider)
        self._tasks: dict[str, _ActiveTask] = {}

    async def start_task(
        self, channel: str, peer_id: str, message: str
    ) -> AsyncGenerator[AgentStreamEvent, None]:
        session_key = f"{channel}:{peer_id}"

        self.cancel_task(channel, peer_id)

        task_id = token_hex(4)
        cancel_event = asyncio.Event()
        info = TaskInfo(
            task_id=task_id,
            session_key=session_key,
            status="running",
            started_at=time.time(),
        )
        self._tasks[session_key] = _ActiveTask(info=info, cancel_event=cancel_event)
        log.info("Task started", {"taskId": task_id, "sessionKey": session_key})

        session_id: str | None = None

        try:
            if self._use_claude_code:
                async for event in self._run_claude_code(
                    channel, peer_id, message, session_key, cancel_event
                ):
                    yield event
                    if event.type == "done":
                        session_id = session_key  # For consolidation
            else:
                ctx = await get_context_builder().build(channel, peer_id, message)
                session_id = ctx.session_id
                async for event in self._stream_agent.run(ctx, cancel_event):
                    yield event
        except Exception as e:
            if not cancel_event.is_set():
                info.status = "error"
                info.ended_at = time.time()
                info.error = str(e)
                log.error("Task error", {"taskId": task_id, "sessionKey": session_key, "error": info.error})
                yield AgentStreamEvent(type="error", error=info.error)
            return
        finally:
            async def _cleanup():
                await asyncio.sleep(60)
                current = self._tasks.get(session_key)
                if current and current.info.task_id == task_id:
                    del self._tasks[session_key]

            asyncio.get_event_loop().create_task(_cleanup())

        if not cancel_event.is_set():
            info.status = "done"
            info.ended_at = time.time()
            log.info("Task done", {
                "taskId": task_id,
                "sessionKey": session_key,
                "durationMs": int((info.ended_at - info.started_at) * 1000),
            })

            # Fire-and-forget consolidation check (only for non-claude-code mode)
            if session_id and not self._use_claude_code:
                async def _post_task_consolidation():
                    try:
                        from src.evolution.consolidation import get_consolidation_manager
                        mgr = get_consolidation_manager()
                        if mgr:
                            await mgr.maybe_consolidate(session_id)
                    except Exception as err:
                        log.warn("Post-task consolidation check failed", {
                            "taskId": task_id, "error": str(err),
                        })

                asyncio.get_event_loop().create_task(_post_task_consolidation())

            yield AgentStreamEvent(type="done")

    async def _run_claude_code(
        self,
        channel: str,
        peer_id: str,
        message: str,
        session_key: str,
        cancel_event: asyncio.Event,
    ) -> AsyncGenerator[AgentStreamEvent, None]:
        """Run via Claude Code provider — bypasses StreamAgent ReAct loop."""
        from src.models.claude_code import ClaudeCodeProvider

        provider: ClaudeCodeProvider = self._provider  # type: ignore

        # Build system prompt from context builder (memory, identity, etc.)
        from src.config import get_config
        config = get_config()
        ctx_builder = get_context_builder()
        system_prompt = await ctx_builder._build_system_prompt(config, channel, depth=0)

        async for event in provider.run_agent(
            session_id=session_key,
            user_message=message,
            system_prompt=system_prompt,
            cancel_event=cancel_event,
        ):
            yield event

    def cancel_task(self, channel: str, peer_id: str) -> bool:
        session_key = f"{channel}:{peer_id}"
        task = self._tasks.get(session_key)
        if task and task.info.status == "running":
            task.cancel_event.set()
            task.info.status = "cancelled"
            task.info.ended_at = time.time()
            log.info("Task cancelled", {"taskId": task.info.task_id, "sessionKey": session_key})
            return True
        return False

    def is_running(self, channel: str, peer_id: str) -> bool:
        task = self._tasks.get(f"{channel}:{peer_id}")
        return task is not None and task.info.status == "running"

    def get_task_info(self, channel: str, peer_id: str) -> TaskInfo | None:
        task = self._tasks.get(f"{channel}:{peer_id}")
        return task.info if task else None

    def get_active_sessions(self) -> list[str]:
        return [key for key, t in self._tasks.items() if t.info.status == "running"]

    def cancel_all(self) -> None:
        for task in self._tasks.values():
            if task.info.status == "running":
                task.cancel_event.set()
                task.info.status = "cancelled"
                task.info.ended_at = time.time()
        log.info("All tasks cancelled")


_engine: AgentEngine | None = None


def get_agent_engine() -> AgentEngine:
    if _engine is None:
        raise RuntimeError("AgentEngine not initialized. Call init_agent() first.")
    return _engine


def init_agent_engine(provider: LLMProvider, use_claude_code: bool = False) -> AgentEngine:
    global _engine
    _engine = AgentEngine(provider, use_claude_code=use_claude_code)
    return _engine
