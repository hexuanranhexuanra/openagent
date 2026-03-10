/**
 * FeishuChannel — Feishu/Lark channel adapter using WebSocket long connection.
 *
 * Implements the Channel interface:
 *   start()     → establishes WS connection to Feishu servers (no public URL needed)
 *   stop()      → tears down the connection
 *   onMessage() → registers the inbound handler (called by ChannelManager)
 *   send()      → delivers an outbound message via the Lark SDK
 *
 * When a message arrives, it publishes an IncomingMessage to the handler
 * (which ChannelManager routes into the inbound MessageQueue).
 * When the agent responds, ChannelManager calls send() with the OutboundMessage.
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { createLogger } from "../logger";
import type { Channel } from "./base";
import type { IncomingMessage, OutgoingMessage } from "../types";

const log = createLogger("channel:feishu");

export interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  /** "feishu" (default) or "lark" for international */
  domain?: "feishu" | "lark";
}

interface FeishuMessageEvent {
  sender: {
    sender_id: { open_id: string; user_id?: string };
    sender_type?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{ key: string; id: { open_id: string }; name: string }>;
  };
}

export class FeishuChannel implements Channel {
  readonly type = "feishu";

  private config: FeishuChannelConfig;
  private wsClient: Lark.WSClient | null = null;
  private larkClient: Lark.Client | null = null;
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private _started = false;

  constructor(config: FeishuChannelConfig) {
    this.config = config;
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this._started) return;

    const { appId, appSecret } = this.config;
    const larkDomain = this.config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;

    this.larkClient = new Lark.Client({
      appId,
      appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: larkDomain,
    });

    // Validate credentials before attempting WebSocket connection (like openclaw's probeFeishu)
    const probeResult = await this.probeCredentials();
    if (!probeResult.ok) {
      log.error("Feishu credential validation failed — WebSocket will NOT connect", {
        appId: appId.slice(0, 8) + "...",
        error: probeResult.error,
      });
      throw new Error(`Feishu credential validation failed: ${probeResult.error}`);
    }
    log.info("Feishu credentials validated", {
      appId: appId.slice(0, 8) + "...",
      botName: probeResult.botName,
      botOpenId: probeResult.botOpenId,
    });

    const eventDispatcher = new Lark.EventDispatcher({});
    eventDispatcher.register({
      "im.message.receive_v1": async (data) => {
        try {
          await this.handleIncoming(data as unknown as FeishuMessageEvent);
        } catch (err) {
          log.error("Error in message handler", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
      "im.chat.member.bot.added_v1": async (data) => {
        const event = data as unknown as { chat_id?: string };
        log.info("Bot added to chat", { chatId: event.chat_id });
      },
      "im.chat.member.bot.deleted_v1": async (data) => {
        const event = data as unknown as { chat_id?: string };
        log.info("Bot removed from chat", { chatId: event.chat_id });
      },
    });

    this.wsClient = new Lark.WSClient({
      appId,
      appSecret,
      domain: larkDomain,
      loggerLevel: Lark.LoggerLevel.info,
    });

    try {
      this.wsClient.start({ eventDispatcher });
    } catch (err) {
      log.error("Feishu WebSocket start() threw", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    this._started = true;
    log.info("FeishuChannel started (WS mode)", { appId: appId.slice(0, 8) + "..." });
  }

  /**
   * Validate appId/appSecret by calling the Feishu bot info API.
   * Equivalent to openclaw's probeFeishu().
   */
  private async probeCredentials(): Promise<{
    ok: boolean;
    error?: string;
    botName?: string;
    botOpenId?: string;
  }> {
    if (!this.larkClient) {
      return { ok: false, error: "Lark client not initialized" };
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (this.larkClient as any).request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
        data: {},
      });
      if (response.code !== 0) {
        return {
          ok: false,
          error: `API error: ${response.msg || `code ${response.code}`}`,
        };
      }
      const bot = response.bot || response.data?.bot;
      return {
        ok: true,
        botName: bot?.bot_name,
        botOpenId: bot?.open_id,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async stop(): Promise<void> {
    // WSClient doesn't expose a stop() in the SDK; nulling refs is sufficient
    this.wsClient = null;
    this.larkClient = null;
    log.info("FeishuChannel stopped");
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.larkClient) {
      log.error("Lark client not initialized, cannot send");
      return;
    }

    try {
      if (message.replyToId) {
        // Thread reply to the original message
        await this.larkClient.im.message.reply({
          path: { message_id: message.replyToId },
          data: {
            msg_type: "text",
            content: JSON.stringify({ text: message.content }),
          },
        });
      } else {
        // Direct message to the user
        await this.larkClient.im.message.create({
          params: { receive_id_type: "open_id" },
          data: {
            receive_id: message.peerId,
            msg_type: "text",
            content: JSON.stringify({ text: message.content }),
          },
        });
      }
      log.debug("Message sent", { peerId: message.peerId, replyToId: message.replyToId });
    } catch (err) {
      log.error("Failed to send message", {
        error: err instanceof Error ? err.message : String(err),
        peerId: message.peerId,
      });
    }
  }

  private async handleIncoming(event: FeishuMessageEvent): Promise<void> {
    if (!this.handler) {
      log.warn("No message handler registered, dropping message");
      return;
    }

    const { message, sender } = event;

    if (message.message_type !== "text") {
      log.debug("Skipping non-text message", { messageType: message.message_type });
      return;
    }

    let textContent = "";
    try {
      const parsed = JSON.parse(message.content) as { text?: string };
      textContent = parsed.text ?? "";
    } catch {
      textContent = message.content ?? "";
    }

    // Strip @bot mention prefix
    textContent = textContent.replace(/@_user_\d+\s*/g, "").trim();
    if (!textContent) {
      log.debug("Empty after mention strip", { messageId: message.message_id });
      return;
    }

    const peerId = sender.sender_id.open_id;
    log.info("Message received", {
      peerId,
      chatType: message.chat_type,
      messageId: message.message_id,
      textLength: textContent.length,
    });

    await this.handler({
      channelType: "feishu",
      channelId: message.chat_id,
      peerId,
      content: textContent,
      timestamp: Date.now(),
      // Pass messageId through raw so GatewayAdapter can set replyToId on OutboundMessage
      raw: { messageId: message.message_id, chatId: message.chat_id },
    });
  }
}
