"""Claude Code provider — delegates to Claude Code CLI subprocess."""

from __future__ import annotations

import asyncio
import json
from typing import AsyncGenerator

from src.models.base import LLMProvider
from src.types import ChatMessage, StreamChunk, ToolDefinition
from src.utils.logger import create_logger

log = create_logger("provider:claude-code")


class ClaudeCodeProvider(LLMProvider):
    @property
    def name(self) -> str:
        return "claude-code"

    async def stream(
        self,
        messages: list[ChatMessage],
        tools: list[ToolDefinition] | None = None,
        system_prompt: str | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> AsyncGenerator[StreamChunk, None]:
        user_message = ""
        for msg in reversed(messages):
            if msg.role == "user":
                user_message = msg.content or ""
                break

        if not user_message:
            yield StreamChunk(type="text", content="No user message found.")
            return

        try:
            proc = await asyncio.create_subprocess_exec(
                "claude", "-p", user_message, "--output-format", "json",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            stdout, stderr = await proc.communicate()

            if proc.returncode != 0:
                error_msg = stderr.decode("utf-8", errors="replace").strip()
                yield StreamChunk(type="error", error=f"Claude Code error: {error_msg}")
                return

            output = stdout.decode("utf-8", errors="replace").strip()
            try:
                data = json.loads(output)
                text = data.get("result", output)
            except json.JSONDecodeError:
                text = output

            yield StreamChunk(type="text", content=text)

        except FileNotFoundError:
            yield StreamChunk(
                type="error",
                error="Claude Code CLI not found. Install it first: npm install -g @anthropic-ai/claude-code",
            )
        except Exception as e:
            yield StreamChunk(type="error", error=f"Claude Code error: {e}")
