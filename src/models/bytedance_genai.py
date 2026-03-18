"""ByteDance GenAI Responses API provider, matching TS providers/bytedance-genai.ts."""

from __future__ import annotations

import json
import re
import time
from typing import AsyncGenerator

import httpx

from src.types import (
    ChatMessage,
    StreamChunk,
    TokenUsage,
    ToolCall,
    ToolCallFunction,
    ToolDefinition,
)
from src.utils.logger import create_logger

log = create_logger("provider:bytedance-genai")


async def _post_with_redirect(
    client: httpx.AsyncClient,
    url: str,
    body: str,
    headers: dict[str, str],
    max_redirects: int = 3,
) -> httpx.Response:
    current_url = url
    for _ in range(max_redirects + 1):
        resp = await client.post(
            current_url,
            content=body,
            headers=headers,
            follow_redirects=False,
        )
        if resp.status_code in (301, 302, 307, 308):
            location = resp.headers.get("location")
            if not location:
                raise RuntimeError(f"Redirect without Location header from {current_url}")
            current_url = location
            log.debug("Following redirect", {"to": location})
            continue
        return resp
    raise RuntimeError(f"Too many redirects (max {max_redirects})")


class ByteDanceGenAIProvider:
    def __init__(self, model: str, base_url: str, ak: str) -> None:
        self._model = model
        self._base_url = re.sub(r"/v1/?$", "", base_url.rstrip("/"))
        self._ak = ak
        log.info("ByteDance GenAI provider initialized", {"model": model, "baseUrl": self._base_url})

    @property
    def name(self) -> str:
        return "bytedance-genai"

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[ToolDefinition] | None = None,
        system_prompt: str | None = None,
    ) -> AsyncGenerator[StreamChunk, None]:
        input_items: list[dict] = []

        for msg in messages:
            if msg.role == "system":
                continue
            if msg.role == "tool":
                input_items.append({
                    "type": "function_call_output",
                    "call_id": msg.tool_call_id or "",
                    "output": msg.content,
                })
            elif msg.role == "assistant" and msg.tool_calls:
                if msg.content:
                    input_items.append({
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": msg.content}],
                    })
                for tc in msg.tool_calls:
                    input_items.append({
                        "type": "function_call",
                        "call_id": tc.id,
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    })
            elif msg.role == "assistant":
                input_items.append({
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": msg.content}],
                })
            else:
                input_items.append({
                    "role": msg.role,
                    "content": [{"type": "input_text", "text": msg.content}],
                })

        req_body: dict = {
            "model": self._model,
            "input": input_items,
            "stream": False,
        }
        if system_prompt:
            req_body["instructions"] = system_prompt
        if tools:
            req_body["tools"] = [
                {
                    "type": "function",
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                }
                for t in tools
            ]

        url = f"{self._base_url}/responses?ak={self._ak}"
        body_str = json.dumps(req_body)

        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await _post_with_redirect(
                    client, url, body_str, {"Content-Type": "application/json"}
                )

            if resp.status_code != 200:
                err_text = resp.text
                log.error("API request failed", {"status": resp.status_code, "body": err_text})
                yield StreamChunk(type="error", error=f"API error {resp.status_code}: {err_text}")
                return

            data = resp.json()
            if data.get("error"):
                yield StreamChunk(type="error", error=data["error"]["message"])
                return

            for item in data.get("output", []):
                if item.get("type") == "message" and item.get("content"):
                    for part in item["content"]:
                        if part.get("type") == "output_text" and part.get("text"):
                            yield StreamChunk(type="text", content=part["text"])
                elif item.get("type") == "function_call" and item.get("name"):
                    yield StreamChunk(
                        type="tool_call",
                        tool_call=ToolCall(
                            id=item.get("call_id") or item.get("id") or f"tc_{int(time.time()*1000)}",
                            function=ToolCallFunction(
                                name=item["name"],
                                arguments=item.get("arguments", "{}"),
                            ),
                        ),
                    )

            usage = data.get("usage")
            yield StreamChunk(
                type="done",
                usage=TokenUsage(
                    prompt_tokens=usage["input_tokens"],
                    completion_tokens=usage["output_tokens"],
                    total_tokens=usage["total_tokens"],
                ) if usage else None,
            )

        except Exception as e:
            log.error("ByteDance GenAI request failed", {"error": str(e)})
            yield StreamChunk(type="error", error=str(e))
