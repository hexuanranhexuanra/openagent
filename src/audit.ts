import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const AUDIT_DIR = resolve(process.cwd(), "data", "audit");

interface AuditEntry {
  taskId: string;
  action: string;
  who: string;
  channel: string;
  detail?: Record<string, unknown>;
}

let initialized = false;

function ensureDir(): void {
  if (initialized) return;
  if (!existsSync(AUDIT_DIR)) {
    mkdirSync(AUDIT_DIR, { recursive: true });
  }
  initialized = true;
}

/**
 * Append a structured audit log entry in JSONL format.
 * Each line: { ts, taskId, action, who, channel, detail }
 *
 * Audit files are rotated daily: audit-YYYY-MM-DD.jsonl
 */
export function auditLog(entry: AuditEntry): void {
  ensureDir();

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const filePath = resolve(AUDIT_DIR, `audit-${dateStr}.jsonl`);

  const line = JSON.stringify({
    ts: now.toISOString(),
    taskId: entry.taskId,
    action: entry.action,
    who: entry.who,
    channel: entry.channel,
    ...(entry.detail ? { detail: entry.detail } : {}),
  });

  try {
    appendFileSync(filePath, line + "\n");
  } catch {
    // Fail silently - audit should never crash the main process
  }
}
