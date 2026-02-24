import type { IncomingMessage, OutgoingMessage } from "../types";

export interface Channel {
  readonly type: string;

  start(): Promise<void>;
  stop(): Promise<void>;

  send(message: OutgoingMessage): Promise<void>;

  onMessage(handler: (message: IncomingMessage) => Promise<void>): void;
}
