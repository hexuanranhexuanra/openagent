"""API routes — FastAPI router matching TS gateway/routes.ts."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from secrets import token_hex

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from src.utils.audit import audit_log
from src.utils.logger import create_logger
from src.middleware.auth import verify_bearer_token

log = create_logger("gateway:routes")

router = APIRouter()

_start_time = time.time()


# ── Health & Status ──

@router.get("/health")
async def health():
    return {"status": "ok", "uptime": time.time() - _start_time, "timestamp": time.time()}


@router.get("/status")
async def status():
    import psutil
    proc = psutil.Process(os.getpid()) if "psutil" in dir() else None
    return {
        "version": "0.1.0",
        "runtime": "python",
        "pid": os.getpid(),
        "memoryMB": round(proc.memory_info().rss / 1024 / 1024, 1) if proc else 0,
        "uptime": time.time() - _start_time,
    }


# ── Agent Tasks ──

@router.get("/agent/tasks", dependencies=[Depends(verify_bearer_token)])
async def list_agent_tasks():
    from src.agents.engine import get_agent_engine
    engine = get_agent_engine()
    active = engine.get_active_sessions()
    sessions = []
    for key in active:
        parts = key.split(":", 1)
        if len(parts) == 2:
            info = engine.get_task_info(parts[0], parts[1])
            if info:
                sessions.append({
                    "sessionKey": info.session_key,
                    "taskId": info.task_id,
                    "status": info.status,
                    "startedAt": info.started_at,
                })
    return {"activeSessions": active, "sessions": sessions}


@router.delete("/agent/tasks/{channel}/{peer_id}", dependencies=[Depends(verify_bearer_token)])
async def cancel_agent_task(channel: str, peer_id: str):
    from src.agents.init import cancel_agent
    cancelled = cancel_agent(channel, peer_id)
    return {"cancelled": cancelled, "channel": channel, "peerId": peer_id}


# ── Sessions ──

@router.get("/sessions", dependencies=[Depends(verify_bearer_token)])
async def list_sessions():
    from src.sessions.manager import list_sessions as _list
    sessions = await _list()
    return {
        "sessions": [
            {
                "id": s.id,
                "channel": s.channel,
                "peerId": s.peer_id,
                "messageCount": len(s.messages),
                "createdAt": s.created_at,
                "updatedAt": s.updated_at,
            }
            for s in sessions
        ]
    }


@router.post("/sessions/{session_id}/reset", dependencies=[Depends(verify_bearer_token)])
async def reset_session(session_id: str):
    from src.sessions.manager import reset_session as _reset
    await _reset(session_id)
    return {"ok": True, "sessionId": session_id}


# ── Tools ──

@router.get("/tools", dependencies=[Depends(verify_bearer_token)])
async def list_tools():
    from src.tools.registry import get_all_tool_definitions
    tools = get_all_tool_definitions()
    return {"tools": [{"name": t.name, "description": t.description, "parameters": t.parameters} for t in tools]}


# ── Chat ──

@router.post("/chat", dependencies=[Depends(verify_bearer_token)])
async def sync_chat(request: Request):
    body = await request.json()
    message = body.get("message", "")
    peer_id = body.get("peerId", f"api:{token_hex(4)}")
    channel = "api"

    if not message:
        raise HTTPException(400, "message required")

    task_id = token_hex(5)
    audit_log(task_id=task_id, action="sync_chat", who=peer_id, channel=channel)

    from src.agents.init import run_agent
    text_parts: list[str] = []

    async for event in run_agent(channel, peer_id, message):
        if event.type == "text" and event.content:
            text_parts.append(event.content)
        elif event.type == "error":
            return JSONResponse(
                status_code=500,
                content={"error": event.error, "taskId": task_id},
            )

    return {"response": "".join(text_parts), "taskId": task_id}


@router.post("/chat/async", dependencies=[Depends(verify_bearer_token)])
async def async_chat(request: Request):
    body = await request.json()
    message = body.get("message", "")
    peer_id = body.get("peerId", f"api:{token_hex(4)}")
    channel = body.get("channel", "api")

    if not message:
        raise HTTPException(400, "message required")

    from src.queue.worker import enqueue_message, MessageJob
    job = MessageJob.create(channel=channel, peer_id=peer_id, content=message)
    await enqueue_message(job)

    audit_log(task_id=job.task_id, action="async_chat_enqueued", who=peer_id, channel=channel)
    return JSONResponse(status_code=202, content={"taskId": job.task_id, "status": "queued"})


# ── Webhooks ──

@router.post("/webhook/generic")
async def generic_webhook(request: Request):
    body = await request.json()
    source = body.get("source", "generic")
    peer_id = body.get("peerId", "webhook")
    message = body.get("message", "")

    if not message:
        raise HTTPException(400, "message required")

    from src.queue.worker import enqueue_message, MessageJob
    job = MessageJob.create(channel=source, peer_id=peer_id, content=message)
    await enqueue_message(job)

    return JSONResponse(status_code=202, content={"taskId": job.task_id, "status": "queued"})


@router.post("/webhook/feishu")
async def feishu_webhook(request: Request):
    body = await request.json()

    # URL challenge verification
    if "challenge" in body:
        return {"challenge": body["challenge"]}

    # Signature verification
    from src.config import get_config
    config = get_config()
    encrypt_key = config.channels.feishu.encrypt_key

    if encrypt_key:
        from src.middleware.auth import verify_lark_signature
        timestamp = request.headers.get("X-Lark-Request-Timestamp", "")
        nonce = request.headers.get("X-Lark-Request-Nonce", "")
        signature = request.headers.get("X-Lark-Signature", "")
        raw_body = (await request.body()).decode("utf-8")

        if not verify_lark_signature(encrypt_key, timestamp, nonce, raw_body, signature):
            raise HTTPException(401, "Invalid signature")

    # Idempotency check
    from src.middleware.idempotency import idempotency_store
    header = body.get("header", {})
    event_id = header.get("event_id", "")
    if event_id and idempotency_store.is_duplicate(event_id):
        return {"code": 0, "msg": "duplicate"}

    # Process message event
    event = body.get("event", {})
    event_type = header.get("event_type", "")

    if event_type == "im.message.receive_v1":
        msg = event.get("message", {})
        content_str = msg.get("content", "{}")
        try:
            content = json.loads(content_str)
            text = content.get("text", "")
        except json.JSONDecodeError:
            text = content_str

        sender = event.get("sender", {}).get("sender_id", {})
        peer = sender.get("open_id", "unknown")

        import re
        text = re.sub(r"@_user_\d+\s*", "", text).strip()

        if not text:
            return {"code": 0, "msg": "empty"}

        from src.queue.worker import enqueue_message, MessageJob
        job = MessageJob.create(
            channel="feishu",
            peer_id=peer,
            content=text,
            feishu_message_id=msg.get("message_id"),
            chat_id=msg.get("chat_id"),
        )
        await enqueue_message(job)
        audit_log(task_id=job.task_id, action="feishu_message", who=peer, channel="feishu")

    return {"code": 0, "msg": "ok"}


# ── Config ──

def _mask(value: str, keep: int = 8) -> str:
    if not value or len(value) <= keep:
        return value
    return value[:keep] + "..."


@router.get("/config", dependencies=[Depends(verify_bearer_token)])
async def get_config_route():
    from src.config import get_config
    config = get_config()
    raw = config.model_dump(by_alias=True)
    # Mask sensitive
    if p := raw.get("providers"):
        if oai := p.get("openai"):
            if oai.get("apiKey"): oai["apiKey"] = _mask(oai["apiKey"])
        if ant := p.get("anthropic"):
            if ant.get("apiKey"): ant["apiKey"] = _mask(ant["apiKey"])
            if ant.get("setupToken"): ant["setupToken"] = _mask(ant["setupToken"])
    if ch := raw.get("channels"):
        if feishu := ch.get("feishu"):
            if feishu.get("appSecret"): feishu["appSecret"] = _mask(feishu["appSecret"], 4)
    return raw


@router.put("/config", dependencies=[Depends(verify_bearer_token)])
async def update_config(request: Request):
    updates = await request.json()
    config_path = Path("openagent.json")
    existing = json.loads(config_path.read_text()) if config_path.exists() else {}

    def deep_merge(base, upd):
        for k, v in upd.items():
            if isinstance(v, dict) and isinstance(base.get(k), dict):
                deep_merge(base[k], v)
            else:
                base[k] = v
        return base

    merged = deep_merge(existing, updates)
    config_path.write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n")

    from src.config import reload_config
    reload_config()
    return {"ok": True, "message": f"Config updated: {', '.join(updates.keys())}"}


@router.get("/config/schema", dependencies=[Depends(verify_bearer_token)])
async def config_schema():
    from src.config.schema import AppConfig
    schema = AppConfig.model_json_schema()
    return {"schema": schema, "version": "0.2.0", "generatedAt": time.time()}


# ── Memory ──

@router.get("/memory/{file}", dependencies=[Depends(verify_bearer_token)])
async def get_memory(file: str):
    file_upper = file.upper()
    if file_upper not in ("SOUL", "USER", "WORLD"):
        raise HTTPException(400, "Invalid file. Must be SOUL, USER, or WORLD.")
    from src.evolution.memory import get_memory_store
    content = await get_memory_store().read(file_upper)
    return {"file": file_upper, "content": content}


@router.put("/memory/{file}", dependencies=[Depends(verify_bearer_token)])
async def put_memory(file: str, request: Request):
    file_upper = file.upper()
    if file_upper not in ("SOUL", "USER", "WORLD"):
        raise HTTPException(400, "Invalid file.")
    body = await request.json()
    content = body.get("content", "")
    from src.evolution.memory import get_memory_store
    await get_memory_store().write(file_upper, content)
    return {"file": file_upper, "updated": True}


@router.get("/memory", dependencies=[Depends(verify_bearer_token)])
async def get_all_memory():
    from src.evolution.memory import get_memory_store
    soul, user, world = await get_memory_store().read_all()
    return {"soul": soul, "user": user, "world": world}


# ── Skills ──

@router.get("/skills", dependencies=[Depends(verify_bearer_token)])
async def list_skills():
    from src.evolution.skill_loader import get_skill_loader
    loader = get_skill_loader()
    return {"files": loader.list_skill_files(), "loaded": loader.get_catalog()}


# ── Cron ──

@router.get("/cron/jobs", dependencies=[Depends(verify_bearer_token)])
async def list_cron_jobs():
    from src.background.cron import get_cron_service
    return {"jobs": get_cron_service().list_jobs()}


@router.post("/cron/jobs", dependencies=[Depends(verify_bearer_token)])
async def create_cron_job(request: Request):
    body = await request.json()
    from src.background.cron import get_cron_service
    try:
        job = get_cron_service().add_job(
            name=body.get("name", ""),
            cron_expr=body.get("cron_expr", ""),
            task=body.get("task", ""),
            target_channel=body.get("target_channel", "webchat"),
            target_peer=body.get("target_peer", "broadcast"),
        )
        return {"job": job}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/cron/jobs/{job_id}", dependencies=[Depends(verify_bearer_token)])
async def delete_cron_job(job_id: str):
    from src.background.cron import get_cron_service
    removed = get_cron_service().remove_job(job_id)
    return {"removed": removed, "id": job_id}


@router.post("/cron/jobs/{job_id}/trigger", dependencies=[Depends(verify_bearer_token)])
async def trigger_cron_job(job_id: str):
    from src.background.cron import get_cron_service
    triggered = await get_cron_service().trigger_now(job_id)
    return {"triggered": triggered, "id": job_id}


# ── Subagents ──

@router.get("/subagents", dependencies=[Depends(verify_bearer_token)])
async def list_subagents():
    from src.agents.subagent import _subagent_depths
    return {"subagents": list(_subagent_depths.keys())}


# ── Heartbeat ──

@router.get("/heartbeat", dependencies=[Depends(verify_bearer_token)])
async def get_heartbeat():
    import re
    from pathlib import Path
    heartbeat_path = Path("user-space/memory/HEARTBEAT.md")
    if not heartbeat_path.exists():
        return {"tasks": [], "content": ""}
    content = heartbeat_path.read_text(encoding="utf-8")
    tasks = re.findall(r"^-\s+\[\s+\]\s*(.*)", content, re.MULTILINE)
    return {"tasks": tasks, "content": content}


@router.post("/heartbeat/tick", dependencies=[Depends(verify_bearer_token)])
async def trigger_heartbeat():
    import asyncio
    from src.background.heartbeat import get_heartbeat_service
    asyncio.get_event_loop().create_task(get_heartbeat_service().tick())
    return {"triggered": True}
