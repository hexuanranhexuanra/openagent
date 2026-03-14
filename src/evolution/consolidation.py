"""Context window consolidation via LLM summarization, matching TS evolution/consolidation.ts."""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING

from src.types import ChatMessage
from src.evolution.memory import get_memory_store
from src.utils.logger import create_logger
from src.sessions.manager import get_session_messages, remove_consolidated_messages

if TYPE_CHECKING:
    from src.models.base import LLMProvider

log = create_logger("evolution:consolidation")

COMPACT_AT_RATIO = 0.65
KEEP_RATIO = 0.35
MIN_KEEP_TURNS = 3
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


async def consolidate_if_needed(
    session_id: str, provider: LLMProvider, context_window: int
) -> None:
    try:
        messages = await get_session_messages(session_id)
        total_tokens = estimate_tokens(messages)
        compact_threshold = int(context_window * COMPACT_AT_RATIO)

        if total_tokens < compact_threshold:
            return

        log.info("Consolidation triggered", {
            "sessionId": session_id,
            "tokens": total_tokens,
            "threshold": compact_threshold,
        })

        keep_budget = int(context_window * KEEP_RATIO)
        keep_count = 0
        keep_tokens = 0

        for msg in reversed(messages):
            msg_tokens = estimate_tokens([msg])
            if keep_tokens + msg_tokens > keep_budget and keep_count >= MIN_KEEP_TURNS:
                break
            keep_tokens += msg_tokens
            keep_count += 1

        keep_count = max(keep_count, MIN_KEEP_TURNS)
        to_consolidate = messages[: len(messages) - keep_count]

        if not to_consolidate:
            return

        await _run_consolidation(session_id, to_consolidate, provider)

    except Exception as e:
        log.warn("Consolidation failed (non-fatal)", {"sessionId": session_id, "error": str(e)})


async def _run_consolidation(
    session_id: str, messages: list[ChatMessage], provider: LLMProvider
) -> None:
    memory = get_memory_store()
    base_memory = await memory.read_long_term()

    slice_tokens = estimate_tokens(messages)
    summary_budget = int(COMPACT_AT_RATIO * 128_000) - OVERHEAD_TOKENS

    if slice_tokens > summary_budget and len(messages) > 4:
        mid = len(messages) // 2
        first_half = messages[:mid]
        second_half = messages[mid:]

        summary1 = await _call_summarise(first_half, base_memory, provider)
        summary2 = await _call_summarise(second_half, base_memory, provider)

        result = await _call_merge_summaries(
            summary1 + "\n\n" + summary2, base_memory, provider
        )
    else:
        result = await _call_summarise(messages, base_memory, provider)

    await memory.append_history(result["summary"])

    if result.get("memory_update"):
        await memory.write_long_term(result["memory_update"])

    await remove_consolidated_messages(session_id, len(messages))
    log.info("Consolidation complete", {"sessionId": session_id, "removed": len(messages)})


def _format_conversation(messages: list[ChatMessage]) -> str:
    lines: list[str] = []
    for msg in messages:
        content = msg.content[:500] if msg.content else ""
        if msg.role == "tool":
            lines.append(f"[tool_result:{msg.tool_call_id}]: {content}")
        else:
            lines.append(f"[{msg.role}]: {content}")
    return "\n".join(lines)


def _build_prompt(conversation: str, memory: str) -> str:
    return (
        "Summarise the following conversation into two fields:\n"
        "1. `summary` — a concise paragraph of what happened\n"
        "2. `memory_update` — the full updated content for MEMORY.md, "
        "merging new facts with existing memory below.\n\n"
        f"Current MEMORY.md:\n```\n{memory}\n```\n\n"
        f"Conversation:\n```\n{conversation}\n```\n\n"
        "Respond with valid JSON only — no markdown fences.\n"
        '{"summary": "...", "memory_update": "..."}'
    )


def _build_merge_prompt(combined: str, memory: str) -> str:
    return (
        "Merge these two partial summaries into a single cohesive result:\n\n"
        f"Partial summaries:\n```\n{combined}\n```\n\n"
        f"Current MEMORY.md:\n```\n{memory}\n```\n\n"
        "Respond with valid JSON only — no markdown fences.\n"
        '{"summary": "...", "memory_update": "..."}'
    )


async def _call_summarise(
    messages: list[ChatMessage], memory: str, provider: LLMProvider
) -> dict:
    conversation = _format_conversation(messages)
    prompt = _build_prompt(conversation, memory)
    return await _call_llm(prompt, provider)


async def _call_merge_summaries(combined: str, memory: str, provider: LLMProvider) -> dict:
    prompt = _build_merge_prompt(combined, memory)
    return await _call_llm(prompt, provider)


async def _call_llm(prompt: str, provider: LLMProvider) -> dict:
    user_msg = ChatMessage(role="user", content=prompt, timestamp=0)
    system = "You are a memory consolidation assistant. Respond with valid JSON only — no markdown fences."

    text_parts: list[str] = []
    async for chunk in provider.chat([user_msg], system_prompt=system):
        if chunk.type == "text" and chunk.content:
            text_parts.append(chunk.content)

    raw = "".join(text_parts)
    return _parse_or_throw(raw)


def _parse_or_throw(raw: str) -> dict:
    cleaned = re.sub(r"^```(?:json)?\s*", "", raw.strip())
    cleaned = re.sub(r"\s*```$", "", cleaned)

    try:
        result = json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise ValueError(f"Failed to parse consolidation response: {e}. Raw: {raw[:200]}")

    if not isinstance(result.get("summary"), str):
        raise ValueError("Missing 'summary' field in consolidation response")
    if not isinstance(result.get("memory_update"), str):
        result["memory_update"] = ""

    return result
