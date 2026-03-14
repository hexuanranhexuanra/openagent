"""Web search tool — placeholder, matching TS tools/builtin/web-search.ts."""

from __future__ import annotations

import json

from src.types import ToolDefinition, ToolHandler


async def _execute(args: dict) -> str:
    query = args.get("query", "")
    return json.dumps({
        "note": "Web search is not yet implemented. Integration needed with SerpAPI, Tavily, or similar.",
        "query": query,
        "results": [],
    })


web_search_tool = ToolHandler(
    definition=ToolDefinition(
        name="web_search",
        description="Search the web for information. (Not yet implemented — placeholder.)",
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query.",
                },
            },
            "required": ["query"],
        },
    ),
    execute=_execute,
)
