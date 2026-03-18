"""MCP stdio server that exposes OpenAgent's registered tools.

Launched as a subprocess by the Claude Code provider. Claude Code connects
to this process via stdio and can call any tool from our registry.

Usage:
    python -m src.tools.mcp_server
"""

from __future__ import annotations

import asyncio
import json
import sys

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

# Bootstrap: register all built-in tools before serving
def _bootstrap_tools() -> None:
    """Register built-in tools (same as init.py but without LLM provider)."""
    from src.tools.registry import register_tool
    from src.tools.builtins.datetime_tool import datetime_tool
    from src.tools.builtins.web_search import web_search_tool
    from src.tools.builtins.shell import shell_tool
    from src.tools.builtins.file_ops import read_file_tool, write_file_tool, list_files_tool
    from src.tools.builtins.read_config import read_config_tool
    from src.tools.builtins.write_config import write_config_tool
    from src.tools.builtins.evolution_tools import (
        memory_read_tool, memory_save_tool, memory_search_tool, memory_get_tool,
        skill_use_tool, skill_create_tool, skill_list_tool, skill_read_tool,
        self_modify_tool,
    )
    from src.tools.builtins.notebook_tool import notebook_tool
    from src.tools.builtins.cron_tool import cron_tool
    from src.tools.builtins.heartbeat_tool import heartbeat_tool

    for tool in [
        datetime_tool, web_search_tool, shell_tool,
        read_file_tool, write_file_tool, list_files_tool,
        read_config_tool, write_config_tool,
        memory_read_tool, memory_save_tool, memory_search_tool, memory_get_tool,
        skill_use_tool, skill_create_tool, skill_list_tool, skill_read_tool,
        self_modify_tool, notebook_tool, cron_tool, heartbeat_tool,
    ]:
        register_tool(tool)


def _create_server() -> Server:
    from src.tools.registry import get_all_tool_definitions, execute_tool

    server = Server("openagent-tools")

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        definitions = get_all_tool_definitions()
        return [
            Tool(
                name=d.name,
                description=d.description,
                inputSchema=d.parameters,
            )
            for d in definitions
        ]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[TextContent]:
        result = await execute_tool(name, arguments or {})
        return [TextContent(type="text", text=result)]

    return server


async def main() -> None:
    _bootstrap_tools()
    server = _create_server()
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
