"""Shell command execution tool, matching TS tools/builtin/shell.ts."""

from __future__ import annotations

import asyncio
import json
import os

from src.types import ToolDefinition, ToolHandler

PROJECT_ROOT = os.getcwd()
MAX_STDOUT = 10_240
MAX_STDERR = 5_120


async def _execute(args: dict) -> str:
    command = args.get("command", "")
    cwd = args.get("cwd", PROJECT_ROOT)
    timeout = args.get("timeout", 10)

    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return json.dumps({"error": "timeout", "timeout": timeout})

        return json.dumps({
            "exitCode": proc.returncode,
            "stdout": (stdout or b"").decode(errors="replace")[:MAX_STDOUT],
            "stderr": (stderr or b"").decode(errors="replace")[:MAX_STDERR],
        })
    except Exception as e:
        return json.dumps({"error": str(e)})


shell_tool = ToolHandler(
    definition=ToolDefinition(
        name="run_shell",
        description=(
            "Execute a shell command and return stdout/stderr. "
            "Use for system commands, file inspection, builds, etc. "
            "Warnings: do not use `find` without `-maxdepth`; do not start/restart servers."
        ),
        parameters={
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to execute.",
                },
                "cwd": {
                    "type": "string",
                    "description": f"Working directory (defaults to project root: {PROJECT_ROOT}).",
                },
                "timeout": {
                    "type": "number",
                    "description": "Timeout in seconds (default: 10).",
                },
            },
            "required": ["command"],
        },
    ),
    execute=_execute,
)
