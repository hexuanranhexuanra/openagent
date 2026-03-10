import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { ToolHandler } from "../../../types";

/**
 * Update openagent.json, immediately reload the in-memory config, and
 * hot-start any newly enabled channels (Feishu, etc.) in the running
 * gateway process — no restart required.
 *
 * If the gateway is not running (e.g. CLI chat mode), the file is still
 * written and the user is told to start/restart the gateway.
 */
export const writeConfigTool: ToolHandler = {
  definition: {
    name: "write_config",
    description:
      "Update the openagent.json configuration file and apply the changes immediately " +
      "to the running process. No gateway restart is required for channel configuration. " +
      "Common uses: enable channels (feishu, telegram), set API keys, change model settings. " +
      "For Feishu WebSocket mode only appId and appSecret are needed.",
    parameters: {
      type: "object",
      properties: {
        config: {
          type: "object",
          description:
            "Partial config to merge. Examples: " +
            '{ "channels": { "feishu": { "enabled": true, "appId": "...", "appSecret": "..." } } } ' +
            'or { "agent": { "defaultProvider": "anthropic" } }',
          additionalProperties: true,
        },
        reason: {
          type: "string",
          description: "Why this config change is being made (for audit purposes)",
        },
      },
      required: ["config"],
    },
  },

  async execute(args) {
    const updates = args.config as Record<string, unknown>;

    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      return JSON.stringify({ error: "config must be a non-array object" });
    }

    // Validate Feishu config: for WebSocket mode only appId + appSecret are
    // required. Warn if either is missing but still check both.
    const feishuUpdates = (
      (updates.channels as Record<string, unknown> | undefined)?.feishu as
        | Record<string, unknown>
        | undefined
    );
    if (feishuUpdates) {
      const required = ["appId", "appSecret"] as const;
      const missing = required.filter(
        (f) => !feishuUpdates[f] || feishuUpdates[f] === "",
      );
      if (missing.length > 0) {
        return JSON.stringify({
          error: "Feishu configuration is incomplete.",
          missingFields: missing,
          action:
            "Ask the user to provide the missing Feishu fields before calling write_config. " +
            "Required for WebSocket mode: appId, appSecret.",
        });
      }
    }

    // ── 1. Write to disk ──────────────────────────────────────────────────────
    const configPath = resolve(process.cwd(), "openagent.json");

    let existing: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        const text = await Bun.file(configPath).text();
        existing = JSON.parse(text);
      } catch {
        // Start fresh if file is malformed
      }
    }

    const merged = deepMerge(existing, updates);
    await Bun.write(configPath, JSON.stringify(merged, null, 2));

    // ── 2. Reload in-memory config ────────────────────────────────────────────
    const { reloadConfig } = await import("../../../config/index.js");
    const newConfig = reloadConfig();

    // ── 3. Hot-start newly enabled channels ───────────────────────────────────
    const startedChannels: string[] = [];
    const channelErrors: string[] = [];

    try {
      const { getChannelManager } = await import("../../../channels/manager.js");
      const mgr = getChannelManager();

      if (mgr) {
        // Feishu WebSocket channel
        const feishuCfg = newConfig.channels.feishu;
        if (feishuCfg.appId && feishuCfg.appSecret && !mgr.getChannel("feishu")) {
          try {
            const { FeishuChannel } = await import("../../../channels/feishu-ws.js");
            const ch = new FeishuChannel({
              appId: feishuCfg.appId,
              appSecret: feishuCfg.appSecret,
            });
            mgr.register(ch);
            await ch.start();
            startedChannels.push("feishu");
          } catch (err) {
            channelErrors.push(
              `feishu: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    } catch {
      // Channel manager not available (CLI chat mode) — silently skip hot-start
    }

    // ── 4. Build result ───────────────────────────────────────────────────────
    const gatewayRunning = startedChannels.length > 0 || channelErrors.length > 0;

    return JSON.stringify({
      status: "DONE",
      ok: true,
      updatedKeys: Object.keys(updates),
      startedChannels,
      channelErrors: channelErrors.length > 0 ? channelErrors : undefined,
      message: gatewayRunning
        ? startedChannels.length > 0
          ? `Config applied. Channels started immediately: ${startedChannels.join(", ")}. No restart needed.`
          : `Config written but channel start failed: ${channelErrors.join("; ")}. Check credentials and try restarting.`
        : "Config saved to openagent.json. " +
          "Gateway is not running in this process — start or restart it: " +
          "bun run daemon  (or bun run dev for development).",
      next_action:
        "STOP — do not call any more tools. " +
        "Report the above result to the user in plain language.",
    });
  },
};

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (
      sv !== null &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      tv !== null &&
      typeof tv === "object" &&
      !Array.isArray(tv)
    ) {
      result[key] = deepMerge(
        tv as Record<string, unknown>,
        sv as Record<string, unknown>,
      );
    } else {
      result[key] = sv;
    }
  }
  return result;
}
