"""WebSocket handler for real-time chat, matching TS gateway/websocket.ts."""

from __future__ import annotations

import asyncio
import json
import time
from secrets import token_hex
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from src.utils.logger import create_logger

log = create_logger("gateway:ws")

# Connected clients
_clients: dict[str, WebSocket] = {}  # client_id → ws
_client_peers: dict[str, str] = {}  # client_id → peer_id
_session_queues: dict[str, list[str]] = {}  # session_key → pending messages
_running_sessions: set[str] = set()


async def websocket_handler(ws: WebSocket) -> None:
    await ws.accept()

    client_id = token_hex(6)
    peer_id = f"webchat:{client_id}"
    _clients[client_id] = ws
    _client_peers[client_id] = peer_id

    # Send connected event
    await _send(ws, {
        "type": "event",
        "event": "connected",
        "payload": {"clientId": client_id, "peerId": peer_id},
    })

    log.info("WebSocket client connected", {"clientId": client_id})

    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type")
            if msg_type == "req":
                await _handle_request(ws, client_id, peer_id, data)
            elif msg_type == "event" and data.get("event") == "ping":
                await _send(ws, {"type": "event", "event": "pong", "payload": {}})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.debug("WebSocket error", {"clientId": client_id, "error": str(e)})
    finally:
        _clients.pop(client_id, None)
        _client_peers.pop(client_id, None)
        session_key = f"webchat:{peer_id}"
        _session_queues.pop(session_key, None)
        log.info("WebSocket client disconnected", {"clientId": client_id})


async def _handle_request(ws: WebSocket, client_id: str, peer_id: str, data: dict) -> None:
    req_id = data.get("id", "")
    method = data.get("method", "")
    params = data.get("params", {})

    if method == "chat":
        message = params.get("message") or params.get("content", "")
        if not message:
            await _send(ws, {"type": "res", "id": req_id, "ok": False, "error": "message required"})
            return

        session_key = f"webchat:{peer_id}"
        if session_key in _running_sessions:
            queue = _session_queues.setdefault(session_key, [])
            queue.append(message)
            await _send(ws, {
                "type": "res", "id": req_id, "ok": True,
                "payload": {"status": "queued", "position": len(queue)},
            })
            return

        await _send(ws, {"type": "res", "id": req_id, "ok": True, "payload": {"status": "started"}})
        asyncio.get_event_loop().create_task(_run_chat_session(ws, client_id, peer_id, message))

    elif method == "cancel":
        from src.agents.init import cancel_agent
        cancelled = cancel_agent("webchat", peer_id)
        await _send(ws, {"type": "res", "id": req_id, "ok": True, "payload": {"cancelled": cancelled}})

    elif method == "status":
        from src.agents.engine import get_agent_engine
        engine = get_agent_engine()
        await _send(ws, {
            "type": "res", "id": req_id, "ok": True,
            "payload": {
                "uptime": time.time(),
                "clients": len(_clients),
                "activeSessions": engine.get_active_sessions(),
            },
        })

    elif method == "reset":
        from src.sessions.manager import reset_session
        await reset_session(f"webchat:{peer_id}")
        await _send(ws, {"type": "res", "id": req_id, "ok": True, "payload": {"reset": True}})

    else:
        await _send(ws, {"type": "res", "id": req_id, "ok": False, "error": f"Unknown method: {method}"})


async def _run_chat_session(ws: WebSocket, client_id: str, peer_id: str, message: str) -> None:
    session_key = f"webchat:{peer_id}"
    _running_sessions.add(session_key)

    try:
        from src.agents.init import run_agent

        async for event in run_agent("webchat", peer_id, message):
            await _send_stream_event(ws, event)
    except Exception as e:
        await _send(ws, {
            "type": "event", "event": "agent_error",
            "payload": {"error": str(e)},
        })
    finally:
        _running_sessions.discard(session_key)

        # Drain queued messages
        queue = _session_queues.get(session_key, [])
        if queue:
            next_msg = queue.pop(0)
            if not queue:
                _session_queues.pop(session_key, None)
            if client_id in _clients:
                asyncio.get_event_loop().create_task(
                    _run_chat_session(_clients[client_id], client_id, peer_id, next_msg)
                )


async def _send_stream_event(ws: WebSocket, event: Any) -> None:
    try:
        await _send(ws, {
            "type": "event",
            "event": f"agent_{event.type}",
            "payload": {
                "content": event.content,
                "toolName": event.tool_name,
                "toolArgs": event.tool_args,
                "toolResult": event.tool_result,
                "error": event.error,
                "round": event.round,
                "maxRounds": event.max_rounds,
                "usage": {
                    "promptTokens": event.usage.prompt_tokens,
                    "completionTokens": event.usage.completion_tokens,
                    "totalTokens": event.usage.total_tokens,
                } if event.usage else None,
            },
        })
    except Exception:
        pass


async def _send(ws: WebSocket, data: dict) -> None:
    try:
        await ws.send_text(json.dumps(data, ensure_ascii=False))
    except Exception:
        pass


async def broadcast_event(event: str, payload: dict) -> None:
    """Broadcast an event to all connected WebSocket clients."""
    msg = json.dumps({"type": "event", "event": event, "payload": payload}, ensure_ascii=False)
    for ws in list(_clients.values()):
        try:
            await ws.send_text(msg)
        except Exception:
            pass
