"""SQLite-backed session manager, matching TS sessions/manager.ts."""

from __future__ import annotations

import json
import time
from pathlib import Path

import aiosqlite

from src.types import ChatMessage, Session, ToolCall, ToolCallFunction
from src.config import get_config
from src.utils.logger import create_logger

log = create_logger("sessions")

_db_path: str | None = None


def _get_db_path() -> str:
    global _db_path
    if _db_path is None:
        config = get_config()
        _db_path = config.storage.db_path
        Path(_db_path).parent.mkdir(parents=True, exist_ok=True)
    return _db_path


def _connect() -> aiosqlite.Connection:
    """Create a new aiosqlite connection. Use as `async with _connect() as db:`."""
    return aiosqlite.connect(_get_db_path())


async def _get_db() -> aiosqlite.Connection:
    """Open a connection with WAL mode and row_factory set."""
    db = await aiosqlite.connect(_get_db_path())
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA journal_mode = WAL")
    await db.execute("PRAGMA synchronous = NORMAL")
    return db


async def init_db() -> None:
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode = WAL")
        await db.execute("PRAGMA synchronous = NORMAL")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                channel TEXT NOT NULL,
                peer_id TEXT NOT NULL,
                messages TEXT NOT NULL DEFAULT '[]',
                metadata TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_consolidated INTEGER NOT NULL DEFAULT 0
            )
        """)
        # Migration: add column if missing
        try:
            await db.execute(
                "ALTER TABLE sessions ADD COLUMN last_consolidated INTEGER NOT NULL DEFAULT 0"
            )
        except Exception:
            pass
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_sessions_channel_peer
            ON sessions(channel, peer_id)
        """)
        await db.commit()
    log.info("Database initialized", {"path": _get_db_path()})


def _msg_to_dict(msg: ChatMessage) -> dict:
    d: dict = {"role": msg.role, "content": msg.content, "timestamp": msg.timestamp}
    if msg.name:
        d["name"] = msg.name
    if msg.tool_call_id:
        d["toolCallId"] = msg.tool_call_id
    if msg.tool_calls:
        d["toolCalls"] = [
            {
                "id": tc.id,
                "type": tc.type,
                "function": {"name": tc.function.name, "arguments": tc.function.arguments},
            }
            for tc in msg.tool_calls
        ]
    return d


def _dict_to_msg(d: dict) -> ChatMessage:
    tool_calls = None
    if raw_tcs := d.get("toolCalls"):
        tool_calls = [
            ToolCall(
                id=tc["id"],
                type=tc.get("type", "function"),
                function=ToolCallFunction(
                    name=tc["function"]["name"],
                    arguments=tc["function"]["arguments"],
                ),
            )
            for tc in raw_tcs
        ]
    return ChatMessage(
        role=d["role"],
        content=d.get("content", ""),
        name=d.get("name"),
        tool_call_id=d.get("toolCallId"),
        tool_calls=tool_calls,
        timestamp=d.get("timestamp", 0),
    )


def _repair_transcript(messages: list[ChatMessage]) -> tuple[list[ChatMessage], int]:
    """Inject synthetic tool results for orphaned tool calls."""
    out: list[ChatMessage] = []
    repaired_count = 0

    for i, msg in enumerate(messages):
        out.append(msg)

        if msg.role != "assistant" or not msg.tool_calls:
            continue

        responded_ids: set[str] = set()
        j = i + 1
        while j < len(messages) and messages[j].role == "tool":
            if messages[j].tool_call_id:
                responded_ids.add(messages[j].tool_call_id)
            j += 1

        for tc in msg.tool_calls:
            if tc.id not in responded_ids:
                out.append(
                    ChatMessage(
                        role="tool",
                        content="[Tool execution was interrupted. Please retry the task.]",
                        tool_call_id=tc.id,
                        timestamp=msg.timestamp + 1,
                    )
                )
                repaired_count += 1

    return out, repaired_count


async def get_or_create_session(channel: str, peer_id: str) -> Session:
    session_id = f"{channel}:{peer_id}"
    now = int(time.time() * 1000)

    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        row = await cursor.fetchone()

        if row:
            raw_messages = [_dict_to_msg(m) for m in json.loads(row["messages"])]
            messages, repaired_count = _repair_transcript(raw_messages)

            if repaired_count > 0:
                log.warn(
                    "Repaired broken tool call transcript",
                    {"id": session_id, "repairedCount": repaired_count},
                )
                await db.execute(
                    "UPDATE sessions SET messages = ?, updated_at = ? WHERE id = ?",
                    (json.dumps([_msg_to_dict(m) for m in messages]), now, session_id),
                )
                await db.commit()

            return Session(
                id=row["id"],
                channel=row["channel"],
                peer_id=row["peer_id"],
                messages=messages,
                metadata=json.loads(row["metadata"]),
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )

        session = Session(
            id=session_id,
            channel=channel,
            peer_id=peer_id,
            messages=[],
            metadata={},
            created_at=now,
            updated_at=now,
        )
        await db.execute(
            "INSERT INTO sessions (id, channel, peer_id, messages, metadata, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                session.id,
                session.channel,
                session.peer_id,
                "[]",
                "{}",
                session.created_at,
                session.updated_at,
            ),
        )
        await db.commit()
        log.info("Session created", {"id": session_id})
        return session


async def append_message(session_id: str, message: ChatMessage) -> None:
    config = get_config()
    max_history = config.agent.max_history_messages
    now = int(time.time() * 1000)

    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT messages FROM sessions WHERE id = ?", (session_id,))
        row = await cursor.fetchone()

        if not row:
            log.warn("Session not found for append", {"id": session_id})
            return

        messages = json.loads(row["messages"])
        messages.append(_msg_to_dict(message))

        if len(messages) > max_history:
            messages = messages[len(messages) - max_history :]

        await db.execute(
            "UPDATE sessions SET messages = ?, updated_at = ? WHERE id = ?",
            (json.dumps(messages), now, session_id),
        )
        await db.commit()


async def get_session_messages(session_id: str) -> list[ChatMessage]:
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT messages FROM sessions WHERE id = ?", (session_id,))
        row = await cursor.fetchone()

    if not row:
        return []
    return [_dict_to_msg(m) for m in json.loads(row["messages"])]


async def reset_session(session_id: str) -> None:
    now = int(time.time() * 1000)
    async with _connect() as db:
        await db.execute(
            "UPDATE sessions SET messages = '[]', updated_at = ? WHERE id = ?",
            (now, session_id),
        )
        await db.commit()
    log.info("Session reset", {"id": session_id})


async def remove_consolidated_messages(session_id: str, count: int) -> None:
    now = int(time.time() * 1000)

    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT messages, last_consolidated FROM sessions WHERE id = ?", (session_id,)
        )
        row = await cursor.fetchone()
        if not row:
            return

        messages = json.loads(row["messages"])
        trimmed = messages[count:]
        consolidated = row["last_consolidated"] + count

        await db.execute(
            "UPDATE sessions SET messages = ?, last_consolidated = ?, updated_at = ? WHERE id = ?",
            (json.dumps(trimmed), consolidated, now, session_id),
        )
        await db.commit()

    log.info("Consolidated messages removed", {"id": session_id, "removed": count})


async def list_sessions() -> list[Session]:
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM sessions ORDER BY updated_at DESC")
        rows = await cursor.fetchall()

    return [
        Session(
            id=row["id"],
            channel=row["channel"],
            peer_id=row["peer_id"],
            messages=[_dict_to_msg(m) for m in json.loads(row["messages"])],
            metadata=json.loads(row["metadata"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
        for row in rows
    ]
