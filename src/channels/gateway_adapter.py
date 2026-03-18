"""Gateway adapter — bridge between channels and agent, matching TS channels/gateway-adapter.ts."""

from __future__ import annotations

import asyncio

from src.types import IncomingMessage, OutgoingMessage
from src.channels.message_queue import MessageQueue
from src.utils.logger import create_logger

log = create_logger("channels:adapter")


class GatewayAdapter:
    def __init__(self) -> None:
        self._running_sessions: set[str] = set()
        self._pending: dict[str, list[IncomingMessage]] = {}
        self._task: asyncio.Task | None = None

    async def start(self, queue: MessageQueue) -> None:
        self._queue = queue

        async def _loop():
            while True:
                msg = await queue.consume_inbound()
                if msg is None:
                    break
                session_key = f"{msg.channel_type}:{msg.peer_id}"

                if session_key in self._running_sessions:
                    self._pending.setdefault(session_key, []).append(msg)
                    log.debug("Message buffered", {"session": session_key})
                    continue

                await self._spawn_session(session_key, msg)

        self._task = asyncio.get_event_loop().create_task(_loop())

    async def _spawn_session(self, session_key: str, msg: IncomingMessage) -> None:
        self._running_sessions.add(session_key)

        try:
            from src.agents.init import run_agent

            text_parts: list[str] = []
            async for event in run_agent(msg.channel_type, msg.peer_id, msg.content):
                if event.type == "text" and event.content:
                    text_parts.append(event.content)

            response = "".join(text_parts)
            if response:
                reply_to = None
                if hasattr(msg, "raw") and isinstance(msg.raw, dict):
                    reply_to = msg.raw.get("messageId")

                await self._queue.publish_outbound(OutgoingMessage(
                    channel_type=msg.channel_type,
                    channel_id=msg.channel_id,
                    peer_id=msg.peer_id,
                    content=response,
                    reply_to_id=reply_to,
                ))
        except Exception as e:
            log.error("Session error", {"session": session_key, "error": str(e)})
        finally:
            self._running_sessions.discard(session_key)

            # Process next pending message for this session
            pending = self._pending.get(session_key, [])
            if pending:
                next_msg = pending.pop(0)
                if not pending:
                    del self._pending[session_key]
                await self._spawn_session(session_key, next_msg)

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None

        from src.agents.init import cancel_agent

        for key in list(self._running_sessions):
            parts = key.split(":", 1)
            if len(parts) == 2:
                cancel_agent(parts[0], parts[1])

    def get_active_sessions(self) -> list[str]:
        return list(self._running_sessions)

    def get_stats(self) -> dict:
        return {
            "active": len(self._running_sessions),
            "pending": sum(len(v) for v in self._pending.values()),
        }


_adapter: GatewayAdapter | None = None


def get_gateway_adapter() -> GatewayAdapter:
    global _adapter
    if _adapter is None:
        _adapter = GatewayAdapter()
    return _adapter
