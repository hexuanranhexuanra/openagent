import { createHash } from "node:crypto";

export type LoopLevel = "warning" | "critical";

export type LoopCheckResult =
  | { stuck: false }
  | { stuck: true; level: LoopLevel; message: string };

interface LoopDetectorOptions {
  windowSize?: number;     // rolling window of recent calls to inspect
  warnAt?: number;         // same call hash N times in window → warning
  stopAt?: number;         // same call hash N times in window → critical
  circuitBreaker?: number; // total calls in this run → hard stop
}

/**
 * LoopDetector — stateful per-run detector for stuck agent loops.
 *
 * Three detectors run on every tool call:
 *  1. generic_repeat  – same (tool, args) hash appears too many times in window
 *  2. ping_pong       – ABABAB alternating pattern across two distinct hashes
 *  3. circuit_breaker – absolute call count exceeds session budget
 *
 * When level="warning" the caller should append the message to the tool
 * result so the LLM reads it and can self-correct.
 * When level="critical" the caller must abort the current run.
 */
export class LoopDetector {
  private readonly window: string[] = [];
  private totalCalls = 0;

  private readonly windowSize: number;
  private readonly warnAt: number;
  private readonly stopAt: number;
  private readonly circuitBreaker: number;

  constructor(opts: LoopDetectorOptions = {}) {
    this.windowSize = opts.windowSize ?? 20;
    this.warnAt = opts.warnAt ?? 5;
    this.stopAt = opts.stopAt ?? 8;
    this.circuitBreaker = opts.circuitBreaker ?? 30;
  }

  check(toolName: string, args: unknown): LoopCheckResult {
    const hash = hashCall(toolName, args);
    this.window.push(hash);
    this.totalCalls++;
    if (this.window.length > this.windowSize) this.window.shift();

    // Circuit breaker — hard cap on total tool calls per run
    if (this.totalCalls >= this.circuitBreaker) {
      return {
        stuck: true,
        level: "critical",
        message:
          `Circuit breaker triggered: ${this.totalCalls} tool calls in this session. ` +
          "Stop executing tools, summarise what you have accomplished so far, and report to the user.",
      };
    }

    // Ping-pong: detect ABABAB — two tools alternating with same args
    if (this.window.length >= 6) {
      const tail = this.window.slice(-6);
      if (
        tail[0] === tail[2] &&
        tail[2] === tail[4] &&
        tail[1] === tail[3] &&
        tail[3] === tail[5] &&
        tail[0] !== tail[1]
      ) {
        return {
          stuck: true,
          level: "critical",
          message:
            "Loop detected: alternating between two tools with no progress. " +
            "Break the cycle — summarise your findings and take a different approach.",
        };
      }
    }

    // Generic repeat — same call too many times in window
    const count = this.window.filter((h) => h === hash).length;

    if (count >= this.stopAt) {
      return {
        stuck: true,
        level: "critical",
        message:
          `Loop detected: "${toolName}" called ${count} times with identical arguments. ` +
          "You must stop and try a fundamentally different approach.",
      };
    }

    if (count >= this.warnAt) {
      return {
        stuck: true,
        level: "warning",
        message:
          `Warning: "${toolName}" has been called ${count} times with the same arguments. ` +
          "Consider a different strategy to make progress.",
      };
    }

    return { stuck: false };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hashCall(toolName: string, args: unknown): string {
  const payload = `${toolName}:${stableStringify(args)}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${(value as unknown[]).map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
