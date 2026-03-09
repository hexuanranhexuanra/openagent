import { nanoid } from "nanoid";
import { createLogger } from "../logger";

const log = createLogger("agent:subagent");

const MAX_DEPTH = 3;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
// How long to keep a completed run record before GC
const RUN_TTL_MS = 10 * 60_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type SubagentStatus = "running" | "done" | "error" | "timeout";

export interface SubagentRun {
  runId: string;
  label: string;
  parentChannel: string;
  parentPeerId: string;
  depth: number;
  status: SubagentStatus;
  startedAt: number;
  endedAt?: number;
}

/** Injected by StreamAgent before each tool-call batch. */
export interface RunContext {
  channel: string;
  peerId: string;
  depth: number;
}

export type SpawnOutcome =
  | { runId: string; status: "accepted"; note: string }
  | { error: string };

// ── Module state ──────────────────────────────────────────────────────────────

const runs = new Map<string, SubagentRun>();

/**
 * Current agent run context.
 * StreamAgent sets this before every tool-call batch so that the
 * sessions_spawn tool knows who is spawning.
 *
 * This is safe for single-threaded Bun/Node: each task runs in the
 * same event-loop turn, and JS is single-threaded so there is no race
 * between the set() and the tool execute() call within one round.
 */
let _currentRunContext: RunContext | null = null;

export function setCurrentRunContext(ctx: RunContext): void {
  _currentRunContext = ctx;
}

export function getCurrentRunContext(): RunContext | null {
  return _currentRunContext;
}

/** Depth for a subagent session keyed by its runId. */
export function getSubagentDepth(runId: string): number {
  return runs.get(runId)?.depth ?? 0;
}

export function listSubagentRuns(): SubagentRun[] {
  return [...runs.values()];
}

// ── Spawn ─────────────────────────────────────────────────────────────────────

export function spawnSubagent(params: {
  task: string;
  label: string;
  parentChannel: string;
  parentPeerId: string;
  parentDepth: number;
  timeoutMs?: number;
}): SpawnOutcome {
  const depth = params.parentDepth + 1;

  if (depth > MAX_DEPTH) {
    return {
      error:
        `Max subagent depth (${MAX_DEPTH}) exceeded. ` +
        "Cannot spawn further nested subagents at this level.",
    };
  }

  const runId = nanoid(12);
  const run: SubagentRun = {
    runId,
    label: params.label || params.task.slice(0, 50),
    parentChannel: params.parentChannel,
    parentPeerId: params.parentPeerId,
    depth,
    status: "running",
    startedAt: Date.now(),
  };

  runs.set(runId, run);

  log.info("Subagent spawned", {
    runId,
    label: run.label,
    parent: `${params.parentChannel}:${params.parentPeerId}`,
    depth,
  });

  executeInBackground(run, params.task, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  return {
    runId,
    status: "accepted",
    note:
      "Subagent is running independently. It will deliver its result back to you as a user " +
      "message when done. Do NOT poll for status — you will be notified automatically.",
  };
}

// ── Background execution ──────────────────────────────────────────────────────

function executeInBackground(run: SubagentRun, task: string, timeoutMs: number): void {
  const timeoutHandle = setTimeout(() => {
    const r = runs.get(run.runId);
    if (r?.status === "running") {
      r.status = "timeout";
      r.endedAt = Date.now();
      log.warn("Subagent timed out", { runId: run.runId, label: run.label });
      void deliverResult(
        run,
        `[Subagent '${run.label}' timed out after ${Math.round(timeoutMs / 1000)}s with no result.]`,
      );
    }
  }, timeoutMs);

  (async () => {
    const chunks: string[] = [];
    try {
      // Lazy import to break the static cycle:
      //   engine → stream-agent → subagent-registry → (lazy) engine
      const { getAgentEngine } = await import("./engine.js");
      for await (const event of getAgentEngine().startTask("subagent", run.runId, task)) {
        if (event.type === "text" && event.content) chunks.push(event.content);
        if (event.type === "error") throw new Error(event.error ?? "Subagent error");
      }

      clearTimeout(timeoutHandle);

      const r = runs.get(run.runId);
      if (r?.status === "running") {
        r.status = "done";
        r.endedAt = Date.now();
      }

      const result = chunks.join("").trim() || "(no output)";
      log.info("Subagent completed", { runId: run.runId, label: run.label });
      await deliverResult(run, result);
    } catch (err) {
      clearTimeout(timeoutHandle);
      const r = runs.get(run.runId);
      if (r?.status === "running") {
        r.status = "error";
        r.endedAt = Date.now();
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Subagent failed", { runId: run.runId, error: msg });
      await deliverResult(run, `[Subagent '${run.label}' failed: ${msg}]`);
    } finally {
      // Retain record briefly for observability, then GC
      setTimeout(() => runs.delete(run.runId), RUN_TTL_MS);
    }
  })();
}

// ── Result delivery ───────────────────────────────────────────────────────────

async function deliverResult(run: SubagentRun, result: string): Promise<void> {
  const announcement =
    `[Subagent '${run.label}' (id: ${run.runId}) completed]\n\n${result}`;

  try {
    const { getAgentEngine } = await import("./engine.js");
    const engine = getAgentEngine();

    // Inject the subagent result as a new user turn in the parent session.
    // The parent agent processes it and generates a reply.
    const outputChunks: string[] = [];
    for await (const event of engine.startTask(
      run.parentChannel,
      run.parentPeerId,
      announcement,
    )) {
      if (event.type === "text" && event.content) outputChunks.push(event.content);
    }

    const output = outputChunks.join("").trim();
    if (!output) return;

    // Push the parent's reply to the appropriate delivery channel.
    // Only webchat and feishu support push delivery; cli/api sessions
    // already have the result in their history.
    if (run.parentChannel === "webchat" || run.parentChannel === "feishu") {
      const { getOutbox } = await import("../background/outbox.js");
      await getOutbox().push(
        "subagent",
        { channel: run.parentChannel, peerId: run.parentPeerId },
        output,
        run.runId,
      );
    }
  } catch (err) {
    log.error("Failed to deliver subagent result to parent", {
      runId: run.runId,
      parent: `${run.parentChannel}:${run.parentPeerId}`,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
