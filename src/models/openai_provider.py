"""OpenAI-compatible LLM provider, matching TS providers/openai.ts."""

from __future__ import annotations

from typing import AsyncGenerator

import openai

from src.types import (
    ChatMessage,
    StreamChunk,
    TokenUsage,
    ToolCall,
    ToolCallFunction,
    ToolDefinition,
)
from src.utils.logger import create_logger

log = create_logger("provider:openai")


class OpenAIProvider:
    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str | None = None,
        query_params: dict[str, str] | None = None,
    ) -> None:
        kwargs: dict = {
            "api_key": api_key or "unused",
        }
        if base_url:
            kwargs["base_url"] = base_url
        if query_params:
            kwargs["default_query"] = query_params
        self._client = openai.AsyncOpenAI(**kwargs)
        self._model = model
        log.info("OpenAI provider initialized", {"model": model, "baseUrl": base_url or "default"})

    @property
    def name(self) -> str:
        return "openai"

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[ToolDefinition] | None = None,
        system_prompt: str | None = None,
    ) -> AsyncGenerator[StreamChunk, None]:
        oai_messages: list[dict] = []

        if system_prompt:
            oai_messages.append({"role": "system", "content": system_prompt})

        for msg in messages:
            if msg.role == "tool":
                oai_messages.append({
                    "role": "tool",
                    "content": msg.content,
                    "tool_call_id": msg.tool_call_id or "",
                })
            elif msg.role == "assistant" and msg.tool_calls:
                oai_messages.append({
                    "role": "assistant",
                    "content": msg.content or None,
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.function.name,
                                "arguments": tc.function.arguments,
                            },
                        }
                        for tc in msg.tool_calls
                    ],
                })
            else:
                oai_messages.append({"role": msg.role, "content": msg.content})

        oai_tools = None
        if tools:
            oai_tools = [
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    },
                }
                for t in tools
            ]

        try:
            stream = await self._client.chat.completions.create(
                model=self._model,
                messages=oai_messages,
                tools=oai_tools,
                stream=True,
                stream_options={"include_usage": True},
            )

            current_tc: dict | None = None  # {id, name, args}

            async for chunk in stream:
                if not chunk.choices:
                    # Usage-only chunk (after finish)
                    if chunk.usage:
                        yield StreamChunk(
                            type="done",
                            usage=TokenUsage(
                                prompt_tokens=chunk.usage.prompt_tokens,
                                completion_tokens=chunk.usage.completion_tokens,
                                total_tokens=chunk.usage.total_tokens,
                            ),
                        )
                    continue

                delta = chunk.choices[0].delta
                if not delta:
                    continue

                if delta.content:
                    yield StreamChunk(type="text", content=delta.content)

                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        if tc.id:
                            # New tool call boundary — flush previous
                            if current_tc:
                                yield StreamChunk(
                                    type="tool_call",
                                    tool_call=ToolCall(
                                        id=current_tc["id"],
                                        function=ToolCallFunction(
                                            name=current_tc["name"],
                                            arguments=current_tc["args"],
                                        ),
                                    ),
                                )
                            current_tc = {"id": tc.id, "name": tc.function.name if tc.function else "", "args": ""}
                        if tc.function and current_tc:
                            if tc.function.name:
                                current_tc["name"] = tc.function.name
                            if tc.function.arguments:
                                current_tc["args"] += tc.function.arguments

                finish_reason = chunk.choices[0].finish_reason
                if finish_reason:
                    if current_tc:
                        yield StreamChunk(
                            type="tool_call",
                            tool_call=ToolCall(
                                id=current_tc["id"],
                                function=ToolCallFunction(
                                    name=current_tc["name"],
                                    arguments=current_tc["args"],
                                ),
                            ),
                        )
                        current_tc = None

                    if not chunk.usage:
                        yield StreamChunk(type="done")

        except Exception as e:
            log.error("OpenAI request failed", {"error": str(e)})
            yield StreamChunk(type="error", error=str(e))
