/**
 * GatewayAdapter — bridge between Channel Adapter and AgentEngine.
 *
 * Per-session serialization: while an agent task is running for a session,
 * new messages are buffered and processed sequentially after the task completes.
 * Cancellation is delegated to AgentEngine (which properly aborts the ReAct loop).
 */
import { createLogger } from "../logger";
import { runAgent, cancelAgent } from "../agent";
import type { InboundMessage } from "../types";
import type { MessageQueue } from "./message-queue";

const log = createLogger("channel:gateway-adapter");

export class GatewayAdapter {
  private running = false;
  // Sessions currently executing an agent task
  private runningSessions = new Set<string>();
  // Per-session pending buffer: messages that arrived while session was busy
  private sessionPending = new Map<string, InboundMessage[]>();

  async start(queue: MessageQueue): Promise<void> {
    this.running = true;
    log.info("GatewayAdapter started");

    while (this.running) {
      const msg = await queue.consumeInbound();
      if (!msg) break;

      const sessionKey = `${msg.channelType}:${msg.peerId}`;

      if (this.runningSessions.has(sessionKey)) {
        const pending = this.sessionPending.get(sessionKey) ?? [];
        pending.push(msg);
        this.sessionPending.set(sessionKey, pending);
        log.debug("Session busy, buffered", { sessionKey, buffered: pending.length });
      } else {
        this.spawnSession(sessionKey, msg, queue);
      }
    }

    log.info("GatewayAdapter dispatch loop exited");
  }

  private spawnSession(sessionKey: string, msg: InboundMessage, queue: MessageQueue): void {
    this.runningSessions.add(sessionKey);

    this.runSession(sessionKey, msg, queue)
      .catch((err) => {
        log.error("Session error", { sessionKey, error: String(err) });
      })
      .finally(() => {
        this.runningSessions.delete(sessionKey);
        const pending = this.sessionPending.get(sessionKey);
        if (pending?.length) {
          const next = pending.shift()!;
          if (pending.length === 0) this.sessionPending.delete(sessionKey);
          this.spawnSession(sessionKey, next, queue);
        }
      });
  }

  private async runSession(
    sessionKey: string,
    msg: InboundMessage,
    queue: MessageQueue,
  ): Promise<void> {
    log.info("Session started", { sessionKey, contentLength: msg.content.length });

    let fullResponse = "";
    let hasError = false;

    try {
      const stream = runAgent(msg.channelType, msg.peerId, msg.content);
      for await (const event of stream) {
        if (!this.runningSessions.has(sessionKey)) {
          // Session was removed (adapter stopped) — abort reading
          break;
        }
        if (event.type === "text") {
          fullResponse += event.content ?? "";
        } else if (event.type === "error") {
          log.error("Agent error in session", { sessionKey, error: event.error });
          fullResponse = `Error: ${event.error ?? "Unknown error"}`;
          hasError = true;
          break;
        }
      }
    } catch (err) {
      log.error("Session threw", { sessionKey, error: String(err) });
      fullResponse = `Error: ${err instanceof Error ? err.message : String(err)}`;
      hasError = true;
    }

    if (fullResponse && this.runningSessions.has(sessionKey)) {
      const raw = msg.raw as Record<string, unknown> | undefined;
      queue.publishOutbound({
        channelType: msg.channelType,
        channelId: msg.channelId,
        peerId: msg.peerId,
        content: fullResponse,
        replyToId: raw?.messageId as string | undefined,
      });
    }

    log.info("Session completed", {
      sessionKey,
      hasError,
      responseLength: fullResponse.length,
    });
  }

  stop(): void {
    this.running = false;
    // Cancel all running agent tasks via AgentEngine
    for (const sessionKey of this.runningSessions) {
      const [channelType, ...rest] = sessionKey.split(":");
      const peerId = rest.join(":");
      cancelAgent(channelType, peerId);
    }
    this.runningSessions.clear();
    this.sessionPending.clear();
    log.info("GatewayAdapter stopped");
  }

  getActiveSessions(): string[] {
    return [...this.runningSessions];
  }

  getStats(): { activeSessions: number; pendingBuffers: number } {
    return {
      activeSessions: this.runningSessions.size,
      pendingBuffers: [...this.sessionPending.values()].reduce((sum, q) => sum + q.length, 0),
    };
  }
}

let _adapter: GatewayAdapter | null = null;

export function getGatewayAdapter(): GatewayAdapter {
  if (!_adapter) _adapter = new GatewayAdapter();
  return _adapter;
}
