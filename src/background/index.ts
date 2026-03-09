import { createLogger } from "../logger";
import { getConfig } from "../config";
import { getOutbox } from "./outbox";
import { getCronService } from "./cron";
import { getHeartbeatService } from "./heartbeat";
import { broadcastEvent } from "../gateway/websocket";
import { getTenantToken, sendFeishuMessage } from "../channels/feishu-api";
import type { OutboxMessage } from "./outbox";

export { getCronService } from "./cron";
export { getHeartbeatService } from "./heartbeat";
export { getOutbox } from "./outbox";
export type { CronJob } from "./cron";
export type { OutboxMessage } from "./outbox";

const log = createLogger("background");

/**
 * Wire up outbox delivery handlers and return the initialised service singletons.
 * Call this once after initAgent(), before starting the HTTP server.
 *
 * Services are NOT started here — call .start() explicitly so tests can
 * initialise without triggering timers.
 */
export function initBackgroundServices(): {
  cron: ReturnType<typeof getCronService>;
  heartbeat: ReturnType<typeof getHeartbeatService>;
  outbox: ReturnType<typeof getOutbox>;
} {
  const outbox = getOutbox();
  const config = getConfig();

  // ── WebSocket delivery ────────────────────────────────────────────────────
  outbox.onDeliver(async (msg: OutboxMessage) => {
    if (msg.target.channel !== "webchat") return;
    broadcastEvent("agent_proactive", {
      source: msg.source,
      jobId: msg.jobId,
      content: msg.content,
      timestamp: msg.timestamp,
    });
    log.debug("Proactive message broadcast to webchat", { source: msg.source });
  });

  // ── Feishu delivery ───────────────────────────────────────────────────────
  outbox.onDeliver(async (msg: OutboxMessage) => {
    if (msg.target.channel !== "feishu") return;
    const feishu = config.channels?.feishu;
    if (!feishu?.appId || !feishu?.appSecret) {
      log.warn("Feishu not configured, skipping delivery", { jobId: msg.jobId });
      return;
    }
    try {
      const token = await getTenantToken(feishu.appId, feishu.appSecret);
      await sendFeishuMessage(token, msg.target.peerId, msg.content);
      log.debug("Proactive message delivered to Feishu", {
        source: msg.source,
        peerId: msg.target.peerId,
      });
    } catch (err) {
      log.error("Feishu proactive delivery failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return {
    cron: getCronService(),
    heartbeat: getHeartbeatService(),
    outbox,
  };
}
