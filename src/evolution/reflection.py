"""Post-conversation reflection — DEPRECATED, replaced by consolidation.py.

This module is kept for backward compatibility. The actual memory consolidation
is now handled by ConsolidationManager in consolidation.py, which uses LLM-driven
extraction instead of heuristic topic counting.
"""

from __future__ import annotations

from src.types import ChatMessage
from src.utils.logger import create_logger

log = create_logger("evolution:reflection")


async def reflect_on_conversation(
    messages: list[ChatMessage], channel: str, peer_id: str
) -> None:
    """No-op. Consolidation is now handled by ConsolidationManager in engine.py post-task hook."""
    log.debug("reflect_on_conversation called but consolidation is now handled by ConsolidationManager")
