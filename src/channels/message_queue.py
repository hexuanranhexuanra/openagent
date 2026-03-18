"""Dual async message queue (inbound/outbound), matching TS channels/message-queue.ts."""

from __future__ import annotations

import asyncio

from src.types import IncomingMessage, OutgoingMessage
from src.utils.logger import create_logger

log = create_logger("channels:queue")


class MessageQueue:
    def __init__(self) -> None:
        self._inbound: asyncio.Queue[IncomingMessage | None] = asyncio.Queue()
        self._outbound: asyncio.Queue[OutgoingMessage | None] = asyncio.Queue()
        self._stopped = False

    async def publish_inbound(self, msg: IncomingMessage) -> None:
        await self._inbound.put(msg)

    async def publish_outbound(self, msg: OutgoingMessage) -> None:
        await self._outbound.put(msg)

    async def consume_inbound(self) -> IncomingMessage | None:
        return await self._inbound.get()

    async def consume_outbound(self) -> OutgoingMessage | None:
        return await self._outbound.get()

    def stop(self) -> None:
        self._stopped = True
        # Unblock consumers
        self._inbound.put_nowait(None)
        self._outbound.put_nowait(None)

    @property
    def inbound_size(self) -> int:
        return self._inbound.qsize()

    @property
    def outbound_size(self) -> int:
        return self._outbound.qsize()


_queue: MessageQueue | None = None


def get_message_queue() -> MessageQueue:
    global _queue
    if _queue is None:
        _queue = MessageQueue()
    return _queue
