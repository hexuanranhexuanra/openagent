"""Channel protocol — all channel implementations follow this interface."""

from __future__ import annotations

from typing import Awaitable, Callable, Protocol

from src.types import IncomingMessage, OutgoingMessage

MessageHandler = Callable[[IncomingMessage], Awaitable[None]]


class Channel(Protocol):
    @property
    def type(self) -> str: ...
    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def send(self, message: OutgoingMessage) -> None: ...
    def on_message(self, handler: MessageHandler) -> None: ...
