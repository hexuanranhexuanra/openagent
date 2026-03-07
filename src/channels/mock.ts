/**
 * MockChannel — local testing without a real IM platform.
 *
 * Simulates inbound messages via simulateIncoming() and captures
 * outbound messages in sentMessages for assertion.
 */
import { createLogger } from "../logger";
import type { Channel } from "./base";
import type { IncomingMessage, OutgoingMessage } from "../types";

const log = createLogger("channel:mock");

export class MockChannel implements Channel {
  readonly type = "mock";

  readonly sentMessages: OutgoingMessage[] = [];
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;

  async start(): Promise<void> {
    log.info("MockChannel started");
  }

  async stop(): Promise<void> {
    log.info("MockChannel stopped");
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(message: OutgoingMessage): Promise<void> {
    this.sentMessages.push(message);
    log.info("MockChannel → send", {
      peerId: message.peerId,
      content: message.content.slice(0, 120),
    });
  }

  /** Simulate a user sending a message into the pipeline. */
  async simulateIncoming(content: string, peerId = "mock-user"): Promise<void> {
    if (!this.handler) {
      log.warn("MockChannel: no message handler registered");
      return;
    }
    await this.handler({
      channelType: "mock",
      channelId: "mock-chat",
      peerId,
      content,
      timestamp: Date.now(),
    });
  }

  clearSent(): void {
    this.sentMessages.length = 0;
  }
}
