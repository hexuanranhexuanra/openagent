"""Outbox worker — routes proactive messages to channels, matching TS background/outbox.ts."""

from __future__ import annotations

import json
import time
from pathlib import Path
from secrets import token_hex
from typing import Callable, Awaitable

from src.utils.logger import create_logger

log = create_logger("background:outbox")

SESSIONS_DIR = Path("user-space/sessions")

DeliveryHandler = Callable[[dict], Awaitable[None]]


class OutboxWorker:
    def __init__(self) -> None:
        self._handlers: list[DeliveryHandler] = []
        SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

    def on_deliver(self, handler: DeliveryHandler) -> None:
        self._handlers.append(handler)

    async def push(
        self,
        source: str,
        target: dict,
        content: str,
        job_id: str | None = None,
    ) -> None:
        msg_id = token_hex(5)
        message = {
            "id": msg_id,
            "source": source,
            "target": target,
            "content": content,
            "jobId": job_id,
            "timestamp": time.time(),
        }

        # Persist to JSONL for observability
        try:
            outbox_file = SESSIONS_DIR / f"{source}_outbox.jsonl"
            with open(outbox_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(message, ensure_ascii=False) + "\n")
        except Exception:
            pass

        # Deliver to all handlers
        for handler in self._handlers:
            try:
                await handler(message)
            except Exception as e:
                log.warn("Outbox delivery handler error", {"source": source, "error": str(e)})


_outbox: OutboxWorker | None = None


def get_outbox() -> OutboxWorker:
    global _outbox
    if _outbox is None:
        _outbox = OutboxWorker()
    return _outbox
