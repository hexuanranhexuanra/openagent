"""In-memory idempotency store with TTL, matching TS middleware/idempotency.ts."""

from __future__ import annotations

import asyncio
import time

from src.utils.logger import create_logger

log = create_logger("middleware:idempotency")

DEFAULT_TTL_S = 5 * 60  # 5 minutes


class IdempotencyStore:
    def __init__(self, ttl_s: float = DEFAULT_TTL_S) -> None:
        self._seen: dict[str, float] = {}
        self._ttl = ttl_s
        self._cleanup_task: asyncio.Task | None = None

    def is_duplicate(self, key: str) -> bool:
        if key in self._seen:
            log.debug("Duplicate detected", {"key": key})
            return True
        self._seen[key] = time.time()
        return False

    def _cleanup(self) -> None:
        now = time.time()
        expired = [k for k, ts in self._seen.items() if now - ts > self._ttl]
        for k in expired:
            del self._seen[k]
        if expired:
            log.debug("Idempotency cleanup", {"evicted": len(expired)})

    async def start_cleanup_loop(self) -> None:
        async def _loop():
            while True:
                await asyncio.sleep(60)
                self._cleanup()

        self._cleanup_task = asyncio.create_task(_loop())

    def stop(self) -> None:
        if self._cleanup_task:
            self._cleanup_task.cancel()
            self._cleanup_task = None


idempotency_store = IdempotencyStore()
