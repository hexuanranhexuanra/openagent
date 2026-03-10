import type { ToolHandler } from "../../../types";
import { getConfig } from "../../../config/index";

/**
 * Read the current openagent.json configuration (with secrets masked).
 */
export const readConfigTool: ToolHandler = {
  definition: {
    name: "read_config",
    description:
      "Read the current openagent.json configuration. " +
      "API keys and secrets are masked for safety. " +
      "Use this to check current settings before making changes with write_config.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  async execute() {
    const config = getConfig();

    // Deep clone and mask secrets
    const safe = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
    const providers = safe.providers as Record<string, Record<string, unknown>> | undefined;
    if (providers) {
      for (const p of Object.values(providers)) {
        if (typeof p.apiKey === "string" && p.apiKey) {
          p.apiKey = p.apiKey.slice(0, 8) + "...";
        }
        if (typeof p.setupToken === "string" && p.setupToken) {
          p.setupToken = p.setupToken.slice(0, 8) + "...";
        }
      }
    }
    const channels = safe.channels as Record<string, Record<string, unknown>> | undefined;
    if (channels) {
      for (const ch of Object.values(channels)) {
        if (typeof ch.appSecret === "string" && ch.appSecret) {
          ch.appSecret = ch.appSecret.slice(0, 4) + "...";
        }
        if (typeof ch.botToken === "string" && ch.botToken) {
          ch.botToken = ch.botToken.slice(0, 8) + "...";
        }
      }
    }

    return JSON.stringify(safe, null, 2);
  },
};
