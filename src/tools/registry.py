"""Tool registry — global map of tool handlers, matching TS tools/registry.ts."""

from __future__ import annotations

import json

from src.types import ToolDefinition, ToolHandler
from src.utils.logger import create_logger

log = create_logger("tools")

_tools: dict[str, ToolHandler] = {}


def register_tool(handler: ToolHandler) -> None:
    name = handler.definition.name
    if name in _tools:
        log.warn("Tool already registered, overwriting", {"name": name})
    _tools[name] = handler
    log.info("Tool registered", {"name": name})


def get_tool(name: str) -> ToolHandler | None:
    return _tools.get(name)


def get_all_tool_definitions() -> list[ToolDefinition]:
    return [h.definition for h in _tools.values()]


async def execute_tool(name: str, args: dict) -> str:
    handler = _tools.get(name)
    if not handler:
        return json.dumps({"error": f"Tool '{name}' not found"})

    try:
        raw = await handler.execute(args)
        if isinstance(raw, str):
            return raw
        return json.dumps(raw or "")
    except Exception as e:
        log.error("Tool execution failed", {"name": name, "error": str(e)})
        return json.dumps({"error": str(e)})
