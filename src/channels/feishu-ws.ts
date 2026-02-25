/**
 * Feishu WebSocket long connection monitor.
 *
 * Uses @larksuiteoapi/node-sdk WSClient to establish an outbound connection
 * to Feishu's servers. This eliminates the need for a public webhook URL,
 * ngrok tunnel, or any reverse proxy — only App ID + App Secret are needed.
 *
 * Inspired by OpenClaw's extensions/feishu implementation.
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { createLogger } from "../logger";
import { runAgent } from "../agent";

const log = createLogger("channel:feishu-ws");

let wsClient: Lark.WSClient | null = null;
let larkClient: Lark.Client | null = null;
let abortController: AbortController | null = null;

export interface FeishuWSConfig {
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

function resolveDomain(domain?: "feishu" | "lark"): Lark.Domain {
  return domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

/**
 * Reply to a Feishu message using the official SDK.
 */
async function replyMessage(messageId: string, text: string): Promise<void> {
  if (!larkClient) {
    log.error("Lark client not initialized, cannot reply");
    return;
  }
  try {
    await larkClient.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    log.debug("Reply sent", { messageId });
  } catch (err) {
    log.error("Failed to reply", {
      messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Handle an incoming message event from Feishu.
 */
async function handleMessage(event: FeishuMessageEvent): Promise<void> {
  const senderId = event.sender.sender_id.open_id;
  const messageId = event.message.message_id;
  const messageType = event.message.message_type;
  const chatType = event.message.chat_type;

  if (messageType !== "text") {
    log.debug("Skipping non-text message", { messageType, messageId });
    return;
  }

  let textContent = "";
  try {
    const parsed = JSON.parse(event.message.content) as { text?: string };
    textContent = parsed.text ?? "";
  } catch {
    textContent = event.message.content ?? "";
  }

  // Strip @bot mentions (format: @_user_x)
  textContent = textContent.replace(/@_user_\d+\s*/g, "").trim();
  if (!textContent) {
    log.debug("Empty message after mention strip", { messageId });
    return;
  }

  log.info("Message received", {
    from: senderId,
    chatType,
    messageId,
    textLength: textContent.length,
  });

  try {
    let fullResponse = "";
    const stream = runAgent("feishu", senderId, textContent);
    for await (const evt of stream) {
      if (evt.type === "text") fullResponse += evt.content ?? "";
      if (evt.type === "error") {
        log.error("Agent error", { error: evt.error, messageId });
        fullResponse = `Error: ${evt.error}`;
        break;
      }
    }

    if (fullResponse) {
      await replyMessage(messageId, fullResponse);
    }
  } catch (err) {
    log.error("Failed to handle message", {
      messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the Feishu WebSocket long connection.
 * Only requires appId + appSecret. No webhook URL, no tunnel, no public IP.
 */
export function startFeishuWS(config: FeishuWSConfig): void {
  const { appId, appSecret, domain } = config;

  if (!appId || !appSecret) {
    log.warn("Feishu credentials not configured, skipping WebSocket connection");
    return;
  }

  // Create the API client (for sending replies)
  larkClient = new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: resolveDomain(domain),
  });

  // Create event dispatcher with handlers
  const eventDispatcher = new Lark.EventDispatcher({});

  eventDispatcher.register({
    "im.message.receive_v1": async (data) => {
      try {
        const event = data as unknown as FeishuMessageEvent;
        await handleMessage(event);
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

  // Create WebSocket client and connect
  wsClient = new Lark.WSClient({
    appId,
    appSecret,
    domain: resolveDomain(domain),
    loggerLevel: Lark.LoggerLevel.info,
  });

  abortController = new AbortController();

  try {
    wsClient.start({ eventDispatcher });
    log.info("Feishu WebSocket connected", { appId: appId.slice(0, 8) + "..." });
  } catch (err) {
    log.error("Failed to start Feishu WebSocket", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Stop the Feishu WebSocket connection.
 */
export function stopFeishuWS(): void {
  abortController?.abort();
  wsClient = null;
  larkClient = null;
  abortController = null;
  log.info("Feishu WebSocket stopped");
}
