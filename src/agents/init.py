"""Agent initialization — register tools, select provider, matching TS agent/index.ts."""

from __future__ import annotations

from typing import AsyncGenerator

from src.agents.context import init_context_builder
from src.agents.engine import get_agent_engine, init_agent_engine
from src.models.base import LLMProvider
from src.types import AgentStreamEvent
from src.config import get_config
from src.utils.logger import create_logger

log = create_logger("agent")

_provider_name = "unknown"


async def init_agent() -> None:
    """Bootstrap: register built-in tools, select LLM provider, init engine."""
    global _provider_name

    _register_builtin_tools()

    provider = _build_provider()
    _provider_name = provider.name
    init_context_builder(provider)
    init_agent_engine(provider)

    await _load_skills()

    log.info("Agent initialized", {"provider": provider.name})


def _register_builtin_tools() -> None:
    from src.tools.registry import register_tool
    from src.tools.builtins.datetime_tool import datetime_tool
    from src.tools.builtins.web_search import web_search_tool
    from src.tools.builtins.shell import shell_tool
    from src.tools.builtins.file_ops import read_file_tool, write_file_tool, list_files_tool
    from src.tools.builtins.read_config import read_config_tool
    from src.tools.builtins.write_config import write_config_tool

    register_tool(datetime_tool)
    register_tool(web_search_tool)
    register_tool(shell_tool)
    register_tool(read_file_tool)
    register_tool(write_file_tool)
    register_tool(list_files_tool)
    register_tool(read_config_tool)
    register_tool(write_config_tool)

    from src.tools.builtins.evolution_tools import (
        memory_update_tool, memory_append_tool, memory_read_tool,
        skill_use_tool, skill_create_tool, skill_list_tool, skill_read_tool,
        self_modify_tool, subagent_spawn_tool,
    )
    from src.tools.builtins.memory_tool import memory_tool
    from src.tools.builtins.cron_tool import cron_tool
    from src.tools.builtins.heartbeat_tool import heartbeat_tool

    register_tool(memory_update_tool)
    register_tool(memory_append_tool)
    register_tool(memory_read_tool)
    register_tool(skill_use_tool)
    register_tool(skill_create_tool)
    register_tool(skill_list_tool)
    register_tool(skill_read_tool)
    register_tool(self_modify_tool)
    register_tool(subagent_spawn_tool)
    register_tool(memory_tool)
    register_tool(cron_tool)
    register_tool(heartbeat_tool)


def _build_provider() -> LLMProvider:
    config = get_config()
    provider_name = config.agent.default_provider
    oai = config.providers.openai
    ant = config.providers.anthropic

    if provider_name == "claude-code":
        from src.models.claude_code import ClaudeCodeProvider
        return ClaudeCodeProvider()

    # setupToken auto-activates Anthropic regardless of defaultProvider
    if ant.setup_token:
        from src.models.anthropic_provider import AnthropicProvider
        return AnthropicProvider(ant.api_key, ant.model, ant.setup_token)

    is_bytedance = (
        oai.query_params.get("ak") and (
            "byteintl.net" in (oai.base_url or "")
            or "tiktok-row.org" in (oai.base_url or "")
        )
    )

    if provider_name == "anthropic":
        if not ant.api_key:
            log.warn("Anthropic API key not set, falling back to OpenAI")
            if is_bytedance:
                from src.models.bytedance_genai import ByteDanceGenAIProvider
                return ByteDanceGenAIProvider(oai.model, oai.base_url, oai.query_params["ak"])
            from src.models.openai_provider import OpenAIProvider
            return OpenAIProvider(oai.api_key, oai.model, oai.base_url, oai.query_params)
        from src.models.anthropic_provider import AnthropicProvider
        return AnthropicProvider(ant.api_key, ant.model)

    if is_bytedance:
        from src.models.bytedance_genai import ByteDanceGenAIProvider
        return ByteDanceGenAIProvider(oai.model, oai.base_url, oai.query_params["ak"])

    from src.models.openai_provider import OpenAIProvider
    return OpenAIProvider(oai.api_key, oai.model, oai.base_url, oai.query_params)


async def _load_skills() -> None:
    try:
        from src.evolution.skill_loader import get_skill_loader
        await get_skill_loader().load_all()
    except Exception as e:
        log.warn("Skill loading failed (non-fatal)", {"error": str(e)})


def get_provider_name() -> str:
    return _provider_name


async def run_agent(
    channel: str, peer_id: str, user_message: str
) -> AsyncGenerator[AgentStreamEvent, None]:
    async for event in get_agent_engine().start_task(channel, peer_id, user_message):
        yield event


def cancel_agent(channel: str, peer_id: str) -> bool:
    return get_agent_engine().cancel_task(channel, peer_id)
