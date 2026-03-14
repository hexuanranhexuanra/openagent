"""Feishu WebSocket channel — placeholder for lark-oapi integration."""

from __future__ import annotations

import re
from typing import Any

from src.types import IncomingMessage, OutgoingMessage
from src.channels.base import MessageHandler
from src.utils.logger import create_logger

log = create_logger("channels:feishu-ws")


class FeishuChannel:
    def __init__(self, app_id: str, app_secret: str) -> None:
        self._app_id = app_id
        self._app_secret = app_secret
        self._handler: MessageHandler | None = None

    @property
    def type(self) -> str:
        return "feishu"

    def on_message(self, handler: MessageHandler) -> None:
        self._handler = handler

    async def start(self) -> None:
        try:
            from lark_oapi.api.bot.v3 import GetBotInfoRequest
            import lark_oapi as lark

            # Validate credentials
            client = lark.Client.builder().app_id(self._app_id).app_secret(self._app_secret).build()
            req = GetBotInfoRequest.builder().build()
            resp = client.bot.v3.bot_info.get(req)
            if not resp.success():
                raise RuntimeError(f"Feishu credential validation failed: {resp.msg}")

            log.info("Feishu channel connected", {"bot": resp.data.bot.open_id if resp.data else "unknown"})

            # TODO: Set up WSClient event dispatcher for long-lived connection
            # This requires lark_oapi WebSocket support which varies by SDK version
            log.warn("Feishu WebSocket long connection not yet implemented in Python SDK")

        except ImportError:
            log.error("lark-oapi not installed. Run: pip install lark-oapi")
            raise
        except Exception as e:
            log.error("Feishu channel start failed", {"error": str(e)})
            raise

    async def stop(self) -> None:
        log.info("Feishu channel stopped")

    async def send(self, message: OutgoingMessage) -> None:
        from src.channels.feishu_api import feishu_reply

        await feishu_reply(
            self._app_id,
            self._app_secret,
            receive_id=message.peer_id,
            text=message.content,
            message_id=message.reply_to_id,
        )

    def _strip_mention(self, text: str) -> str:
        return re.sub(r"@_user_\d+\s*", "", text).strip()
