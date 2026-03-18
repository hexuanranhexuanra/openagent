"""Read config tool, matching TS tools/builtin/read-config.ts."""

from __future__ import annotations

import json

from src.types import ToolDefinition, ToolHandler


def _mask(value: str, keep: int = 8) -> str:
    if not value or len(value) <= keep:
        return value
    return value[:keep] + "..."


async def _execute(args: dict) -> str:
    from src.config import get_config

    config = get_config()
    raw = config.model_dump(by_alias=True)

    # Mask sensitive fields
    if p := raw.get("providers"):
        if oai := p.get("openai"):
            if oai.get("apiKey"):
                oai["apiKey"] = _mask(oai["apiKey"])
        if ant := p.get("anthropic"):
            if ant.get("apiKey"):
                ant["apiKey"] = _mask(ant["apiKey"])
            if ant.get("setupToken"):
                ant["setupToken"] = _mask(ant["setupToken"])
    if ch := raw.get("channels"):
        if feishu := ch.get("feishu"):
            if feishu.get("appSecret"):
                feishu["appSecret"] = _mask(feishu["appSecret"], 4)
        if tg := ch.get("telegram"):
            if tg.get("botToken"):
                tg["botToken"] = _mask(tg["botToken"])

    return json.dumps(raw, indent=2)


read_config_tool = ToolHandler(
    definition=ToolDefinition(
        name="read_config",
        description="Read the current OpenAgent configuration (API keys are masked).",
        parameters={"type": "object", "properties": {}},
    ),
    execute=_execute,
)
