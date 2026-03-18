"""Heartbeat task management tool, matching TS tools/builtin/heartbeat-tool.ts."""

from __future__ import annotations

import json
import re
from pathlib import Path

from src.types import ToolDefinition, ToolHandler

HEARTBEAT_PATH = Path("user-space/memory/HEARTBEAT.md")
UNCHECKED_RE = re.compile(r"^-\s+\[\s+\]", re.MULTILINE)


async def _execute(args: dict) -> str:
    action = args.get("action", "")

    if action == "read":
        if not HEARTBEAT_PATH.exists():
            return json.dumps({"tasks": [], "count": 0})
        content = HEARTBEAT_PATH.read_text(encoding="utf-8")
        tasks = [line.strip() for line in content.splitlines() if UNCHECKED_RE.match(line.strip())]
        return json.dumps({"tasks": tasks, "count": len(tasks)})

    elif action == "add":
        task = args.get("task", "")
        if not task:
            return json.dumps({"error": "add requires task"})
        if not HEARTBEAT_PATH.exists():
            HEARTBEAT_PATH.parent.mkdir(parents=True, exist_ok=True)
            HEARTBEAT_PATH.write_text("# Heartbeat Tasks\n\n", encoding="utf-8")
        with open(HEARTBEAT_PATH, "a", encoding="utf-8") as f:
            f.write(f"- [ ] {task}\n")
        return json.dumps({"added": task})

    elif action == "clear":
        if not HEARTBEAT_PATH.exists():
            return json.dumps({"cleared": 0})
        content = HEARTBEAT_PATH.read_text(encoding="utf-8")
        lines = content.splitlines()
        kept = [l for l in lines if not UNCHECKED_RE.match(l.strip())]
        cleared = len(lines) - len(kept)
        HEARTBEAT_PATH.write_text("\n".join(kept) + "\n", encoding="utf-8")
        return json.dumps({"cleared": cleared})

    elif action == "tick":
        import asyncio
        from src.background.heartbeat import get_heartbeat_service
        service = get_heartbeat_service()
        asyncio.get_event_loop().create_task(service.tick())
        return json.dumps({"triggered": True, "note": "Heartbeat tick started in background"})

    else:
        return json.dumps({"error": f"Unknown action: {action}. Use read, add, clear, or tick."})


heartbeat_tool = ToolHandler(
    definition=ToolDefinition(
        name="heartbeat",
        description="Manage self-scheduled heartbeat tasks in HEARTBEAT.md. Actions: read, add, clear, tick.",
        parameters={
            "type": "object",
            "properties": {
                "action": {"type": "string", "description": "Action: read, add, clear, tick"},
                "task": {"type": "string", "description": "[add] Task description"},
            },
            "required": ["action"],
        },
    ),
    execute=_execute,
)
