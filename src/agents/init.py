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
    use_claude_code = _provider_name == "claude-code"
    init_context_builder(provider)
    init_agent_engine(provider, use_claude_code=use_claude_code)

    # Initialize consolidation manager
    config = get_config()
    if config.memory.enabled:
        from src.evolution.consolidation import init_consolidation_manager

        init_consolidation_manager(provider, config.memory.consolidation_window)
        log.info("Consolidation manager initialized", {
            "window": config.memory.consolidation_window,
        })

        # Initialize search index
        if config.memory.search_backend in ("fts", "hybrid"):
            embedding_provider = None
            if config.memory.search_backend == "hybrid":
                embedding_provider = _build_embedding_provider(config)
            from src.evolution.search import init_hybrid_index

            await init_hybrid_index(
                db_path="data/memory_index.db",
                embedding_provider=embedding_provider,
            )
            log.info("Memory search index initialized", {
                "backend": config.memory.search_backend,
                "has_embeddings": embedding_provider is not None,
            })

        # Run legacy migration (USER.md + WORLD.md → MEMORY.md)
        from src.evolution.memory import get_memory_store

        await get_memory_store().migrate_if_needed()

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
        memory_read_tool, memory_save_tool, memory_search_tool, memory_get_tool,
        skill_use_tool, skill_create_tool, skill_list_tool, skill_read_tool,
        self_modify_tool, subagent_spawn_tool,
    )
    from src.tools.builtins.notebook_tool import notebook_tool
    from src.tools.builtins.cron_tool import cron_tool
    from src.tools.builtins.heartbeat_tool import heartbeat_tool

    register_tool(memory_read_tool)
    register_tool(memory_save_tool)
    register_tool(memory_search_tool)
    register_tool(memory_get_tool)
    register_tool(skill_use_tool)
    register_tool(skill_create_tool)
    register_tool(skill_list_tool)
    register_tool(skill_read_tool)
    register_tool(self_modify_tool)
    register_tool(subagent_spawn_tool)
    register_tool(notebook_tool)
    register_tool(cron_tool)
    register_tool(heartbeat_tool)


def _build_provider() -> LLMProvider:
    config = get_config()
    provider_name = config.agent.default_provider
    oai = config.providers.openai
    ant = config.providers.anthropic

    if provider_name == "claude-code":
        from src.models.claude_code import ClaudeCodeProvider
        # Don't pass anthropic model — let Claude Code use its own default
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


def _build_embedding_provider(config):
    """Build embedding provider based on config."""
    emb_config = config.memory.embedding
    if emb_config.provider == "none":
        return None

    if emb_config.provider == "openai":
        from src.evolution.embeddings import OpenAIEmbeddingProvider

        # Fall back to the main OpenAI provider config if embedding-specific keys not set
        api_key = emb_config.api_key or config.providers.openai.api_key
        base_url = emb_config.base_url or config.providers.openai.base_url or None
        return OpenAIEmbeddingProvider(
            api_key=api_key,
            model=emb_config.model,
            base_url=base_url,
            query_params=config.providers.openai.query_params or None,
        )

    log.warn("Unknown embedding provider", {"provider": emb_config.provider})
    return None


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
