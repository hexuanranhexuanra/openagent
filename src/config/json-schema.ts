/**
 * Convert the Zod config schema to JSON Schema + uiHints.
 *
 * This follows the OpenClaw pattern where a JSON Schema drives
 * dynamic form rendering, and uiHints provide labels, help text,
 * sensitive flags, grouping, and ordering metadata.
 */

import { configSchema } from "./schema";

export interface UiHint {
  label?: string;
  help?: string;
  placeholder?: string;
  sensitive?: boolean;
  group?: string;
  order?: number;
  advanced?: boolean;
  tags?: string[];
  multiline?: boolean;
}

export type UiHints = Record<string, UiHint>;

export interface ConfigSchemaBundle {
  schema: Record<string, unknown>;
  uiHints: UiHints;
  version: string;
  generatedAt: string;
}

// Hand-maintained uiHints — richer metadata than JSON Schema alone can express
const UI_HINTS: UiHints = {
  // Gateway
  "gateway": { label: "Gateway", order: 1, group: "system" },
  "gateway.port": { label: "Port", help: "HTTP port for the gateway server", placeholder: "18789" },
  "gateway.host": { label: "Host", help: "Bind address (use 0.0.0.0 for all interfaces)", placeholder: "127.0.0.1" },
  "gateway.authToken": { label: "Auth Token", help: "Bearer token to protect /api/* routes", sensitive: true, placeholder: "optional" },

  // Agent
  "agent": { label: "Agent", order: 2, group: "core" },
  "agent.defaultProvider": { label: "Default Provider", help: "Which LLM provider to use by default" },
  "agent.systemPrompt": { label: "System Prompt", help: "Base system prompt for the agent", multiline: true },
  "agent.maxHistoryMessages": { label: "Max History", help: "Max messages kept in session context" },
  "agent.maxToolRounds": { label: "Max Tool Rounds", help: "Max sequential tool calls per turn" },

  // Providers
  "providers": { label: "LLM Providers", order: 3, group: "core" },
  "providers.openai": { label: "OpenAI" },
  "providers.openai.apiKey": { label: "API Key", sensitive: true, placeholder: "sk-..." },
  "providers.openai.baseUrl": { label: "Base URL", help: "Custom endpoint (for proxies or Azure)", placeholder: "https://api.openai.com/v1" },
  "providers.openai.model": { label: "Model", placeholder: "gpt-4o" },
  "providers.anthropic": { label: "Anthropic" },
  "providers.anthropic.apiKey": { label: "API Key", sensitive: true, placeholder: "sk-ant-..." },
  "providers.anthropic.model": { label: "Model", placeholder: "claude-sonnet-4-20250514" },

  // Channels
  "channels": { label: "Channels", order: 4, group: "channels" },
  "channels.webchat": { label: "WebChat" },
  "channels.webchat.enabled": { label: "Enabled" },
  "channels.feishu": { label: "Feishu / Lark" },
  "channels.feishu.enabled": { label: "Enabled" },
  "channels.feishu.appId": { label: "App ID", placeholder: "cli_xxxxxxxx" },
  "channels.feishu.appSecret": { label: "App Secret", sensitive: true },
  "channels.feishu.encryptKey": { label: "Encrypt Key", sensitive: true, help: "Used for webhook signature verification" },
  "channels.feishu.verificationToken": { label: "Verification Token", sensitive: true },
  "channels.telegram": { label: "Telegram" },
  "channels.telegram.enabled": { label: "Enabled" },
  "channels.telegram.botToken": { label: "Bot Token", sensitive: true, placeholder: "123456:ABC-..." },

  // Evolution
  "evolution": { label: "Self-Evolution", order: 5, group: "evolution" },
  "evolution.memoryPath": { label: "Memory Path", help: "Directory for SOUL/USER/WORLD markdown files" },
  "evolution.skillsPath": { label: "Skills Path", help: "Directory for dynamic .skill.ts files" },
  "evolution.selfModifyEnabled": { label: "Self-Modify", help: "Allow agent to modify its own code" },
  "evolution.reflectionEnabled": { label: "Reflection", help: "Auto-analyze conversations and update memory" },

  // Logging
  "logging": { label: "Logging", order: 6, group: "system", advanced: true },
  "logging.level": { label: "Log Level" },

  // Storage
  "storage": { label: "Storage", order: 7, group: "system", advanced: true },
  "storage.dbPath": { label: "Database Path", placeholder: "./data/openagent.db" },
};

/**
 * Convert a Zod schema to a JSON Schema object (simplified recursive converter).
 * Handles the shapes we actually use: object, string, number, boolean, enum, optional.
 */
function zodToJsonSchema(schema: unknown): Record<string, unknown> {
  const s = schema as Record<string, unknown>;
  const typeName = (s as { _def?: { typeName?: string } })?._def?.typeName;
  const def = (s as { _def?: Record<string, unknown> })?._def ?? {};

  if (typeName === "ZodDefault") {
    const inner = zodToJsonSchema(def.innerType);
    if (def.defaultValue !== undefined) {
      const dv = typeof def.defaultValue === "function"
        ? (def.defaultValue as () => unknown)()
        : def.defaultValue;
      inner.default = dv;
    }
    return inner;
  }

  if (typeName === "ZodOptional") {
    return zodToJsonSchema(def.innerType);
  }

  if (typeName === "ZodObject") {
    const shape = (def.shape as () => Record<string, unknown>)?.() ?? {};
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, val] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(val);
      const innerTypeName = (val as { _def?: { typeName?: string } })?._def?.typeName;
      if (innerTypeName !== "ZodOptional" && innerTypeName !== "ZodDefault") {
        required.push(key);
      }
    }

    const result: Record<string, unknown> = { type: "object", properties };
    if (required.length > 0) result.required = required;
    return result;
  }

  if (typeName === "ZodString") {
    return { type: "string" };
  }

  if (typeName === "ZodNumber") {
    return { type: "number" };
  }

  if (typeName === "ZodBoolean") {
    return { type: "boolean" };
  }

  if (typeName === "ZodEnum") {
    const values = def.values as string[];
    return { type: "string", enum: values };
  }

  return { type: "string" };
}

/**
 * Build the full config schema bundle for the config UI.
 * Merges the core Zod schema with any plugin-provided schemas.
 */
export function buildConfigSchemaBundle(
  pluginSchemas?: Record<string, Record<string, unknown>>,
  pluginHints?: Record<string, UiHint>,
): ConfigSchemaBundle {
  const schema = zodToJsonSchema(configSchema);

  // Merge plugin schemas into channels or top-level
  if (pluginSchemas) {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, pluginSchema] of Object.entries(pluginSchemas)) {
      if (key.startsWith("channels.")) {
        const channelId = key.replace("channels.", "");
        const channelsProps = (props.channels?.properties ?? {}) as Record<string, unknown>;
        channelsProps[channelId] = pluginSchema;
      } else {
        props[key] = pluginSchema;
      }
    }
  }

  // Merge plugin hints
  const hints = { ...UI_HINTS };
  if (pluginHints) {
    Object.assign(hints, pluginHints);
  }

  return {
    schema,
    uiHints: hints,
    version: "0.2.0",
    generatedAt: new Date().toISOString(),
  };
}
