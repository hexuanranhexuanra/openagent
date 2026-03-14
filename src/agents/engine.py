"""AgentEngine — task lifecycle manager, matching TS agent/engine.ts."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, AsyncGenerator, Literal
from secrets import token_hex

from src.agents.context import get_context_builder
from src.agents.stream_agent import StreamAgent
from src.types import AgentStreamEvent
from src.utils.logger import create_logger
from src.sessions.manager import get_session_messages

if TYPE_CHECKING:
    from src.models.base import LLMProvider

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
    def __init__(self, provider: LLMProvider) -> None:
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
            # Retain task info for 60s for observability
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

            # Fire-and-forget reflection
            if session_id:
                async def _reflect():
                    try:
                        from src.evolution.reflection import reflect_on_conversation

                        msgs = await get_session_messages(session_id)
                        await reflect_on_conversation(msgs, channel, peer_id)
                    except Exception as err:
                        log.warn("Reflection failed (non-fatal)", {"taskId": task_id, "error": str(err)})

                asyncio.get_event_loop().create_task(_reflect())

            yield AgentStreamEvent(type="done")

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


def init_agent_engine(provider: LLMProvider) -> AgentEngine:
    global _engine
    _engine = AgentEngine(provider)
    return _engine
