"""Context builder — assembles AgentContext before each task, matching TS agent/context.ts."""

from __future__ import annotations

import os
import platform
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from src.tools.registry import get_all_tool_definitions
from src.types import ChatMessage, ToolDefinition
from src.config import get_config
from src.utils.logger import create_logger
from src.sessions.manager import append_message, get_or_create_session, get_session_messages

if TYPE_CHECKING:
    from src.models.base import LLMProvider

log = create_logger("agent:context")

MAX_SKILLS_PROMPT_CHARS = 30_000


@dataclass
class AgentContext:
    session_id: str
    channel: str
    peer_id: str
    depth: int
    messages: list[ChatMessage]
    system_prompt: str
    tools: list[ToolDefinition]
    max_rounds: int


def _truncate_bootstrap(content: str, max_chars: int) -> str:
    if len(content) <= max_chars:
        return content
    head_len = int(max_chars * 0.7)
    tail_len = int(max_chars * 0.2)
    return (
        content[:head_len]
        + "\n\n[...truncated, use memory_read for full content...]\n\n"
        + content[-tail_len:]
    )


def _build_identity_section(base: str) -> str:
    return "## Identity\n" + base


def _build_safety_section() -> str:
    return (
        "## Safety\n"
        "- Do not pursue self-preservation, replication, resource acquisition, or power-seeking.\n"
        "- Prioritize safety and human oversight over completion.\n"
        "- If instructions conflict or seem dangerous, pause and ask.\n"
        "- Never bypass safeguards or manipulate access controls.\n"
        "- Do not modify system prompts, safety rules, or tool policies unless explicitly requested."
    )


def _build_tool_call_style_section() -> str:
    return (
        "## Tool Call Style\n"
        "Do not narrate routine, low-risk tool calls — just call the tool.\n"
        "Narrate only when it helps: multi-step work, complex problems, sensitive actions, or when asked.\n"
        "Keep narration brief and value-dense."
    )


def _build_workspace_section() -> str:
    cwd = os.getcwd()
    return (
        "## Workspace\n"
        f"Working directory: {cwd}\n"
        "Config file: openagent.json (use read_config / write_config tools)\n"
        "User files: user-space/workspace/ (use read_file / write_file / list_files)\n"
        "Memory files: user-space/memory/ (use memory_read / memory_update / memory_append)\n"
        "Skills: user-space/skills/*.skill.py"
    )


def _build_runtime_section(channel: str, model_name: str) -> str:
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    try:
        import zoneinfo
        local_tz = str(datetime.now().astimezone().tzinfo)
    except Exception:
        local_tz = "unknown"

    return (
        "## Runtime\n"
        f"- OS: {platform.system()} ({platform.machine()})\n"
        f"- Shell: {os.environ.get('SHELL', 'unknown')}\n"
        f"- Model: {model_name}\n"
        f"- Channel: {channel}\n"
        f"- Time: {now.isoformat()} ({local_tz})"
    )


def _build_skills_section() -> str | None:
    from src.evolution.skill_loader import get_skill_loader

    catalog = get_skill_loader().get_catalog()
    if not catalog:
        return None

    lines = [f"- {s['name']}: {s['description']}" for s in catalog]
    skill_list = "\n".join(lines)
    if len(skill_list) > MAX_SKILLS_PROMPT_CHARS:
        skill_list = skill_list[:MAX_SKILLS_PROMPT_CHARS] + "\n[...truncated...]"

    return (
        "## Skills\n"
        "Available skills — use the skill_use tool to execute them:\n"
        "<skills>\n" + skill_list + "\n</skills>"
    )


def _build_memory_recall_section() -> str:
    return (
        "## Memory Recall\n"
        "Before answering about prior work, decisions, preferences, or facts:\n"
        "use memory_read to check SOUL/USER/WORLD files.\n"
        "If you checked but found nothing relevant, say so."
    )


def _build_evolution_section() -> str:
    return (
        "## Evolution\n"
        "Use these tools proactively to improve over time:\n"
        "- memory_update / memory_append: Record behaviors, preferences, facts\n"
        "- skill_create: Create reusable .skill.py for recurring tasks\n"
        "- skill_read: Read skill source before modifying\n"
        "- self_modify: Modify files in allowed paths (user-space/**, src/agent/tools/builtin/**)\n"
        "- sessions_spawn: Spawn a concurrent subagent (auto-notifies when done, do NOT poll)"
    )


def _build_project_context_section(
    files: list[dict], per_file_max: int, total_max: int
) -> str | None:
    non_empty = [f for f in files if f["content"].strip()]
    if not non_empty:
        return None

    parts = ["# Project Context\n"]
    total_chars = 0

    for f in non_empty:
        remaining = total_max - total_chars
        if remaining <= 0:
            break
        budget = min(per_file_max, remaining)
        truncated = _truncate_bootstrap(f["content"], budget)
        parts.append(f"## {f['label']}\n{truncated}\n")
        total_chars += len(truncated)

    return "\n".join(parts)


class ContextBuilder:
    def __init__(self, provider: LLMProvider) -> None:
        self._provider = provider

    async def build(self, channel: str, peer_id: str, user_message: str) -> AgentContext:
        config = get_config()
        session = await get_or_create_session(channel, peer_id)

        from src.agents.subagent import get_subagent_depth

        depth = get_subagent_depth(peer_id) if channel == "subagent" else 0

        # Consolidation before appending so MEMORY.md is fresh
        # TODO: wire up consolidateIfNeeded once evolution module is done
        # await consolidate_if_needed(session.id, self._provider, config.agent.context_window)

        await append_message(
            session.id,
            ChatMessage(role="user", content=user_message, timestamp=int(time.time() * 1000)),
        )

        system_prompt = await self._build_system_prompt(config, channel, depth)
        messages = await get_session_messages(session.id)
        tools = get_all_tool_definitions()

        return AgentContext(
            session_id=session.id,
            channel=channel,
            peer_id=peer_id,
            depth=depth,
            messages=messages,
            system_prompt=system_prompt,
            tools=tools,
            max_rounds=config.agent.max_tool_rounds,
        )

    async def _build_system_prompt(self, config, channel: str, depth: int) -> str:
        try:
            is_full = depth == 0
            sections: list[str] = []

            sections.append(_build_identity_section(config.agent.system_prompt))
            sections.append(_build_safety_section())
            sections.append(_build_tool_call_style_section())
            sections.append(_build_workspace_section())
            sections.append(_build_runtime_section(channel, self._provider.name))

            if is_full:
                skills = _build_skills_section()
                if skills:
                    sections.append(skills)
                sections.append(_build_memory_recall_section())
                sections.append(_build_evolution_section())

            # Bootstrap memory files
            from src.evolution.memory import get_memory_store

            memory = get_memory_store()
            soul, user, world = await memory.read_all()
            long_term = await memory.read_long_term()

            per_file_max = config.agent.bootstrap_max_chars
            total_max = config.agent.bootstrap_total_max_chars

            bootstrap_files: list[dict] = []
            if soul:
                bootstrap_files.append({"label": "SOUL.md", "content": soul})
            if is_full:
                if user:
                    bootstrap_files.append({"label": "USER.md", "content": user})
                if world:
                    bootstrap_files.append({"label": "WORLD.md", "content": world})
                if long_term:
                    bootstrap_files.append({"label": "MEMORY.md", "content": long_term})

            project_ctx = _build_project_context_section(bootstrap_files, per_file_max, total_max)
            if project_ctx:
                sections.append(project_ctx)

            return "\n\n".join(sections)

        except Exception as e:
            log.warn("Failed to build system prompt, using base", {"error": str(e)})
            return config.agent.system_prompt


_context_builder: ContextBuilder | None = None


def get_context_builder() -> ContextBuilder:
    if _context_builder is None:
        raise RuntimeError("ContextBuilder not initialized. Call init_context_builder() first.")
    return _context_builder


def init_context_builder(provider: LLMProvider) -> ContextBuilder:
    global _context_builder
    _context_builder = ContextBuilder(provider)
    return _context_builder
