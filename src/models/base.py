"""LLM Provider protocol — all providers implement this interface."""

from __future__ import annotations

from typing import AsyncGenerator, Protocol

from src.types import ChatMessage, StreamChunk, ToolDefinition


class LLMProvider(Protocol):
    @property
    def name(self) -> str: ...

    def chat(
        self,
        messages: list[ChatMessage],
        tools: list[ToolDefinition] | None = None,
        system_prompt: str | None = None,
    ) -> AsyncGenerator[StreamChunk, None]: ...
