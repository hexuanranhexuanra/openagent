"""StreamAgent — stateless ReAct execution engine, matching TS agent/stream-agent.ts."""

from __future__ import annotations

import asyncio
import json
import time
from typing import TYPE_CHECKING, AsyncGenerator

from src.agents.loop_detector import LoopDetector
from src.tools.registry import execute_tool
from src.types import AgentStreamEvent, ChatMessage
from src.utils.logger import create_logger
from src.sessions.manager import append_message, get_session_messages, get_unconsolidated_messages

if TYPE_CHECKING:
    from src.agents.context import AgentContext
    from src.models.base import LLMProvider

log = create_logger("agent:stream")

MAX_TOOL_RESULT_CHARS = 24_000


class StreamAgent:
    def __init__(self, provider: LLMProvider) -> None:
        self._provider = provider

    async def run(
        self, ctx: AgentContext, cancel_event: asyncio.Event
    ) -> AsyncGenerator[AgentStreamEvent, None]:
        loop_detector = LoopDetector()
        round_num = 0

        while round_num < ctx.max_rounds:
            if cancel_event.is_set():
                return

            round_num += 1
            yield AgentStreamEvent(type="progress", round=round_num, max_rounds=ctx.max_rounds)

            messages = await get_unconsolidated_messages(ctx.session_id)
            stream = self._provider.chat(messages, ctx.tools, ctx.system_prompt)

            round_text = ""
            pending_tool_calls = []

            async for chunk in stream:
                if cancel_event.is_set():
                    return

                if chunk.type == "text":
                    round_text += chunk.content or ""
                    yield AgentStreamEvent(type="text", content=chunk.content)
                elif chunk.type == "tool_call":
                    if chunk.tool_call:
                        pending_tool_calls.append(chunk.tool_call)
                elif chunk.type == "done":
                    if chunk.usage:
                        log.debug("Round usage", {
                            "round": round_num,
                            "sessionId": ctx.session_id,
                            "prompt": chunk.usage.prompt_tokens,
                            "completion": chunk.usage.completion_tokens,
                        })
                elif chunk.type == "error":
                    yield AgentStreamEvent(type="error", error=chunk.error)
                    return

            if round_text or pending_tool_calls:
                await append_message(
                    ctx.session_id,
                    ChatMessage(
                        role="assistant",
                        content=round_text,
                        tool_calls=pending_tool_calls if pending_tool_calls else None,
                        timestamp=int(time.time() * 1000),
                    ),
                )

            if not pending_tool_calls:
                break

            # Expose current session identity to tools (e.g. sessions_spawn)
            from src.agents.subagent import set_current_run_context

            set_current_run_context(channel=ctx.channel, peer_id=ctx.peer_id, depth=ctx.depth)

            for i, tc in enumerate(pending_tool_calls):
                if cancel_event.is_set():
                    return

                tool_name = tc.function.name
                try:
                    tool_args = json.loads(tc.function.arguments)
                except (json.JSONDecodeError, TypeError):
                    log.warn("Failed to parse tool arguments", {
                        "toolName": tool_name,
                        "rawArgs": tc.function.arguments[:300],
                    })
                    await append_message(
                        ctx.session_id,
                        ChatMessage(
                            role="tool",
                            content=f"[Error: Could not parse tool arguments as JSON. Raw: {tc.function.arguments[:300]}]",
                            tool_call_id=tc.id,
                            timestamp=int(time.time() * 1000),
                        ),
                    )
                    continue

                # Loop detection BEFORE execution
                loop_check = loop_detector.check(tool_name, tool_args)
                if loop_check.stuck and loop_check.level == "critical":
                    log.warn("Loop detector: critical — aborting run", {
                        "sessionId": ctx.session_id,
                        "message": loop_check.message,
                    })
                    await append_message(
                        ctx.session_id,
                        ChatMessage(
                            role="tool",
                            content=f"[LOOP DETECTED] {loop_check.message}",
                            tool_call_id=tc.id,
                            timestamp=int(time.time() * 1000),
                        ),
                    )
                    for remaining in pending_tool_calls[i + 1 :]:
                        await append_message(
                            ctx.session_id,
                            ChatMessage(
                                role="tool",
                                content="[Skipped — loop detection aborted the run]",
                                tool_call_id=remaining.id,
                                timestamp=int(time.time() * 1000),
                            ),
                        )
                    yield AgentStreamEvent(type="error", error=loop_check.message)
                    return

                yield AgentStreamEvent(type="tool_start", tool_name=tool_name, tool_args=tool_args)

                result = await execute_tool(tool_name, tool_args)

                if len(result) > MAX_TOOL_RESULT_CHARS:
                    log.warn("Tool result truncated", {"toolName": tool_name, "originalLength": len(result)})
                    result = (
                        result[:MAX_TOOL_RESULT_CHARS]
                        + f"\n\n[Result truncated: original was {len(result)} chars, "
                        f"kept first {MAX_TOOL_RESULT_CHARS}]"
                    )

                if loop_check.stuck and loop_check.level == "warning":
                    log.warn("Loop detector: warning", {
                        "sessionId": ctx.session_id,
                        "toolName": tool_name,
                        "message": loop_check.message,
                    })
                    result += f"\n\n[LOOP WARNING] {loop_check.message}"

                yield AgentStreamEvent(type="tool_result", tool_name=tool_name, tool_result=result)

                await append_message(
                    ctx.session_id,
                    ChatMessage(
                        role="tool",
                        content=result,
                        tool_call_id=tc.id,
                        timestamp=int(time.time() * 1000),
                    ),
                )

        if round_num >= ctx.max_rounds:
            log.warn("Max tool rounds reached", {"sessionId": ctx.session_id, "rounds": round_num})
            yield AgentStreamEvent(
                type="error",
                error=(
                    f"Reached the limit of {ctx.max_rounds} tool rounds without completing the task. "
                    "Send a follow-up message to continue, or ask the agent to summarise progress so far."
                ),
            )
