"""Heartbeat service — periodic task execution from HEARTBEAT.md, matching TS background/heartbeat.ts."""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

from src.utils.logger import create_logger

log = create_logger("background:heartbeat")

HEARTBEAT_PATH = Path("user-space/memory/HEARTBEAT.md")
DEFAULT_INTERVAL_S = 30 * 60  # 30 minutes
UNCHECKED_RE = re.compile(r"^-\s+\[\s+\]\s*(.*)", re.MULTILINE)


class HeartbeatService:
    def __init__(self, interval_s: float = DEFAULT_INTERVAL_S) -> None:
        self._interval = interval_s
        self._task: asyncio.Task | None = None
        self._ticking = False

    def start(self) -> None:
        if self._task:
            return
        self._task = asyncio.get_event_loop().create_task(self._loop())
        log.info("Heartbeat service started", {"intervalMin": self._interval / 60})

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None

    async def tick(self) -> None:
        if self._ticking:
            log.debug("Heartbeat tick already in progress, skipping")
            return
        self._ticking = True
        try:
            await self._execute_tasks()
        finally:
            self._ticking = False

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self._interval)
            try:
                await self.tick()
            except Exception as e:
                log.warn("Heartbeat tick error", {"error": str(e)})

    async def _execute_tasks(self) -> None:
        if not HEARTBEAT_PATH.exists():
            return

        content = HEARTBEAT_PATH.read_text(encoding="utf-8")
        tasks = UNCHECKED_RE.findall(content)

        if not tasks:
            return

        log.info("Heartbeat executing tasks", {"count": len(tasks)})

        from src.agents.init import run_agent
        from src.background.outbox import get_outbox

        for task_text in tasks:
            try:
                text_parts: list[str] = []
                async for event in run_agent("heartbeat", "default", task_text):
                    if event.type == "text" and event.content:
                        text_parts.append(event.content)

                result = "".join(text_parts)
                if result:
                    await get_outbox().push(
                        "heartbeat",
                        {"channel": "webchat", "peerId": "broadcast"},
                        result,
                    )
            except Exception as e:
                log.warn("Heartbeat task failed", {"task": task_text[:50], "error": str(e)})


_service: HeartbeatService | None = None


def get_heartbeat_service() -> HeartbeatService:
    global _service
    if _service is None:
        _service = HeartbeatService()
    return _service
