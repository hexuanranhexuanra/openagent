"""Per-peer isolated notebook filesystem tool.

Renamed from memory_tool.py to avoid confusion with the global memory system.
Provides per-user sandboxed file storage for scratchpads, drafts, and working notes.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from src.types import ToolDefinition, ToolHandler

NOTEBOOK_ROOT = Path("data/notebooks")


def _sanitize(segment: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_\-.@:]", "_", segment)


def _resolve_safe(root: Path, user_path: str) -> Path | None:
    resolved = (root / user_path).resolve()
    if not str(resolved).startswith(str(root.resolve())):
        return None
    return resolved


def _ensure_root(peer_id: str) -> Path:
    safe_peer = _sanitize(peer_id)
    root = NOTEBOOK_ROOT / safe_peer
    root.mkdir(parents=True, exist_ok=True)
    return root


def _format_lines(content: str) -> str:
    lines = content.splitlines()
    return "\n".join(f"{i + 1:6d}\t{line}" for i, line in enumerate(lines))


async def _execute(args: dict) -> str:
    command = args.get("command", "")
    path = args.get("path", "")
    content = args.get("content", "")
    peer_id = args.get("peerId", "default")

    root = _ensure_root(peer_id)

    if command == "view":
        resolved = _resolve_safe(root, path)
        if not resolved:
            return json.dumps({"error": "Path traversal denied"})
        if not resolved.exists():
            return json.dumps({"error": f"Not found: {path}"})
        return _format_lines(resolved.read_text(encoding="utf-8", errors="replace"))

    elif command == "create":
        resolved = _resolve_safe(root, path)
        if not resolved:
            return json.dumps({"error": "Path traversal denied"})
        if resolved.exists():
            return json.dumps({"error": f"Already exists: {path}. Use 'edit' to update."})
        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_text(content, encoding="utf-8")
        return json.dumps({"created": path})

    elif command == "edit":
        resolved = _resolve_safe(root, path)
        if not resolved:
            return json.dumps({"error": "Path traversal denied"})
        if not resolved.exists():
            return json.dumps({"error": f"Not found: {path}. Use 'create' first."})
        resolved.write_text(content, encoding="utf-8")
        return json.dumps({"edited": path})

    elif command == "delete":
        resolved = _resolve_safe(root, path)
        if not resolved:
            return json.dumps({"error": "Path traversal denied"})
        if not resolved.exists():
            return json.dumps({"error": f"Not found: {path}"})
        resolved.unlink()
        return json.dumps({"deleted": path})

    elif command == "ls":
        resolved = _resolve_safe(root, path)
        if not resolved:
            return json.dumps({"error": "Path traversal denied"})
        if not resolved.exists() or not resolved.is_dir():
            return json.dumps({"error": f"Directory not found: {path}"})
        entries = []
        for item in sorted(resolved.iterdir()):
            if item.is_dir():
                entries.append(f"[dir]  {item.name}/")
            else:
                entries.append(f"[file] {item.name} ({item.stat().st_size} bytes)")
        return "\n".join(entries) if entries else "(empty)"

    else:
        return json.dumps({
            "error": f"Unknown command: {command}. Use view, create, edit, delete, ls."
        })


notebook_tool = ToolHandler(
    definition=ToolDefinition(
        name="notebook",
        description=(
            "Per-user isolated notebook/scratchpad. Use for user-specific notes, "
            "drafts, and working files. Commands: view, create, edit, delete, ls."
        ),
        parameters={
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Command: view, create, edit, delete, ls",
                },
                "path": {
                    "type": "string",
                    "description": "File path relative to notebook root",
                },
                "content": {
                    "type": "string",
                    "description": "[create, edit] File content",
                },
                "peerId": {
                    "type": "string",
                    "description": "User ID for workspace isolation (default: 'default')",
                },
            },
            "required": ["command", "path"],
        },
    ),
    execute=_execute,
)
