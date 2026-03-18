"""Background service initialization, matching TS background/index.ts."""

from __future__ import annotations

from src.background.cron import CronService, get_cron_service
from src.background.heartbeat import HeartbeatService, get_heartbeat_service
from src.background.outbox import OutboxWorker, get_outbox
from src.utils.logger import create_logger

log = create_logger("background")


def init_background_services() -> dict:
    """Wire up outbox delivery handlers and return service instances."""
    cron = get_cron_service()
    heartbeat = get_heartbeat_service()
    outbox = get_outbox()

    # WebSocket delivery handler
    async def _ws_deliver(message: dict) -> None:
        target = message.get("target", {})
        if target.get("channel") != "webchat":
            return
        try:
            from src.gateway.websocket import broadcast_event
            await broadcast_event("agent_proactive", {
                "source": message.get("source"),
                "content": message.get("content"),
                "jobId": message.get("jobId"),
            })
        except Exception as e:
            log.warn("WebSocket delivery failed", {"error": str(e)})

    # Feishu delivery handler
    async def _feishu_deliver(message: dict) -> None:
        target = message.get("target", {})
        if target.get("channel") != "feishu":
            return
        try:
            from src.config import get_config
            config = get_config()
            feishu = config.channels.feishu
            if not feishu.app_id or not feishu.app_secret:
                return

            from src.channels.feishu_api import get_tenant_token, send_feishu_message
            token = await get_tenant_token(feishu.app_id, feishu.app_secret)
            peer_id = target.get("peerId", "")
            if peer_id and peer_id != "broadcast":
                await send_feishu_message(token, peer_id, message.get("content", ""))
        except Exception as e:
            log.warn("Feishu delivery failed", {"error": str(e)})

    outbox.on_deliver(_ws_deliver)
    outbox.on_deliver(_feishu_deliver)

    log.info("Background services initialized")
    return {"cron": cron, "heartbeat": heartbeat, "outbox": outbox}
