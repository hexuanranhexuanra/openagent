"""Config loader: JSON file + env var overrides, matching TS config/index.ts."""

from __future__ import annotations

import json
import os
from copy import deepcopy
from pathlib import Path

from src.config.schema import AppConfig
from src.utils.logger import create_logger

log = create_logger("config")

_config: AppConfig | None = None


def _load_json(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _set_nested(d: dict, keys: list[str], value: object) -> None:
    """Set a nested dict value, creating intermediate dicts as needed."""
    for key in keys[:-1]:
        d = d.setdefault(key, {})
    d[keys[-1]] = value


def _apply_env_overrides(raw: dict) -> None:
    """Overlay environment variables onto the raw config dict (camelCase keys)."""
    env = os.environ

    # Gateway
    if v := env.get("GATEWAY_PORT"):
        _set_nested(raw, ["gateway", "port"], int(v))
    if v := env.get("GATEWAY_HOST"):
        _set_nested(raw, ["gateway", "host"], v)
    if v := env.get("GATEWAY_AUTH_TOKEN"):
        _set_nested(raw, ["gateway", "authToken"], v)

    # OpenAI provider
    if v := env.get("OPENAI_API_KEY"):
        _set_nested(raw, ["providers", "openai", "apiKey"], v)
    if v := env.get("OPENAI_BASE_URL"):
        _set_nested(raw, ["providers", "openai", "baseUrl"], v)
    if v := env.get("OPENAI_MODEL"):
        _set_nested(raw, ["providers", "openai", "model"], v)
    if v := env.get("OPENAI_QUERY_AK"):
        raw.setdefault("providers", {}).setdefault("openai", {}).setdefault("queryParams", {})
        raw["providers"]["openai"]["queryParams"]["ak"] = v

    # Anthropic provider
    if v := env.get("ANTHROPIC_API_KEY"):
        _set_nested(raw, ["providers", "anthropic", "apiKey"], v)
    if v := env.get("ANTHROPIC_MODEL"):
        _set_nested(raw, ["providers", "anthropic", "model"], v)
    setup_token = env.get("ANTHROPIC_SETUP_TOKEN") or env.get("CLAUDE_CODE_OAUTH_TOKEN")
    if setup_token:
        _set_nested(raw, ["providers", "anthropic", "setupToken"], setup_token)

    # Agent
    if v := env.get("DEFAULT_PROVIDER"):
        _set_nested(raw, ["agent", "defaultProvider"], v)

    # Feishu channel — env vars are fallbacks (JSON values take priority)
    feishu = raw.setdefault("channels", {}).setdefault("feishu", {})
    if not feishu.get("appId") and (v := env.get("LARK_APP_ID")):
        feishu["appId"] = v
    if not feishu.get("appSecret") and (v := env.get("LARK_APP_SECRET")):
        feishu["appSecret"] = v
    if not feishu.get("encryptKey") and (v := env.get("LARK_ENCRYPT_KEY")):
        feishu["encryptKey"] = v
    if not feishu.get("verificationToken") and (v := env.get("LARK_VERIFICATION_TOKEN")):
        feishu["verificationToken"] = v
    # Auto-enable if both appId and appSecret are present
    if feishu.get("appId") and feishu.get("appSecret"):
        feishu["enabled"] = True

    # Logging
    if v := env.get("LOG_LEVEL"):
        _set_nested(raw, ["logging", "level"], v)


def load_config(config_path: str | None = None) -> AppConfig:
    global _config
    if _config is not None:
        return _config

    file_path = config_path or str(Path.cwd() / "openagent.json")
    raw = _load_json(file_path)
    _apply_env_overrides(raw)
    _config = AppConfig.model_validate(raw)

    from src.utils.logger import set_log_level

    set_log_level(_config.logging.level)
    log.info("Config loaded", {"path": file_path})
    return _config


def get_config() -> AppConfig:
    if _config is None:
        return load_config()
    return _config


def reload_config() -> AppConfig:
    global _config
    _config = None
    return load_config()
