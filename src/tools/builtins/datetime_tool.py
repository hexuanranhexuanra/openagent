"""Current datetime tool, matching TS tools/builtin/datetime.ts."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from src.types import ToolDefinition, ToolHandler


async def _execute(args: dict) -> str:
    tz_name = args.get("timezone")
    try:
        tz = ZoneInfo(tz_name) if tz_name else None
    except Exception:
        tz = None

    now = datetime.now(tz or timezone.utc)
    if tz is None:
        # Use system local timezone
        now = datetime.now().astimezone()
        tz_name = str(now.tzinfo)

    formatted = now.strftime("%A, %B %d, %Y %H:%M:%S")

    return json.dumps({
        "iso": now.isoformat(),
        "formatted": formatted,
        "timezone": tz_name or str(now.tzinfo),
        "unixMs": int(now.timestamp() * 1000),
    })


datetime_tool = ToolHandler(
    definition=ToolDefinition(
        name="get_current_datetime",
        description="Get the current date and time, optionally in a specific timezone.",
        parameters={
            "type": "object",
            "properties": {
                "timezone": {
                    "type": "string",
                    "description": "IANA timezone name (e.g. 'America/New_York'). Defaults to system timezone.",
                },
            },
        },
    ),
    execute=_execute,
)
