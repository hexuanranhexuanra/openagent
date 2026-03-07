import type { Channel } from "./base";
import type { IncomingMessage } from "../types";
import type { MessageQueue } from "./message-queue";
import { createLogger } from "../logger";

const log = createLogger("channels");

export class ChannelManager {
  private channels = new Map<string, Channel>();
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private dispatchRunning = false;

  register(channel: Channel): void {
    this.channels.set(channel.type, channel);
    channel.onMessage(async (msg) => {
      if (this.messageHandler) {
        await this.messageHandler(msg);
      }
    });
    log.info("Channel registered", { type: channel.type });
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async startAll(): Promise<void> {
    for (const [type, channel] of this.channels) {
      try {
        await channel.start();
        log.info("Channel started", { type });
      } catch (err) {
        log.error("Channel failed to start", {
          type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async stopAll(): Promise<void> {
    this.dispatchRunning = false;
    for (const [type, channel] of this.channels) {
      try {
        await channel.stop();
        log.info("Channel stopped", { type });
      } catch (err) {
        log.error("Channel failed to stop", {
          type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  getChannel(type: string): Channel | undefined {
    return this.channels.get(type);
  }

  /**
   * Start the outbound dispatch loop.
   * Reads OutboundMessages from the queue and routes each to the correct Channel.send().
   * Non-blocking — runs as a background async loop.
   */
  startOutboundDispatch(queue: MessageQueue): void {
    this.dispatchRunning = true;
    this.runOutboundLoop(queue).catch((err) => {
      log.error("Outbound dispatch loop crashed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    log.info("Outbound dispatch started");
  }

  private async runOutboundLoop(queue: MessageQueue): Promise<void> {
    while (this.dispatchRunning) {
      const msg = await queue.consumeOutbound();
      if (!msg) break; // queue stopped

      const channel = this.channels.get(msg.channelType);
      if (!channel) {
        log.warn("No channel registered for outbound, dropping", {
          channelType: msg.channelType,
          peerId: msg.peerId,
        });
        continue;
      }

      try {
        await channel.send(msg);
      } catch (err) {
        log.error("Channel send failed", {
          channelType: msg.channelType,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log.info("Outbound dispatch loop exited");
  }
}
