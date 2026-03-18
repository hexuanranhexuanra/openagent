"""Core types for the agent system, matching TS types/index.ts."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

# ─── Chat / Message Types ───

MessageRole = Literal["system", "user", "assistant", "tool"]


@dataclass
class ToolCallFunction:
    name: str
    arguments: str  # JSON string


@dataclass
class ToolCall:
    id: str
    function: ToolCallFunction
    type: str = "function"


@dataclass
class ChatMessage:
    role: MessageRole
    content: str
    name: str | None = None
    tool_call_id: str | None = None
    tool_calls: list[ToolCall] | None = None
    timestamp: int = 0


@dataclass
class ToolResult:
    tool_call_id: str
    content: str
    is_error: bool = False


# ─── Provider Types ───


@dataclass
class TokenUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


@dataclass
class StreamChunk:
    type: Literal["text", "tool_call", "done", "error"]
    content: str | None = None
    tool_call: ToolCall | None = None
    error: str | None = None
    usage: TokenUsage | None = None


# ─── Tool Types ───


@dataclass
class ToolDefinition:
    name: str
    description: str
    parameters: dict[str, Any]


@dataclass
class ToolHandler:
    definition: ToolDefinition
    execute: Callable[[dict[str, Any]], Awaitable[str]]


# ─── Agent Stream Events ───


@dataclass
class AgentStreamEvent:
    type: Literal["text", "tool_start", "tool_result", "done", "error", "progress"]
    content: str | None = None
    tool_name: str | None = None
    tool_args: dict[str, Any] | None = None
    tool_result: str | None = None
    usage: TokenUsage | None = None
    error: str | None = None
    round: int | None = None
    max_rounds: int | None = None


# ─── Session Types ───


@dataclass
class Session:
    id: str
    channel: str
    peer_id: str
    messages: list[ChatMessage] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: int = 0
    updated_at: int = 0


# ─── Channel Types ───


@dataclass
class IncomingMessage:
    channel_type: str
    channel_id: str
    peer_id: str
    content: str
    media_url: str | None = None
    timestamp: int = 0
    raw: Any = None


@dataclass
class OutgoingMessage:
    channel_type: str
    channel_id: str
    peer_id: str
    content: str
    reply_to_id: str | None = None


# Aliases
InboundMessage = IncomingMessage
OutboundMessage = OutgoingMessage


# ─── Gateway Protocol Types ───


@dataclass
class GatewayEvent:
    type: Literal["event"] = "event"
    event: str = ""
    payload: dict[str, Any] = field(default_factory=dict)
    id: str | None = None
    seq: int | None = None


@dataclass
class GatewayRequest:
    type: Literal["req"] = "req"
    id: str = ""
    method: str = ""
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class GatewayResponse:
    type: Literal["res"] = "res"
    id: str = ""
    ok: bool = True
    payload: dict[str, Any] | None = None
    error: str | None = None
