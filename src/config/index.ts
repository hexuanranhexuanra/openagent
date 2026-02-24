import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { configSchema, type AppConfig } from "./schema";

let _config: AppConfig | null = null;

function loadJsonConfig(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = Bun.file(filePath);
    // Bun.file().json() is async, use readFileSync for simplicity at startup
    const text = require("node:fs").readFileSync(filePath, "utf-8");
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function mergeEnvOverrides(base: Record<string, unknown>): Record<string, unknown> {
  const env = process.env;
  const merged = structuredClone(base) as Record<string, Record<string, Record<string, unknown>>>;

  if (!merged.gateway) merged.gateway = {};
  if (env.GATEWAY_PORT) merged.gateway.port = Number(env.GATEWAY_PORT);
  if (env.GATEWAY_HOST) merged.gateway.host = env.GATEWAY_HOST;
  if (env.GATEWAY_AUTH_TOKEN) merged.gateway.authToken = env.GATEWAY_AUTH_TOKEN;

  if (!merged.providers) merged.providers = {} as Record<string, Record<string, unknown>>;
  if (!merged.providers.openai) merged.providers.openai = {};
  if (env.OPENAI_API_KEY) merged.providers.openai.apiKey = env.OPENAI_API_KEY;
  if (env.OPENAI_BASE_URL) merged.providers.openai.baseUrl = env.OPENAI_BASE_URL;
  if (env.OPENAI_MODEL) merged.providers.openai.model = env.OPENAI_MODEL;

  if (!merged.providers.anthropic) merged.providers.anthropic = {};
  if (env.ANTHROPIC_API_KEY) merged.providers.anthropic.apiKey = env.ANTHROPIC_API_KEY;
  if (env.ANTHROPIC_MODEL) merged.providers.anthropic.model = env.ANTHROPIC_MODEL;

  if (!merged.agent) merged.agent = {};
  if (env.DEFAULT_PROVIDER) (merged.agent as Record<string, unknown>).defaultProvider = env.DEFAULT_PROVIDER;

  if (!merged.logging) merged.logging = {};
  if (env.LOG_LEVEL) (merged.logging as Record<string, unknown>).level = env.LOG_LEVEL;

  return merged as unknown as Record<string, unknown>;
}

export function loadConfig(configPath?: string): AppConfig {
  if (_config) return _config;

  const filePath = configPath ?? resolve(process.cwd(), "openagent.json");
  const fileConfig = loadJsonConfig(filePath);
  const merged = mergeEnvOverrides(fileConfig);
  _config = configSchema.parse(merged);
  return _config;
}

export function getConfig(): AppConfig {
  if (!_config) return loadConfig();
  return _config;
}

export type { AppConfig } from "./schema";
