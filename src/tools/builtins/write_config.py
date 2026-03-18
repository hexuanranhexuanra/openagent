"""Write config tool, matching TS tools/builtin/write-config.ts."""

from __future__ import annotations

import json
from pathlib import Path

from src.types import ToolDefinition, ToolHandler
from src.utils.logger import create_logger

log = create_logger("tools:write-config")

CONFIG_PATH = Path("openagent.json")


def _deep_merge(base: dict, updates: dict) -> dict:
    for key, value in updates.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


async def _execute(args: dict) -> str:
    config_update = args.get("config", {})
    reason = args.get("reason", "")

    if not isinstance(config_update, dict):
        return json.dumps({"error": "config must be an object"})

    # Validate Feishu config
    feishu = (config_update.get("channels") or {}).get("feishu")
    if feishu and (not feishu.get("appId") or not feishu.get("appSecret")):
        return json.dumps({"error": "Feishu config requires both appId and appSecret"})

    try:
        existing = json.loads(CONFIG_PATH.read_text(encoding="utf-8")) if CONFIG_PATH.exists() else {}
        merged = _deep_merge(existing, config_update)
        CONFIG_PATH.write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

        from src.config import reload_config
        reload_config()

        updated_keys = list(config_update.keys())
        log.info("Config updated", {"keys": updated_keys, "reason": reason})

        return json.dumps({
            "status": "DONE",
            "ok": True,
            "updatedKeys": updated_keys,
            "message": f"Config updated: {', '.join(updated_keys)}",
            "next_action": "STOP — do not call any more tools unless the user asks.",
        })
    except Exception as e:
        return json.dumps({"error": str(e)})


write_config_tool = ToolHandler(
    definition=ToolDefinition(
        name="write_config",
        description="Update the OpenAgent configuration. Merges changes into openagent.json and reloads.",
        parameters={
            "type": "object",
            "properties": {
                "config": {
                    "type": "object",
                    "description": "Partial config object to deep-merge into existing config.",
                },
                "reason": {
                    "type": "string",
                    "description": "Why this config change is being made.",
                },
            },
            "required": ["config"],
        },
    ),
    execute=_execute,
)
