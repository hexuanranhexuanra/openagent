import type { Channel } from "./base";
import type { IncomingMessage, OutgoingMessage } from "../types";
import { createLogger } from "../logger";

const log = createLogger("channel:webchat");

/**
 * WebChat channel is a virtual channel that works through the Gateway WebSocket.
 * Messages are routed from the WS handler → ChannelManager → Agent → WS response.
 */
export class WebChatChannel implements Channel {
  readonly type = "webchat";
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;

  async start(): Promise<void> {
    log.info("WebChat channel ready (messages flow via Gateway WebSocket)");
  }

  async stop(): Promise<void> {
    // nothing to clean up
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(_message: OutgoingMessage): Promise<void> {
    // WebChat responses go directly via the WebSocket connection, not through this method
  }

  /**
   * Inject a message from the WebSocket handler into the channel pipeline.
   */
  async injectMessage(peerId: string, content: string): Promise<void> {
    if (!this.handler) return;
    await this.handler({
      channelType: "webchat",
      channelId: "webchat",
      peerId,
      content,
      timestamp: Date.now(),
    });
  }
}
