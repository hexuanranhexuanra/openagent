"""Evolution tools — memory (read/save/search), skills, self-modify, subagent.

Memory tools redesigned: 3 tools (memory_read, memory_save, memory_search)
replace the previous 3 (memory_read, memory_update, memory_append).
"""

from __future__ import annotations

import json

from src.types import ToolDefinition, ToolHandler
from src.utils.logger import create_logger

log = create_logger("tools:evolution")

# ── memory_read ──


async def _memory_read(args: dict) -> str:
    from src.evolution.memory import get_memory_store

    file = args.get("file", "MEMORY")
    store = get_memory_store()
    content = await store.read(file)
    return content if content else "(empty)"


memory_read_tool = ToolHandler(
    definition=ToolDefinition(
        name="memory_read",
        description=(
            "Read a memory file. Available: MEMORY (long-term facts, always in context), "
            "HISTORY (event log), SOUL (identity), or a path like 'memory/2026-03-14.md' (daily log)."
        ),
        parameters={
            "type": "object",
            "properties": {
                "file": {
                    "type": "string",
                    "description": (
                        "File to read: 'MEMORY', 'HISTORY', 'SOUL', "
                        "or a relative path like 'memory/2026-03-14.md'"
                    ),
                },
            },
            "required": ["file"],
        },
    ),
    execute=_memory_read,
)

# ── memory_save ──


async def _memory_save(args: dict) -> str:
    from src.evolution.memory import get_memory_store

    content = args.get("content", "")
    if not content.strip():
        return json.dumps({"error": "Content cannot be empty"})

    store = get_memory_store()
    await store.write_long_term(content)
    return json.dumps({"saved": "MEMORY.md", "size": len(content)})


memory_save_tool = ToolHandler(
    definition=ToolDefinition(
        name="memory_save",
        description=(
            "Update MEMORY.md with new information. Provide the complete updated content "
            "(full replace, not append). Read current content first with memory_read, "
            "merge new info, then write back. Use this to record user preferences, "
            "project facts, decisions, and other information worth remembering."
        ),
        parameters={
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "Complete MEMORY.md content (full replace)",
                },
            },
            "required": ["content"],
        },
    ),
    execute=_memory_save,
)

# ── memory_search ──


async def _memory_search(args: dict) -> str:
    from src.config import get_config
    from src.evolution.memory import get_memory_store

    query = args.get("query", "")
    max_results = args.get("max_results", 10)
    if not query.strip():
        return json.dumps({"error": "Query cannot be empty"})

    config = get_config()
    store = get_memory_store()
    backend = config.memory.search_backend

    # Hybrid search (vector + FTS)
    if backend == "hybrid":
        from src.evolution.search import SearchConfig, get_hybrid_index

        index = get_hybrid_index()
        if index:
            search_cfg = SearchConfig(
                max_results=max_results,
                min_score=config.memory.search.min_score,
                vector_weight=config.memory.search.vector_weight,
                text_weight=config.memory.search.text_weight,
                mmr_enabled=config.memory.search.mmr_enabled,
                mmr_lambda=config.memory.search.mmr_lambda,
                temporal_decay_enabled=config.memory.search.temporal_decay_enabled,
                temporal_decay_half_life_days=config.memory.search.temporal_decay_half_life_days,
            )
            results = await index.search(query, search_cfg)
            return json.dumps({
                "results": [r.to_dict() for r in results],
                "backend": "hybrid",
                "count": len(results),
            })

    # FTS-only search
    if backend == "fts":
        from src.evolution.search import get_hybrid_index

        index = get_hybrid_index()
        if index:
            from src.evolution.search import SearchConfig

            search_cfg = SearchConfig(max_results=max_results, min_score=0.0)
            results = await index._search_fts(query, max_results)
            return json.dumps({
                "results": [r.to_dict() for r in results],
                "backend": "fts",
                "count": len(results),
            })

    # Default: grep search
    results = await store.search_grep(query, max_results)
    return json.dumps({"results": results, "backend": "grep", "count": len(results)})


# ── memory_get ──


async def _memory_get(args: dict) -> str:
    path = args.get("path", "")
    start_line = args.get("start_line", 1)
    end_line = args.get("end_line", 0)
    if not path:
        return json.dumps({"error": "Path is required"})

    from pathlib import Path as P

    p = P(path)
    if not p.exists():
        return json.dumps({"error": f"File not found: {path}"})

    lines = p.read_text(encoding="utf-8").splitlines()
    if end_line <= 0:
        end_line = len(lines)
    selected = lines[max(0, start_line - 1): end_line]
    numbered = "\n".join(f"{i:4d} | {line}" for i, line in enumerate(selected, start_line))
    return numbered


memory_get_tool = ToolHandler(
    definition=ToolDefinition(
        name="memory_get",
        description=(
            "Read a specific line range from a memory file. Use after memory_search "
            "to get full context around a search result."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Full file path (from search result)",
                },
                "start_line": {
                    "type": "integer",
                    "description": "First line to read (1-based, default 1)",
                },
                "end_line": {
                    "type": "integer",
                    "description": "Last line to read (inclusive, default: end of file)",
                },
            },
            "required": ["path"],
        },
    ),
    execute=_memory_get,
)


memory_search_tool = ToolHandler(
    definition=ToolDefinition(
        name="memory_search",
        description=(
            "Search through HISTORY.md and daily memory logs (memory/*.md) for past events, "
            "decisions, or context. Use when MEMORY.md (already in your context) doesn't "
            "have what you need."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query (keywords or natural language)",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Max results to return (default 10)",
                },
            },
            "required": ["query"],
        },
    ),
    execute=_memory_search,
)

# ── skill_use ──


async def _skill_use(args: dict) -> str:
    from src.evolution.skill_loader import get_skill_loader

    name = args.get("name", "")
    skill_args = args.get("args", {})
    try:
        result = await get_skill_loader().execute_skill(name, skill_args)
        return result if isinstance(result, str) else json.dumps(result)
    except Exception as e:
        return json.dumps({"error": str(e)})


skill_use_tool = ToolHandler(
    definition=ToolDefinition(
        name="skill_use",
        description="Execute a named skill. Skills are listed in the system prompt <skills> block.",
        parameters={
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Skill name (without 'skill_' prefix)",
                },
                "args": {
                    "type": "object",
                    "description": "Arguments to pass to the skill",
                },
            },
            "required": ["name"],
        },
    ),
    execute=_skill_use,
)

# ── skill_create ──


async def _skill_create(args: dict) -> str:
    from src.evolution.skill_loader import get_skill_loader

    filename = args.get("filename", "")
    source = args.get("source", "")
    overwrite = args.get("overwrite", False)
    loader = get_skill_loader()
    try:
        path = await loader.create_skill(filename, source, overwrite)
        handler = await loader.hot_reload(
            filename if filename.endswith(".skill.py") else filename + ".skill.py"
        )
        if handler:
            return json.dumps({"created": path, "skill": handler.definition.name})
        return json.dumps({
            "created": path,
            "warning": "File written but skill could not be loaded. Check module structure.",
        })
    except FileExistsError as e:
        return json.dumps({"error": str(e)})
    except Exception as e:
        return json.dumps({
            "error": str(e),
            "hint": "Ensure the file exports a 'skill' dict and 'execute' async function.",
        })


skill_create_tool = ToolHandler(
    definition=ToolDefinition(
        name="skill_create",
        description="Create or update a dynamic skill file (.skill.py). Hot-reloads on success.",
        parameters={
            "type": "object",
            "properties": {
                "filename": {
                    "type": "string",
                    "description": "Filename (e.g. 'my-tool.skill.py')",
                },
                "source": {
                    "type": "string",
                    "description": "Full Python source code",
                },
                "overwrite": {
                    "type": "boolean",
                    "description": "Overwrite existing file (default false)",
                },
            },
            "required": ["filename", "source"],
        },
    ),
    execute=_skill_create,
)

# ── skill_list ──


async def _skill_list(args: dict) -> str:
    from src.evolution.skill_loader import get_skill_loader

    catalog = get_skill_loader().get_catalog()
    return json.dumps({"skills": catalog, "count": len(catalog)})


skill_list_tool = ToolHandler(
    definition=ToolDefinition(
        name="skill_list",
        description="List all available skills with their names and descriptions.",
        parameters={"type": "object", "properties": {}},
    ),
    execute=_skill_list,
)

# ── skill_read ──


async def _skill_read(args: dict) -> str:
    from pathlib import Path

    from src.evolution.skill_loader import get_skill_loader

    filename = args.get("filename", "")
    loader = get_skill_loader()
    skill_path = Path(loader._dir) / filename
    if not skill_path.exists():
        return json.dumps({"error": f"Skill file not found: {filename}"})
    content = skill_path.read_text(encoding="utf-8")
    lines = content.splitlines()
    numbered = "\n".join(f"{i + 1:4d} | {line}" for i, line in enumerate(lines))
    return numbered


skill_read_tool = ToolHandler(
    definition=ToolDefinition(
        name="skill_read",
        description="Read the source code of a skill file for inspection or debugging.",
        parameters={
            "type": "object",
            "properties": {
                "filename": {
                    "type": "string",
                    "description": "Skill filename (e.g. 'my-tool.skill.py')",
                },
            },
            "required": ["filename"],
        },
    ),
    execute=_skill_read,
)

# ── self_modify ──


async def _self_modify(args: dict) -> str:
    from src.evolution.self_modify import get_self_modifier

    path = args.get("path", "")
    content = args.get("content", "")
    rationale = args.get("rationale", "")
    modifier = get_self_modifier()
    result = await modifier.modify(path, content, rationale)
    if result.success:
        return json.dumps({"modified": path, "backupPath": result.backup_path})
    return json.dumps({"error": result.reason})


self_modify_tool = ToolHandler(
    definition=ToolDefinition(
        name="self_modify",
        description="Modify a file within allowed paths (user-space/**, src/agent/tools/builtin/**).",
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path from project root",
                },
                "content": {
                    "type": "string",
                    "description": "Full new file content",
                },
                "rationale": {
                    "type": "string",
                    "description": "Why this modification is needed",
                },
            },
            "required": ["path", "content", "rationale"],
        },
    ),
    execute=_self_modify,
)

# ── sessions_spawn (subagent) ──


async def _subagent_spawn(args: dict) -> str:
    from src.agents.subagent import get_current_run_context, set_subagent_depth

    ctx = get_current_run_context()
    if not ctx:
        return json.dumps({
            "error": "No run context available. Cannot spawn subagent outside of an agent run."
        })

    task = args.get("task", "")
    label = args.get("label", task[:50])
    timeout_s = args.get("timeout_seconds", 300)

    depth = ctx.get("depth", 0) + 1
    if depth > 3:
        return json.dumps({"error": f"Max subagent depth (3) exceeded. Current depth: {depth}"})

    import asyncio
    from secrets import token_hex

    run_id = token_hex(6)
    set_subagent_depth(run_id, depth)

    async def _run():
        try:
            from src.agents.engine import get_agent_engine

            engine = get_agent_engine()
            text_parts: list[str] = []
            async for event in engine.start_task("subagent", run_id, task):
                if event.type == "text" and event.content:
                    text_parts.append(event.content)
            result = "".join(text_parts) or "(no output)"

            announcement = f"[Subagent '{label}' (id: {run_id}) completed]\n\n{result}"
            async for event in engine.start_task(ctx["channel"], ctx["peer_id"], announcement):
                pass
        except Exception as e:
            log.warn("Subagent execution failed", {"runId": run_id, "error": str(e)})

    asyncio.get_event_loop().create_task(_run())

    return json.dumps({
        "status": "accepted",
        "runId": run_id,
        "note": f"Subagent '{label}' spawned. Results will be delivered automatically — do NOT poll.",
    })


subagent_spawn_tool = ToolHandler(
    definition=ToolDefinition(
        name="sessions_spawn",
        description="Spawn an independent subagent for concurrent task execution. Results auto-delivered.",
        parameters={
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "Full task description for the subagent",
                },
                "label": {
                    "type": "string",
                    "description": "Short label (defaults to first 50 chars of task)",
                },
                "timeout_seconds": {
                    "type": "number",
                    "description": "Timeout in seconds (default 300)",
                },
            },
            "required": ["task"],
        },
    ),
    execute=_subagent_spawn,
)
