/**
 * MessageQueue — data hub for the Channel Adapter.
 *
 * Two async queues decouple message ingestion from delivery:
 *   inbound:  external channel → agent (produced by Channel, consumed by GatewayAdapter)
 *   outbound: agent → external channel (produced by GatewayAdapter, consumed by ChannelManager)
 */
import { createLogger } from "../logger";
import type { InboundMessage, OutboundMessage } from "../types";

const log = createLogger("channel:mq");

export class MessageQueue {
  private inboundBuffer: InboundMessage[] = [];
  private outboundBuffer: OutboundMessage[] = [];
  private inboundWaiters: Array<(msg: InboundMessage | null) => void> = [];
  private outboundWaiters: Array<(msg: OutboundMessage | null) => void> = [];
  private _stopped = false;

  publishInbound(msg: InboundMessage): void {
    if (this._stopped) return;
    log.debug("Inbound published", { channel: msg.channelType, peer: msg.peerId });
    if (this.inboundWaiters.length > 0) {
      this.inboundWaiters.shift()!(msg);
    } else {
      this.inboundBuffer.push(msg);
    }
  }

  publishOutbound(msg: OutboundMessage): void {
    if (this._stopped) return;
    log.debug("Outbound published", { channel: msg.channelType, peer: msg.peerId });
    if (this.outboundWaiters.length > 0) {
      this.outboundWaiters.shift()!(msg);
    } else {
      this.outboundBuffer.push(msg);
    }
  }

  consumeInbound(): Promise<InboundMessage | null> {
    if (this._stopped) return Promise.resolve(null);
    if (this.inboundBuffer.length > 0) {
      return Promise.resolve(this.inboundBuffer.shift()!);
    }
    return new Promise((resolve) => {
      this.inboundWaiters.push(resolve);
    });
  }

  consumeOutbound(): Promise<OutboundMessage | null> {
    if (this._stopped) return Promise.resolve(null);
    if (this.outboundBuffer.length > 0) {
      return Promise.resolve(this.outboundBuffer.shift()!);
    }
    return new Promise((resolve) => {
      this.outboundWaiters.push(resolve);
    });
  }

  stop(): void {
    this._stopped = true;
    for (const resolve of this.inboundWaiters) resolve(null);
    for (const resolve of this.outboundWaiters) resolve(null);
    this.inboundWaiters = [];
    this.outboundWaiters = [];
    log.info("MessageQueue stopped");
  }

  get inboundSize(): number {
    return this.inboundBuffer.length;
  }

  get outboundSize(): number {
    return this.outboundBuffer.length;
  }
}

let _mq: MessageQueue | null = null;

export function getMessageQueue(): MessageQueue {
  if (!_mq) _mq = new MessageQueue();
  return _mq;
}
