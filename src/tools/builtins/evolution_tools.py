"""Evolution tools — memory, skills, self-modify, subagent. Matching TS evolution-tools.ts."""

from __future__ import annotations

import json

from src.types import ToolDefinition, ToolHandler
from src.utils.logger import create_logger

log = create_logger("tools:evolution")

# ── memory_update ──

async def _memory_update(args: dict) -> str:
    from src.evolution.memory import get_memory_store
    file = args.get("file", "").upper()
    section = args.get("section", "")
    content = args.get("content", "")
    if file not in ("SOUL", "USER", "WORLD"):
        return json.dumps({"error": f"Invalid file: {file}. Must be SOUL, USER, or WORLD."})
    store = get_memory_store()
    await store.update_section(file, section, content)
    return json.dumps({"updated": file, "section": section})

memory_update_tool = ToolHandler(
    definition=ToolDefinition(
        name="memory_update",
        description="Replace a markdown section in a memory file (SOUL/USER/WORLD). Creates if missing.",
        parameters={
            "type": "object",
            "properties": {
                "file": {"type": "string", "description": "Memory file: SOUL, USER, or WORLD"},
                "section": {"type": "string", "description": "Section heading (e.g. 'Preferences')"},
                "content": {"type": "string", "description": "New section content"},
            },
            "required": ["file", "section", "content"],
        },
    ),
    execute=_memory_update,
)

# ── memory_append ──

async def _memory_append(args: dict) -> str:
    from src.evolution.memory import get_memory_store
    file = args.get("file", "").upper()
    section = args.get("section", "")
    entry = args.get("entry", "")
    if file not in ("SOUL", "USER", "WORLD"):
        return json.dumps({"error": f"Invalid file: {file}. Must be SOUL, USER, or WORLD."})
    store = get_memory_store()
    await store.append_entry(file, section, entry)
    return json.dumps({"appended": file, "section": section})

memory_append_tool = ToolHandler(
    definition=ToolDefinition(
        name="memory_append",
        description="Append a timestamped entry to a section in a memory file.",
        parameters={
            "type": "object",
            "properties": {
                "file": {"type": "string", "description": "Memory file: SOUL, USER, or WORLD"},
                "section": {"type": "string", "description": "Section heading"},
                "entry": {"type": "string", "description": "Entry text (timestamp auto-prepended)"},
            },
            "required": ["file", "section", "entry"],
        },
    ),
    execute=_memory_append,
)

# ── memory_read ──

async def _memory_read(args: dict) -> str:
    from src.evolution.memory import get_memory_store
    file = args.get("file", "").upper()
    if file not in ("SOUL", "USER", "WORLD"):
        return json.dumps({"error": f"Invalid file: {file}. Must be SOUL, USER, or WORLD."})
    store = get_memory_store()
    content = await store.read(file)
    return content if content else "(empty)"

memory_read_tool = ToolHandler(
    definition=ToolDefinition(
        name="memory_read",
        description="Read the full content of a memory file (SOUL/USER/WORLD).",
        parameters={
            "type": "object",
            "properties": {
                "file": {"type": "string", "description": "Memory file: SOUL, USER, or WORLD"},
            },
            "required": ["file"],
        },
    ),
    execute=_memory_read,
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
                "name": {"type": "string", "description": "Skill name (without 'skill_' prefix)"},
                "args": {"type": "object", "description": "Arguments to pass to the skill"},
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
        handler = await loader.hot_reload(filename if filename.endswith(".skill.py") else filename + ".skill.py")
        if handler:
            return json.dumps({"created": path, "skill": handler.definition.name})
        return json.dumps({"created": path, "warning": "File written but skill could not be loaded. Check module structure."})
    except FileExistsError as e:
        return json.dumps({"error": str(e)})
    except Exception as e:
        return json.dumps({"error": str(e), "hint": "Ensure the file exports a 'skill' dict and 'execute' async function."})

skill_create_tool = ToolHandler(
    definition=ToolDefinition(
        name="skill_create",
        description="Create or update a dynamic skill file (.skill.py). Hot-reloads on success.",
        parameters={
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Filename (e.g. 'my-tool.skill.py')"},
                "source": {"type": "string", "description": "Full Python source code"},
                "overwrite": {"type": "boolean", "description": "Overwrite existing file (default false)"},
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
    from src.evolution.skill_loader import get_skill_loader
    from pathlib import Path
    filename = args.get("filename", "")
    loader = get_skill_loader()
    skill_path = Path(loader._dir) / filename
    if not skill_path.exists():
        return json.dumps({"error": f"Skill file not found: {filename}"})
    content = skill_path.read_text(encoding="utf-8")
    lines = content.splitlines()
    numbered = "\n".join(f"{i+1:4d} | {line}" for i, line in enumerate(lines))
    return numbered

skill_read_tool = ToolHandler(
    definition=ToolDefinition(
        name="skill_read",
        description="Read the source code of a skill file for inspection or debugging.",
        parameters={
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Skill filename (e.g. 'my-tool.skill.py')"},
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
                "path": {"type": "string", "description": "Relative path from project root"},
                "content": {"type": "string", "description": "Full new file content"},
                "rationale": {"type": "string", "description": "Why this modification is needed"},
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
        return json.dumps({"error": "No run context available. Cannot spawn subagent outside of an agent run."})

    task = args.get("task", "")
    label = args.get("label", task[:50])
    timeout_s = args.get("timeout_seconds", 300)

    depth = ctx.get("depth", 0) + 1
    if depth > 3:
        return json.dumps({"error": f"Max subagent depth (3) exceeded. Current depth: {depth}"})

    from secrets import token_hex
    run_id = token_hex(6)
    set_subagent_depth(run_id, depth)

    import asyncio
    from src.agents.engine import get_agent_engine

    async def _run():
        try:
            engine = get_agent_engine()
            text_parts: list[str] = []
            async for event in engine.start_task("subagent", run_id, task):
                if event.type == "text" and event.content:
                    text_parts.append(event.content)
            result = "".join(text_parts) or "(no output)"

            announcement = f"[Subagent '{label}' (id: {run_id}) completed]\n\n{result}"
            parent_text: list[str] = []
            async for event in engine.start_task(ctx["channel"], ctx["peer_id"], announcement):
                if event.type == "text" and event.content:
                    parent_text.append(event.content)
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
                "task": {"type": "string", "description": "Full task description for the subagent"},
                "label": {"type": "string", "description": "Short label (defaults to first 50 chars of task)"},
                "timeout_seconds": {"type": "number", "description": "Timeout in seconds (default 300)"},
            },
            "required": ["task"],
        },
    ),
    execute=_subagent_spawn,
)
