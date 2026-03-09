import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nanoid } from "nanoid";
import { createLogger } from "../logger";
import { runAgent } from "../agent";
import { getOutbox } from "./outbox";

const log = createLogger("background:cron");

export interface CronJob {
  id: string;
  name: string;
  cron: string;
  task: string;
  target: { channel: "webchat" | "feishu"; peerId: string };
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt: number;
}

// ── Cron expression parser ────────────────────────────────────────────────────
// Supports: * | */n | n  for each of the 5 fields (min hour dom month dow).

function parseCronField(field: string, min: number, max: number): number[] {
  if (field === "*") {
    return Array.from({ length: max - min + 1 }, (_, i) => i + min);
  }
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step <= 0) throw new Error(`Invalid cron step: ${field}`);
    const result: number[] = [];
    for (let i = min; i <= max; i += step) result.push(i);
    return result;
  }
  // Comma-separated list: "1,3,5"
  if (field.includes(",")) {
    return field.split(",").map((v) => {
      const n = parseInt(v.trim(), 10);
      if (isNaN(n)) throw new Error(`Invalid cron value: ${v}`);
      return n;
    });
  }
  const val = parseInt(field, 10);
  if (isNaN(val)) throw new Error(`Invalid cron field: ${field}`);
  return [val];
}

/**
 * Compute the next Date on or after `from + 1 minute` that matches `cronExpr`.
 * Standard 5-field format: minute hour dom month dow
 */
export function nextRunDate(cronExpr: string, from: Date = new Date()): Date {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron must have 5 fields: "${cronExpr}"`);

  const [minF, hrF, domF, monF, dowF] = parts;
  const minutes = parseCronField(minF, 0, 59);
  const hours = parseCronField(hrF, 0, 23);
  const doms = parseCronField(domF, 1, 31);
  const months = parseCronField(monF, 1, 12);
  const dows = parseCronField(dowF, 0, 6);

  // Start from the next minute
  const d = new Date(from.getTime() + 60_000);
  d.setSeconds(0, 0);

  const limit = new Date(from.getTime() + 366 * 24 * 3600 * 1000);
  while (d < limit) {
    if (
      months.includes(d.getMonth() + 1) &&
      doms.includes(d.getDate()) &&
      dows.includes(d.getDay()) &&
      hours.includes(d.getHours()) &&
      minutes.includes(d.getMinutes())
    ) {
      return new Date(d);
    }
    d.setTime(d.getTime() + 60_000);
  }
  throw new Error(`No valid next run found for: "${cronExpr}"`);
}

// ── CronService ───────────────────────────────────────────────────────────────

export class CronService {
  private jobs = new Map<string, CronJob>();
  private running = new Set<string>(); // job ids currently executing
  private timer: ReturnType<typeof setInterval> | null = null;
  private jobsPath: string;

  constructor() {
    const dir = resolve(process.cwd(), "user-space", "cron");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.jobsPath = resolve(dir, "jobs.json");
  }

  start(): void {
    this.loadJobs();
    this.timer = setInterval(() => this.tick(), 1_000);
    log.info("CronService started", { jobs: this.jobs.size });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("CronService stopped");
  }

  private tick(): void {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (!job.enabled) continue;
      if (job.nextRunAt > now) continue;
      if (this.running.has(job.id)) {
        log.warn("Job still running, skipping trigger", { jobId: job.id, name: job.name });
        // Advance nextRunAt to avoid repeated skip-logs
        job.nextRunAt = nextRunDate(job.cron).getTime();
        continue;
      }
      this.executeJob(job);
    }
  }

  private executeJob(job: CronJob): void {
    this.running.add(job.id);
    log.info("Executing cron job", { jobId: job.id, name: job.name });

    (async () => {
      try {
        const chunks: string[] = [];
        for await (const event of runAgent("cron", job.id, job.task)) {
          if (event.type === "text") chunks.push(event.content ?? "");
        }
        const output = chunks.join("").trim();
        if (output) {
          await getOutbox().push("cron", job.target, output, job.id);
        }
        log.info("Cron job complete", { jobId: job.id, name: job.name });
      } catch (err) {
        log.error("Cron job failed", {
          jobId: job.id,
          name: job.name,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.running.delete(job.id);
        job.lastRunAt = Date.now();
        job.nextRunAt = nextRunDate(job.cron).getTime();
        this.persistJobs();
      }
    })();
  }

  addJob(params: {
    name: string;
    cron: string;
    task: string;
    target: { channel: "webchat" | "feishu"; peerId: string };
  }): CronJob {
    // Validate cron expression
    nextRunDate(params.cron); // throws on invalid

    const job: CronJob = {
      id: nanoid(10),
      name: params.name,
      cron: params.cron,
      task: params.task,
      target: params.target,
      enabled: true,
      createdAt: Date.now(),
      nextRunAt: nextRunDate(params.cron).getTime(),
    };

    this.jobs.set(job.id, job);
    this.persistJobs();
    log.info("Cron job added", { jobId: job.id, name: job.name, cron: job.cron });
    return job;
  }

  removeJob(id: string): boolean {
    const existed = this.jobs.delete(id);
    if (existed) {
      this.persistJobs();
      log.info("Cron job removed", { jobId: id });
    }
    return existed;
  }

  listJobs(): CronJob[] {
    return [...this.jobs.values()];
  }

  /** Trigger a job immediately, outside of its schedule. */
  async triggerNow(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.executeJob(job);
    return true;
  }

  private loadJobs(): void {
    if (!existsSync(this.jobsPath)) return;
    try {
      const raw = readFileSync(this.jobsPath, "utf-8");
      const list = JSON.parse(raw) as CronJob[];
      for (const job of list) {
        // Recompute nextRunAt in case process was down for a while
        if (job.enabled) {
          job.nextRunAt = nextRunDate(job.cron).getTime();
        }
        this.jobs.set(job.id, job);
      }
      log.info("Cron jobs loaded", { count: this.jobs.size });
    } catch (err) {
      log.error("Failed to load jobs.json, starting empty", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private persistJobs(): void {
    const list = [...this.jobs.values()];
    Bun.write(this.jobsPath, JSON.stringify(list, null, 2)).catch((err) => {
      log.warn("Failed to persist jobs.json", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

let _cron: CronService | null = null;

export function getCronService(): CronService {
  if (!_cron) _cron = new CronService();
  return _cron;
}
