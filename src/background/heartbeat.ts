import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLogger } from "../logger";
import { runAgent } from "../agent";
import { getOutbox } from "./outbox";

const log = createLogger("background:heartbeat");

const HEARTBEAT_PATH = resolve(process.cwd(), "user-space", "memory", "HEARTBEAT.md");
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_PEER_ID = "default";

/**
 * HeartbeatService — periodically reads HEARTBEAT.md and dispatches
 * each unchecked "- [ ] task" line as an agent instruction.
 *
 * The agent itself can modify HEARTBEAT.md (via write_file) to schedule
 * future self-directed thinking.
 */
export class HeartbeatService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private isTicking = false;
  private target: { channel: "webchat" | "feishu"; peerId: string };

  constructor(target: { channel: "webchat" | "feishu"; peerId: string } = {
    channel: "webchat",
    peerId: "broadcast",
  }) {
    this.target = target;
  }

  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    this.ensureHeartbeatFile();
    this.timer = setInterval(() => this.tick(), intervalMs);
    log.info("HeartbeatService started", { intervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("HeartbeatService stopped");
  }

  /** Exposed for manual triggers and testing. */
  async tick(): Promise<void> {
    if (this.isTicking) {
      log.debug("Heartbeat tick skipped — previous tick still running");
      return;
    }
    this.isTicking = true;

    try {
      const tasks = await this.readTasks();
      if (tasks.length === 0) {
        log.debug("Heartbeat tick: no tasks");
        return;
      }

      log.info("Heartbeat tick", { tasks: tasks.length });

      for (const task of tasks) {
        try {
          const chunks: string[] = [];
          for await (const event of runAgent("heartbeat", SESSION_PEER_ID, task)) {
            if (event.type === "text") chunks.push(event.content ?? "");
          }
          const output = chunks.join("").trim();
          if (output) {
            await getOutbox().push("heartbeat", this.target, output);
          }
        } catch (err) {
          log.error("Heartbeat task failed", {
            task: task.slice(0, 80),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this.isTicking = false;
    }
  }

  private async readTasks(): Promise<string[]> {
    if (!existsSync(HEARTBEAT_PATH)) return [];
    const text = await Bun.file(HEARTBEAT_PATH).text();
    const tasks: string[] = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^-\s+\[\s+\]\s+(.+)/);
      if (m) tasks.push(m[1].trim());
    }
    return tasks;
  }

  private ensureHeartbeatFile(): void {
    if (!existsSync(HEARTBEAT_PATH)) {
      const template = [
        "# Heartbeat Tasks",
        "",
        "Add tasks below using `- [ ] description`.",
        "The agent checks this file every 30 minutes and executes each unchecked item.",
        "The agent can also add tasks here to self-schedule future thinking.",
        "",
        "## Examples (remove or edit these)",
        "",
        "- [ ] Review any reminders or pending items",
      ].join("\n") + "\n";
      writeFileSync(HEARTBEAT_PATH, template);
      log.info("HEARTBEAT.md created at", { path: HEARTBEAT_PATH });
    }
  }
}

let _heartbeat: HeartbeatService | null = null;

export function getHeartbeatService(): HeartbeatService {
  if (!_heartbeat) _heartbeat = new HeartbeatService();
  return _heartbeat;
}
