import type { Channel } from "./base";
import type { IncomingMessage } from "../types";
import { createLogger } from "../logger";

const log = createLogger("channels");

export class ChannelManager {
  private channels = new Map<string, Channel>();
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;

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
}
