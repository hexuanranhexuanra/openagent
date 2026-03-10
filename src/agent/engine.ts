import { nanoid } from "nanoid";
import { createLogger } from "../logger";
import { getContextBuilder } from "./context";
import { StreamAgent } from "./stream-agent";
import { reflectOnConversation } from "../evolution/reflection";
import { getSessionMessages } from "../sessions/manager";
import type { AgentStreamEvent } from "./types";
import type { LLMProvider } from "./providers/base";

const log = createLogger("agent:engine");

export type TaskStatus = "running" | "done" | "cancelled" | "error";

export interface TaskInfo {
  taskId: string;
  sessionKey: string;
  status: TaskStatus;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

interface ActiveTask {
  info: TaskInfo;
  abort: AbortController;
}

/**
 * AgentEngine — stateful task lifecycle manager. Singleton per process.
 *
 * Owns the task state machine per session key:
 *   running → done | cancelled | error
 *
 * Delegates execution to StreamAgent (stateless).
 * Provides cancel support at the session level.
 */
export class AgentEngine {
  private tasks = new Map<string, ActiveTask>();
  private streamAgent: StreamAgent;

  constructor(provider: LLMProvider) {
    this.streamAgent = new StreamAgent(provider);
  }

  async *startTask(
    channel: string,
    peerId: string,
    message: string,
  ): AsyncGenerator<AgentStreamEvent> {
    const sessionKey = `${channel}:${peerId}`;

    // Cancel any existing running task for this session before starting a new one
    this.cancelTask(channel, peerId);

    const taskId = nanoid(8);
    const abort = new AbortController();
    const info: TaskInfo = {
      taskId,
      sessionKey,
      status: "running",
      startedAt: Date.now(),
    };

    this.tasks.set(sessionKey, { info, abort });
    log.info("Task started", { taskId, sessionKey });

    let sessionId: string | undefined;

    try {
      const ctx = await getContextBuilder().build(channel, peerId, message);
      sessionId = ctx.sessionId;
      yield* this.streamAgent.run(ctx, abort.signal);
    } catch (err) {
      if (!abort.signal.aborted) {
        info.status = "error";
        info.endedAt = Date.now();
        info.error = err instanceof Error ? err.message : String(err);
        log.error("Task error", { taskId, sessionKey, error: info.error });
        yield { type: "error", error: info.error };
      }
      return;
    } finally {
      // Retain task info for 60s after completion for observability
      setTimeout(() => {
        const current = this.tasks.get(sessionKey);
        if (current?.info.taskId === taskId) this.tasks.delete(sessionKey);
      }, 60_000);
    }

    if (!abort.signal.aborted) {
      info.status = "done";
      info.endedAt = Date.now();
      log.info("Task done", {
        taskId,
        sessionKey,
        durationMs: info.endedAt - info.startedAt,
      });

      if (sessionId) {
        const msgs = getSessionMessages(sessionId);
        reflectOnConversation(msgs, channel, peerId).catch((err) => {
        log.warn("Reflection failed (non-fatal)", {
          taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      }

      yield { type: "done" };
    }
  }

  /**
   * Cancel the running task for this session.
   * Returns true if a task was cancelled, false if none was running.
   */
  cancelTask(channel: string, peerId: string): boolean {
    const sessionKey = `${channel}:${peerId}`;
    const task = this.tasks.get(sessionKey);
    if (task?.info.status === "running") {
      task.abort.abort();
      task.info.status = "cancelled";
      task.info.endedAt = Date.now();
      log.info("Task cancelled", { taskId: task.info.taskId, sessionKey });
      return true;
    }
    return false;
  }

  isRunning(channel: string, peerId: string): boolean {
    return this.tasks.get(`${channel}:${peerId}`)?.info.status === "running";
  }

  getTaskInfo(channel: string, peerId: string): TaskInfo | undefined {
    return this.tasks.get(`${channel}:${peerId}`)?.info;
  }

  getActiveSessions(): string[] {
    return [...this.tasks.entries()]
      .filter(([, t]) => t.info.status === "running")
      .map(([key]) => key);
  }

  cancelAll(): void {
    for (const task of this.tasks.values()) {
      if (task.info.status === "running") {
        task.abort.abort();
        task.info.status = "cancelled";
        task.info.endedAt = Date.now();
      }
    }
    log.info("All tasks cancelled");
  }
}

let _engine: AgentEngine | null = null;

export function getAgentEngine(): AgentEngine {
  if (!_engine) throw new Error("AgentEngine not initialized. Call initAgent() first.");
  return _engine;
}

export function initAgentEngine(provider: LLMProvider): AgentEngine {
  _engine = new AgentEngine(provider);
  return _engine;
}
