/**
 * GatewayAdapter — the bridge between Channel Adapter and Agent.
 *
 * Key design (from doc):
 * - Reads from the inbound queue in a main dispatch loop
 * - For each (channelType, peerId), maintains an independent session loop
 *   so concurrent users never block each other
 * - If a session is already running (user sent a second message mid-stream),
 *   the new message is buffered and processed immediately after
 * - Publishes completed responses to the outbound queue
 */
import { createLogger } from "../logger";
import { runAgent } from "../agent";
import type { InboundMessage } from "../types";
import type { MessageQueue } from "./message-queue";

const log = createLogger("channel:gateway-adapter");

export class GatewayAdapter {
  private running = false;
  private sessionAborts = new Map<string, AbortController>();
  // Per-session pending buffer: messages that arrived while session was busy
  private sessionPending = new Map<string, InboundMessage[]>();

  /**
   * Start consuming from the inbound queue.
   * Runs until stop() is called. Should be called without await (runs in background).
   */
  async start(queue: MessageQueue): Promise<void> {
    this.running = true;
    log.info("GatewayAdapter started");

    while (this.running) {
      const msg = await queue.consumeInbound();
      if (!msg) break; // queue stopped

      const sessionKey = `${msg.channelType}:${msg.peerId}`;

      if (this.sessionAborts.has(sessionKey)) {
        // Session is busy — buffer the message for sequential processing
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
    const abort = new AbortController();
    this.sessionAborts.set(sessionKey, abort);

    this.runSession(sessionKey, msg, queue, abort.signal)
      .catch((err) => {
        log.error("Session error", { sessionKey, error: String(err) });
      })
      .finally(() => {
        this.sessionAborts.delete(sessionKey);
        // Drain next buffered message for this session
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
    signal: AbortSignal,
  ): Promise<void> {
    log.info("Session started", { sessionKey, contentLength: msg.content.length });

    let fullResponse = "";
    let hasError = false;

    try {
      const stream = runAgent(msg.channelType, msg.peerId, msg.content);
      for await (const event of stream) {
        if (signal.aborted) {
          log.debug("Session aborted", { sessionKey });
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

    if (fullResponse && !signal.aborted) {
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
    for (const ctrl of this.sessionAborts.values()) {
      ctrl.abort();
    }
    this.sessionAborts.clear();
    this.sessionPending.clear();
    log.info("GatewayAdapter stopped");
  }

  getActiveSessions(): string[] {
    return [...this.sessionAborts.keys()];
  }

  getStats(): { activeSessions: number; pendingBuffers: number } {
    return {
      activeSessions: this.sessionAborts.size,
      pendingBuffers: [...this.sessionPending.values()].reduce((sum, q) => sum + q.length, 0),
    };
  }
}

let _adapter: GatewayAdapter | null = null;

export function getGatewayAdapter(): GatewayAdapter {
  if (!_adapter) _adapter = new GatewayAdapter();
  return _adapter;
}
