"""Post-conversation reflection — heuristic topic extraction, matching TS evolution/reflection.ts."""

from __future__ import annotations

import re
from collections import Counter

from src.types import ChatMessage
from src.evolution.memory import get_memory_store
from src.utils.logger import create_logger

log = create_logger("evolution:reflection")


async def reflect_on_conversation(
    messages: list[ChatMessage], channel: str, peer_id: str
) -> None:
    try:
        user_messages = [m for m in messages if m.role == "user"]
        tool_count = sum(1 for m in messages if m.role == "tool")

        if not user_messages:
            return

        topics = _extract_topics(user_messages)
        summary = (
            f"Channel: {channel}, Peer: {peer_id} | "
            f"Messages: {len(user_messages)} user, {tool_count} tool calls | "
            f"Topics: {topics}"
        )

        store = get_memory_store()
        await store.append_entry("USER", "Interaction History Summary", summary)
        log.debug("Reflection recorded", {"peer_id": peer_id})
    except Exception as e:
        log.warn("Reflection failed", {"error": str(e)})


def _extract_topics(messages: list[ChatMessage], top_n: int = 5) -> str:
    words: list[str] = []
    for msg in messages:
        # Split into words, keep CJK chars, remove short words
        tokens = re.findall(r"[\w\u4e00-\u9fff]+", msg.content.lower())
        words.extend(t for t in tokens if len(t) > 3)

    if not words:
        return "general"

    counter = Counter(words)
    top = [w for w, _ in counter.most_common(top_n)]
    return ", ".join(top) if top else "general"
