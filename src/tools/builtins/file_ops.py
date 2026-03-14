"""File operations within user-space/workspace, matching TS tools/builtin/file-ops.ts."""

from __future__ import annotations

import json
import os
from pathlib import Path

from src.types import ToolDefinition, ToolHandler

WORKSPACE_ROOT = Path(os.getcwd()) / "user-space" / "workspace"


def _resolve_safe(relative_path: str) -> Path | None:
    """Resolve a relative path within workspace root. Returns None if it escapes."""
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    resolved = (WORKSPACE_ROOT / relative_path).resolve()
    if not str(resolved).startswith(str(WORKSPACE_ROOT.resolve())):
        return None
    return resolved


async def _read_file(args: dict) -> str:
    path = args.get("path", "")
    resolved = _resolve_safe(path)
    if not resolved:
        return json.dumps({"error": "Path traversal denied"})
    if not resolved.exists():
        return json.dumps({"error": f"File not found: {path}"})
    if not resolved.is_file():
        return json.dumps({"error": f"Not a file: {path}"})

    content = resolved.read_text(encoding="utf-8", errors="replace")
    lines = content.splitlines()
    numbered = "\n".join(f"{i+1:4d} | {line}" for i, line in enumerate(lines))
    return numbered


async def _write_file(args: dict) -> str:
    path = args.get("path", "")
    content = args.get("content", "")
    resolved = _resolve_safe(path)
    if not resolved:
        return json.dumps({"error": "Path traversal denied"})

    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(content, encoding="utf-8")
    return json.dumps({"written": str(path), "bytes": len(content.encode("utf-8"))})


async def _list_files(args: dict) -> str:
    path = args.get("path", ".")
    resolved = _resolve_safe(path)
    if not resolved:
        return json.dumps({"error": "Path traversal denied"})
    if not resolved.exists() or not resolved.is_dir():
        return json.dumps({"error": f"Directory not found: {path}"})

    entries = []
    for item in sorted(resolved.iterdir()):
        if item.is_dir():
            entries.append(f"📁 {item.name}/")
        else:
            size = item.stat().st_size
            entries.append(f"📄 {item.name} ({size} bytes)")

    return "\n".join(entries) if entries else "(empty directory)"


read_file_tool = ToolHandler(
    definition=ToolDefinition(
        name="read_file",
        description="Read a file from the workspace (user-space/workspace/). Returns content with line numbers.",
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path within the workspace.",
                },
            },
            "required": ["path"],
        },
    ),
    execute=_read_file,
)

write_file_tool = ToolHandler(
    definition=ToolDefinition(
        name="write_file",
        description="Write a file to the workspace (user-space/workspace/). Creates directories as needed.",
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path within the workspace.",
                },
                "content": {
                    "type": "string",
                    "description": "File content to write.",
                },
            },
            "required": ["path", "content"],
        },
    ),
    execute=_write_file,
)

list_files_tool = ToolHandler(
    definition=ToolDefinition(
        name="list_files",
        description="List files in the workspace directory (user-space/workspace/).",
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative directory path (defaults to workspace root).",
                },
            },
        },
    ),
    execute=_list_files,
)
