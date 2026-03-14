"""Configuration schema — Pydantic models matching the Zod schema in TS."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


def _to_camel(name: str) -> str:
    parts = name.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


class _CamelModel(BaseModel):
    """Base that reads/writes camelCase JSON while using snake_case in Python."""

    model_config = {"alias_generator": _to_camel, "populate_by_name": True}


class GatewayConfig(_CamelModel):
    port: int = 19090
    host: str = "127.0.0.1"
    auth_token: str | None = None


class OpenAIProviderConfig(_CamelModel):
    api_key: str = ""
    base_url: str = "https://api.openai.com/v1"
    model: str = "gpt-4o"
    query_params: dict[str, str] = Field(default_factory=dict)


class AnthropicProviderConfig(_CamelModel):
    api_key: str = ""
    model: str = "claude-opus-4-6"
    setup_token: str | None = None


class ProvidersConfig(_CamelModel):
    openai: OpenAIProviderConfig = Field(default_factory=OpenAIProviderConfig)
    anthropic: AnthropicProviderConfig = Field(default_factory=AnthropicProviderConfig)


class WebchatChannelConfig(_CamelModel):
    enabled: bool = True


class FeishuChannelConfig(_CamelModel):
    enabled: bool = False
    app_id: str = ""
    app_secret: str = ""
    encrypt_key: str = ""
    verification_token: str = ""


class TelegramChannelConfig(_CamelModel):
    enabled: bool = False
    bot_token: str = ""


class ChannelsConfig(_CamelModel):
    webchat: WebchatChannelConfig = Field(default_factory=WebchatChannelConfig)
    feishu: FeishuChannelConfig = Field(default_factory=FeishuChannelConfig)
    telegram: TelegramChannelConfig = Field(default_factory=TelegramChannelConfig)


class AgentConfig(_CamelModel):
    default_provider: Literal["openai", "anthropic", "claude-code"] = "openai"
    system_prompt: str = (
        "You are OpenAgent, a self-evolving personal AI assistant. "
        "You can use tools to help the user, remember things across sessions, "
        "create new skills, and even modify your own code. "
        "Be concise, accurate, and proactive about learning from interactions."
    )
    max_history_messages: int = 50
    max_tool_rounds: int = 10
    context_window: int = 128_000
    bootstrap_max_chars: int = 8_000
    bootstrap_total_max_chars: int = 40_000


class EvolutionConfig(_CamelModel):
    memory_path: str = "./user-space/memory"
    skills_path: str = "./user-space/skills"
    self_modify_enabled: bool = True
    reflection_enabled: bool = True


class LoggingConfig(_CamelModel):
    level: Literal["debug", "info", "warn", "error"] = "info"


class StorageConfig(_CamelModel):
    db_path: str = "./data/openagent.db"


class AppConfig(_CamelModel):
    gateway: GatewayConfig = Field(default_factory=GatewayConfig)
    agent: AgentConfig = Field(default_factory=AgentConfig)
    providers: ProvidersConfig = Field(default_factory=ProvidersConfig)
    channels: ChannelsConfig = Field(default_factory=ChannelsConfig)
    evolution: EvolutionConfig = Field(default_factory=EvolutionConfig)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)
    storage: StorageConfig = Field(default_factory=StorageConfig)
