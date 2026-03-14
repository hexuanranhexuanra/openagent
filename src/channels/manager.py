"""Channel manager — lifecycle and outbound dispatch, matching TS channels/manager.ts."""

from __future__ import annotations

import asyncio
from typing import Any

from src.types import IncomingMessage, OutgoingMessage
from src.channels.base import Channel, MessageHandler
from src.channels.message_queue import MessageQueue
from src.utils.logger import create_logger

log = create_logger("channels:manager")


class ChannelManager:
    def __init__(self) -> None:
        self._channels: dict[str, Channel] = {}
        self._handler: MessageHandler | None = None
        self._dispatch_task: asyncio.Task | None = None

    def register(self, channel: Channel) -> None:
        self._channels[channel.type] = channel
        if self._handler:
            channel.on_message(self._handler)
        log.info("Channel registered", {"type": channel.type})

    def on_message(self, handler: MessageHandler) -> None:
        self._handler = handler
        for ch in self._channels.values():
            ch.on_message(handler)

    async def start_all(self) -> None:
        for ch_type, ch in self._channels.items():
            try:
                await ch.start()
                log.info("Channel started", {"type": ch_type})
            except Exception as e:
                log.error("Channel start failed", {"type": ch_type, "error": str(e)})

    async def stop_all(self) -> None:
        for ch_type, ch in self._channels.items():
            try:
                await ch.stop()
            except Exception as e:
                log.warn("Channel stop error", {"type": ch_type, "error": str(e)})

    def start_outbound_dispatch(self, queue: MessageQueue) -> None:
        async def _dispatch():
            while True:
                msg = await queue.consume_outbound()
                if msg is None:
                    break
                ch = self._channels.get(msg.channel_type)
                if ch:
                    try:
                        await ch.send(msg)
                    except Exception as e:
                        log.warn("Outbound send failed", {"channel": msg.channel_type, "error": str(e)})
                else:
                    log.warn("No channel for outbound message", {"type": msg.channel_type})

        self._dispatch_task = asyncio.get_event_loop().create_task(_dispatch())

    def get_channel(self, channel_type: str) -> Channel | None:
        return self._channels.get(channel_type)


_manager: ChannelManager | None = None


def get_channel_manager() -> ChannelManager:
    global _manager
    if _manager is None:
        _manager = ChannelManager()
    return _manager


def set_channel_manager(manager: ChannelManager) -> None:
    global _manager
    _manager = manager
