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
  // Support ak= style query param auth (ByteDance GenAI, etc.)
  if (env.OPENAI_QUERY_AK) {
    if (!merged.providers.openai.queryParams) merged.providers.openai.queryParams = {};
    (merged.providers.openai.queryParams as Record<string, string>).ak = env.OPENAI_QUERY_AK;
  }

  if (!merged.providers.anthropic) merged.providers.anthropic = {};
  if (env.ANTHROPIC_API_KEY) merged.providers.anthropic.apiKey = env.ANTHROPIC_API_KEY;
  if (env.ANTHROPIC_MODEL) merged.providers.anthropic.model = env.ANTHROPIC_MODEL;
  // Support both naming conventions for the OAuth token
  const setupToken = env.ANTHROPIC_SETUP_TOKEN ?? env.CLAUDE_CODE_OAUTH_TOKEN;
  if (setupToken) merged.providers.anthropic.setupToken = setupToken;

  if (!merged.agent) merged.agent = {};
  if (env.DEFAULT_PROVIDER) (merged.agent as Record<string, unknown>).defaultProvider = env.DEFAULT_PROVIDER;

  if (!merged.channels) merged.channels = {} as Record<string, Record<string, unknown>>;
  if (!merged.channels.feishu) merged.channels.feishu = {};
  // Env vars are fallbacks for Feishu — openagent.json values take priority
  // (the .env file may be shared with other projects using different Feishu apps)
  if (!merged.channels.feishu.appId && env.LARK_APP_ID) merged.channels.feishu.appId = env.LARK_APP_ID;
  if (!merged.channels.feishu.appSecret && env.LARK_APP_SECRET) merged.channels.feishu.appSecret = env.LARK_APP_SECRET;
  if (!merged.channels.feishu.encryptKey && env.LARK_ENCRYPT_KEY) merged.channels.feishu.encryptKey = env.LARK_ENCRYPT_KEY;
  if (!merged.channels.feishu.verificationToken && env.LARK_VERIFICATION_TOKEN) merged.channels.feishu.verificationToken = env.LARK_VERIFICATION_TOKEN;
  if (merged.channels.feishu.appId && merged.channels.feishu.appSecret) merged.channels.feishu.enabled = true;

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

/**
 * Re-read openagent.json from disk and replace the in-memory config.
 * Call this after programmatically writing to openagent.json so that
 * getConfig() immediately reflects the new values in the same process.
 */
export function reloadConfig(): AppConfig {
  _config = null;
  return loadConfig();
}

export type { AppConfig } from "./schema";
