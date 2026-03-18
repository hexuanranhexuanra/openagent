"""LLM-driven memory consolidation — extracts important information from
conversation history and persists to MEMORY.md / HISTORY.md.

Inspired by Nanobot's consolidation design: uses a separate LLM call with a
save_memory tool to get structured output, rather than parsing free text.
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING
from weakref import WeakValueDictionary

from src.evolution.memory import get_memory_store
from src.sessions.manager import (
    get_session_messages,
    get_unconsolidated_count,
    update_consolidation_pointer,
)
from src.types import ChatMessage, ToolDefinition
from src.utils.logger import create_logger

if TYPE_CHECKING:
    from src.models.base import LLMProvider

log = create_logger("evolution:consolidation")

# ── save_memory tool definition (for consolidation LLM call only) ──

SAVE_MEMORY_TOOL = ToolDefinition(
    name="save_memory",
    description="Save consolidated memory from conversation history.",
    parameters={
        "type": "object",
        "properties": {
            "history_entry": {
                "type": "string",
                "description": (
                    "A 2-5 sentence summary paragraph for HISTORY.md. "
                    "Include timestamps, key decisions, outcomes, and tools used. "
                    "Focus on facts and decisions, not conversational flow."
                ),
            },
            "memory_update": {
                "type": "string",
                "description": (
                    "Complete updated MEMORY.md content. Merge new information "
                    "into existing sections. Only provide this if the conversation "
                    "revealed NEW information worth remembering. Preserve ALL "
                    "existing content unless explicitly contradicted."
                ),
            },
        },
        "required": ["history_entry"],
    },
)

CONSOLIDATION_SYSTEM_PROMPT = """\
You are a memory consolidation agent. Your job is to extract important \
information from conversation history and persist it.

You MUST call the save_memory tool exactly once.

## history_entry (ALWAYS required)
Write a concise 2-5 sentence summary of what happened. Include key decisions \
and outcomes. This goes to HISTORY.md as an append-only event log.

## memory_update (RARELY needed — omit in most cases)
Only provide memory_update when the conversation contains NEW, DURABLE \
information that will be useful across future sessions. This fully replaces \
MEMORY.md, so you must merge new info into the existing content.

### WRITE to memory_update:
- User-stated preferences or corrections ("I prefer dark mode", "don't use mocks")
- Project-level facts (tech stack, architecture decisions, team structure)
- Explicit technical decisions with rationale
- Contact info, account details, recurring workflows

### DO NOT write to memory_update:
- The user's questions or requests (these are ephemeral tasks, not facts)
- Debugging sessions, error messages, troubleshooting steps
- One-time Q&A, code explanations, how-to answers
- Anything already in the current MEMORY.md
- Conversation flow or dialogue summaries (that's what history_entry is for)
- Temporary task context ("user asked me to fix bug X")

When in doubt, omit memory_update. Most conversations produce ONLY a \
history_entry. A good rule: if the information wouldn't help a different \
agent handle a future conversation with this user, don't put it in memory."""

SAFETY_MARGIN = 1.2
OVERHEAD_TOKENS = 4096


def estimate_tokens(messages: list[ChatMessage]) -> int:
    total_chars = 0
    for msg in messages:
        total_chars += len(msg.content)
        if msg.tool_calls:
            for tc in msg.tool_calls:
                total_chars += len(tc.function.name) + len(tc.function.arguments)
    return int((total_chars / 4) * SAFETY_MARGIN)


def _format_messages(messages: list[ChatMessage]) -> str:
    """Format messages for the consolidation LLM, with timestamps and tool annotations."""
    lines: list[str] = []
    for msg in messages:
        ts = datetime.fromtimestamp(msg.timestamp / 1000, tz=timezone.utc).strftime(
            "%Y-%m-%d %H:%M"
        ) if msg.timestamp else "unknown"

        if msg.role == "user":
            lines.append(f"[{ts}] USER: {msg.content[:1000]}")
        elif msg.role == "assistant":
            tools_used = ""
            if msg.tool_calls:
                tool_names = [tc.function.name for tc in msg.tool_calls]
                tools_used = f" [tools: {', '.join(tool_names)}]"
            content = msg.content[:1000] if msg.content else ""
            lines.append(f"[{ts}] ASSISTANT{tools_used}: {content}")
        elif msg.role == "tool":
            # Summarize tool results briefly
            content = msg.content[:200] if msg.content else ""
            lines.append(f"[{ts}] TOOL_RESULT: {content}")

    return "\n".join(lines)


def _parse_tool_call_args(raw_args) -> dict:
    """Parse tool call arguments with type tolerance (dict, str, list)."""
    if isinstance(raw_args, dict):
        return raw_args
    if isinstance(raw_args, str):
        try:
            parsed = json.loads(raw_args)
            if isinstance(parsed, dict):
                return parsed
            if isinstance(parsed, list) and parsed:
                return parsed[0] if isinstance(parsed[0], dict) else {}
        except json.JSONDecodeError:
            return {}
    if isinstance(raw_args, list) and raw_args:
        return raw_args[0] if isinstance(raw_args[0], dict) else {}
    return {}


class ConsolidationManager:
    """Manages LLM-driven memory consolidation with concurrency safety."""

    def __init__(
        self,
        provider: LLMProvider,
        consolidation_window: int = 50,
    ) -> None:
        self._provider = provider
        self._window = consolidation_window
        self._active: set[str] = set()
        self._locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()
        self._tasks: set[asyncio.Task] = set()

    async def maybe_consolidate(self, session_id: str) -> None:
        """Check if consolidation is needed and run it in the background if so."""
        if session_id in self._active:
            return

        unconsolidated = await get_unconsolidated_count(session_id)
        if unconsolidated < self._window:
            return

        log.info("Consolidation triggered", {
            "session": session_id,
            "unconsolidated": unconsolidated,
            "window": self._window,
        })

        task = asyncio.create_task(self._run_safe(session_id, archive_all=False))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def force_consolidate(self, session_id: str, archive_all: bool = True) -> bool:
        """Force consolidation now (e.g. /new command). Returns True on success."""
        return await self._run_safe(session_id, archive_all=archive_all)

    async def _run_safe(self, session_id: str, archive_all: bool) -> bool:
        lock = self._locks.get(session_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[session_id] = lock

        if lock.locked():
            log.debug("Consolidation already running", {"session": session_id})
            return False

        async with lock:
            self._active.add(session_id)
            try:
                return await self._consolidate(session_id, archive_all)
            except Exception as e:
                log.warn("Consolidation failed", {"session": session_id, "error": str(e)})
                return False
            finally:
                self._active.discard(session_id)

    async def _consolidate(self, session_id: str, archive_all: bool) -> bool:
        messages = await get_session_messages(session_id)
        if not messages:
            return False

        store = get_memory_store()

        if archive_all:
            to_consolidate = messages
            keep_count = 0
        else:
            keep_count = max(self._window // 2, 3)
            if len(messages) <= keep_count:
                return False
            to_consolidate = messages[:-keep_count]

        if not to_consolidate:
            return False

        # Format messages for the consolidation LLM
        formatted = _format_messages(to_consolidate)

        # Check if the formatted text is too large; if so, split
        formatted_tokens = estimate_tokens(
            [ChatMessage(role="user", content=formatted, timestamp=0)]
        )
        max_budget = 80_000  # Leave room for system prompt + memory

        if formatted_tokens > max_budget and len(to_consolidate) > 4:
            mid = len(to_consolidate) // 2
            first_result = await self._call_consolidation_llm(
                _format_messages(to_consolidate[:mid]), store
            )
            second_result = await self._call_consolidation_llm(
                _format_messages(to_consolidate[mid:]), store
            )
            # Merge: combine history entries, use second memory_update as base
            history = (first_result.get("history_entry", "") + "\n\n"
                       + second_result.get("history_entry", ""))
            memory_update = second_result.get("memory_update") or first_result.get("memory_update")
            result = {"history_entry": history.strip(), "memory_update": memory_update}
        else:
            result = await self._call_consolidation_llm(formatted, store)

        # Persist results
        if result.get("history_entry"):
            await store.append_history(result["history_entry"])
            await store.append_daily_log(result["history_entry"])

        if result.get("memory_update"):
            current = await store.read_long_term()
            if result["memory_update"].strip() != current.strip():
                await store.write_long_term(result["memory_update"])

        # Move the consolidation pointer
        new_pointer = len(messages) - keep_count
        await update_consolidation_pointer(session_id, new_pointer)

        log.info("Consolidation complete", {
            "session": session_id,
            "consolidated": len(to_consolidate),
            "kept": keep_count,
        })
        return True

    async def _call_consolidation_llm(
        self, formatted_messages: str, store
    ) -> dict:
        """Make a single LLM call with the save_memory tool."""
        current_memory = await store.read_long_term()

        user_content = (
            f"Current MEMORY.md:\n```\n{current_memory}\n```\n\n"
            f"Conversation to consolidate:\n```\n{formatted_messages}\n```"
        )

        user_msg = ChatMessage(
            role="user", content=user_content, timestamp=int(time.time() * 1000)
        )

        text_parts: list[str] = []
        tool_calls = []

        async for chunk in self._provider.chat(
            [user_msg],
            tools=[SAVE_MEMORY_TOOL],
            system_prompt=CONSOLIDATION_SYSTEM_PROMPT,
        ):
            if chunk.type == "text" and chunk.content:
                text_parts.append(chunk.content)
            elif chunk.type == "tool_call" and chunk.tool_call:
                tool_calls.append(chunk.tool_call)

        # Extract result from tool call
        if tool_calls:
            for tc in tool_calls:
                if tc.function.name == "save_memory":
                    return _parse_tool_call_args(tc.function.arguments)

        # Fallback: try to parse text response as JSON (some providers may not support tool_choice)
        raw_text = "".join(text_parts).strip()
        if raw_text:
            log.warn("Consolidation LLM did not use save_memory tool, attempting JSON parse")
            try:
                import re
                cleaned = re.sub(r"^```(?:json)?\s*", "", raw_text)
                cleaned = re.sub(r"\s*```$", "", cleaned)
                parsed = json.loads(cleaned)
                if isinstance(parsed, dict) and "history_entry" in parsed:
                    return parsed
            except (json.JSONDecodeError, ValueError):
                pass

            # Last resort: treat entire text as history entry
            return {"history_entry": raw_text[:500]}

        raise ValueError("Consolidation LLM returned neither tool call nor text")


# ── Context-pressure auto-flush ──

async def check_context_pressure(
    session_id: str,
    prompt_tokens: int,
    context_window: int,
    consolidation_mgr: ConsolidationManager,
    threshold: float = 0.65,
    _flushed: set[str] | None = None,
) -> None:
    """Auto-flush memory when context utilization exceeds threshold."""
    if _flushed is None:
        _flushed = _context_flush_tracker

    if not context_window or prompt_tokens <= 0:
        return

    utilization = prompt_tokens / context_window
    if utilization < threshold:
        return

    if session_id in _flushed:
        return

    log.info("Context pressure detected, auto-flushing", {
        "session": session_id,
        "utilization": f"{utilization:.0%}",
    })
    _flushed.add(session_id)
    await consolidation_mgr.force_consolidate(session_id, archive_all=False)


# Track which sessions have been flushed this process lifetime
_context_flush_tracker: set[str] = set()


# ── Singleton ──

_manager: ConsolidationManager | None = None


def get_consolidation_manager() -> ConsolidationManager | None:
    return _manager


def init_consolidation_manager(
    provider: LLMProvider, consolidation_window: int = 50
) -> ConsolidationManager:
    global _manager
    _manager = ConsolidationManager(provider, consolidation_window)
    return _manager
