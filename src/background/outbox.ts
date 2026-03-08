import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { nanoid } from "nanoid";
import { createLogger } from "../logger";

const log = createLogger("background:outbox");

export interface OutboxMessage {
  id: string;
  source: "cron" | "heartbeat" | "subagent";
  target: { channel: "webchat" | "feishu"; peerId: string };
  content: string;
  jobId?: string;
  timestamp: number;
}

type DeliveryHandler = (msg: OutboxMessage) => Promise<void>;

/**
 * OutboxWorker — central router for proactive messages produced by
 * background services (CronService, HeartbeatService).
 *
 * Delivery is in-memory (callbacks registered at startup). Each message
 * is also appended to a JSONL file for observability.
 */
export class OutboxWorker {
  private handlers: DeliveryHandler[] = [];
  private sessionsDir: string;

  constructor() {
    this.sessionsDir = resolve(process.cwd(), "user-space", "sessions");
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  /** Register a delivery callback. Multiple handlers can be registered. */
  onDeliver(handler: DeliveryHandler): void {
    this.handlers.push(handler);
  }

  /** Push a message: persist to JSONL, then deliver via all handlers. */
  async push(
    source: OutboxMessage["source"],
    target: OutboxMessage["target"],
    content: string,
    jobId?: string,
  ): Promise<void> {
    if (!content.trim()) return;

    const msg: OutboxMessage = {
      id: nanoid(10),
      source,
      target,
      content,
      jobId,
      timestamp: Date.now(),
    };

    this.persist(msg);

    for (const handler of this.handlers) {
      try {
        await handler(msg);
      } catch (err) {
        log.error("Delivery handler failed", {
          error: err instanceof Error ? err.message : String(err),
          source,
          channel: target.channel,
        });
      }
    }
  }

  private persist(msg: OutboxMessage): void {
    const file = resolve(this.sessionsDir, `${msg.source}_outbox.jsonl`);
    try {
      appendFileSync(file, JSON.stringify(msg) + "\n");
    } catch (err) {
      log.warn("Failed to persist outbox message", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

let _outbox: OutboxWorker | null = null;

export function getOutbox(): OutboxWorker {
  if (!_outbox) _outbox = new OutboxWorker();
  return _outbox;
}
