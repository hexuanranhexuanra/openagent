"""Anthropic LLM provider, matching TS providers/anthropic.ts."""

from __future__ import annotations

import json
from typing import AsyncGenerator

import anthropic

from src.types import (
    ChatMessage,
    StreamChunk,
    TokenUsage,
    ToolCall,
    ToolCallFunction,
    ToolDefinition,
)
from src.utils.logger import create_logger

log = create_logger("provider:anthropic")


class AnthropicProvider:
    def __init__(self, api_key: str, model: str, setup_token: str | None = None) -> None:
        if setup_token:
            self._client = anthropic.AsyncAnthropic(
                auth_token=setup_token,
                api_key=None,
                default_headers={"anthropic-beta": "oauth-2025-04-20"},
            )
            log.info("Anthropic provider initialized (setup-token / OAuth)", {"model": model})
        else:
            self._client = anthropic.AsyncAnthropic(api_key=api_key)
            log.info("Anthropic provider initialized", {"model": model})
        self._model = model

    @property
    def name(self) -> str:
        return "anthropic"

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[ToolDefinition] | None = None,
        system_prompt: str | None = None,
    ) -> AsyncGenerator[StreamChunk, None]:
        ant_messages: list[dict] = []

        for msg in messages:
            if msg.role == "system":
                continue

            if msg.role == "tool":
                content_str = msg.content if isinstance(msg.content, str) else json.dumps(msg.content or "")
                ant_messages.append({
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": msg.tool_call_id or "",
                            "content": content_str,
                        }
                    ],
                })
            elif msg.role == "assistant" and msg.tool_calls:
                content: list[dict] = []
                if msg.content:
                    content.append({"type": "text", "text": msg.content})
                for tc in msg.tool_calls:
                    content.append({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.function.name,
                        "input": json.loads(tc.function.arguments),
                    })
                ant_messages.append({"role": "assistant", "content": content})
            else:
                ant_messages.append({
                    "role": msg.role,
                    "content": msg.content,
                })

        ant_tools = None
        if tools:
            ant_tools = [
                {
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters,
                }
                for t in tools
            ]

        try:
            kwargs: dict = {
                "model": self._model,
                "max_tokens": 4096,
                "messages": ant_messages,
            }
            if system_prompt:
                kwargs["system"] = system_prompt
            if ant_tools:
                kwargs["tools"] = ant_tools

            async with self._client.messages.stream(**kwargs) as stream:
                async for event in stream:
                    if event.type == "content_block_delta":
                        if event.delta.type == "text_delta":
                            yield StreamChunk(type="text", content=event.delta.text)
                    elif event.type == "content_block_stop":
                        snapshot = stream.current_message_snapshot
                        if snapshot and event.index < len(snapshot.content):
                            block = snapshot.content[event.index]
                            if block.type == "tool_use":
                                yield StreamChunk(
                                    type="tool_call",
                                    tool_call=ToolCall(
                                        id=block.id,
                                        function=ToolCallFunction(
                                            name=block.name,
                                            arguments=json.dumps(block.input),
                                        ),
                                    ),
                                )
                    elif event.type == "message_stop":
                        final = await stream.get_final_message()
                        yield StreamChunk(
                            type="done",
                            usage=TokenUsage(
                                prompt_tokens=final.usage.input_tokens,
                                completion_tokens=final.usage.output_tokens,
                                total_tokens=final.usage.input_tokens + final.usage.output_tokens,
                            ),
                        )
        except Exception as e:
            log.error("Anthropic request failed", {"error": str(e)})
            yield StreamChunk(type="error", error=str(e))
