"""Feishu/Lark REST API helpers, matching TS channels/feishu-api.ts."""

from __future__ import annotations

import json
import time

import httpx

from src.utils.logger import create_logger

log = create_logger("channels:feishu-api")

FEISHU_BASE = "https://open.feishu.cn/open-apis"

_token_cache: dict[str, dict] = {}


async def get_tenant_token(app_id: str, app_secret: str) -> str:
    cache_key = f"{app_id}:{app_secret}"
    cached = _token_cache.get(cache_key)

    if cached and cached["expires_at"] > time.time() + 300:  # 5-min buffer
        return cached["token"]

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{FEISHU_BASE}/auth/v3/tenant_access_token/internal",
            json={"app_id": app_id, "app_secret": app_secret},
        )
        data = resp.json()

    if data.get("code") != 0:
        raise RuntimeError(f"Failed to get tenant token: {data.get('msg')}")

    token = data["tenant_access_token"]
    expire = data.get("expire", 7200)
    _token_cache[cache_key] = {
        "token": token,
        "expires_at": time.time() + expire,
    }
    return token


async def send_feishu_message(
    token: str,
    receive_id: str,
    text: str,
    receive_id_type: str = "open_id",
) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{FEISHU_BASE}/im/v1/messages",
            params={"receive_id_type": receive_id_type},
            headers={"Authorization": f"Bearer {token}"},
            json={
                "receive_id": receive_id,
                "msg_type": "text",
                "content": json.dumps({"text": text}),
            },
        )
        data = resp.json()

    if data.get("code") != 0:
        log.warn("Send message failed", {"code": data.get("code"), "msg": data.get("msg")})
    return data


async def reply_feishu_message(token: str, message_id: str, text: str) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{FEISHU_BASE}/im/v1/messages/{message_id}/reply",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "msg_type": "text",
                "content": json.dumps({"text": text}),
            },
        )
        return resp.json()


async def feishu_reply(
    app_id: str,
    app_secret: str,
    *,
    receive_id: str,
    text: str,
    message_id: str | None = None,
    receive_id_type: str = "open_id",
) -> dict:
    """High-level helper: auto-refresh token, prefer reply, fallback to new message."""
    token = await get_tenant_token(app_id, app_secret)
    if message_id:
        return await reply_feishu_message(token, message_id, text)
    return await send_feishu_message(token, receive_id, text, receive_id_type)
