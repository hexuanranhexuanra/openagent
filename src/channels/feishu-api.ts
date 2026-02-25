import { createLogger } from "../logger";

const log = createLogger("feishu:api");

const FEISHU_BASE = "https://open.feishu.cn/open-apis";

interface TenantToken {
  token: string;
  expiresAt: number;
}

let cachedToken: TenantToken | null = null;

/**
 * Get a Feishu tenant_access_token.
 * Tokens are cached and auto-refreshed 5 minutes before expiry.
 */
export async function getTenantToken(appId: string, appSecret: string): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 300_000) {
    return cachedToken.token;
  }

  const res = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });

  const data = await res.json() as {
    code: number;
    msg: string;
    tenant_access_token: string;
    expire: number;
  };

  if (data.code !== 0) {
    log.error("Failed to get tenant token", { code: data.code, msg: data.msg });
    throw new Error(`Feishu token error: ${data.msg}`);
  }

  cachedToken = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + data.expire * 1000,
  };

  log.info("Tenant token refreshed", { expiresIn: data.expire });
  return cachedToken.token;
}

/**
 * Send a text message to a Feishu user/chat.
 */
export async function sendFeishuMessage(
  token: string,
  receiveId: string,
  text: string,
  receiveIdType: "open_id" | "chat_id" = "open_id",
): Promise<{ messageId: string } | null> {
  const content = JSON.stringify({ text });

  const res = await fetch(
    `${FEISHU_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: "text",
        content,
      }),
    },
  );

  const data = await res.json() as {
    code: number;
    msg: string;
    data?: { message_id: string };
  };

  if (data.code !== 0) {
    log.error("Failed to send message", { code: data.code, msg: data.msg, receiveId });
    return null;
  }

  log.debug("Message sent", { messageId: data.data?.message_id, receiveId });
  return { messageId: data.data?.message_id ?? "" };
}

/**
 * Reply to a specific Feishu message.
 */
export async function replyFeishuMessage(
  token: string,
  messageId: string,
  text: string,
): Promise<{ messageId: string } | null> {
  const content = JSON.stringify({ text });

  const res = await fetch(
    `${FEISHU_BASE}/im/v1/messages/${messageId}/reply`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        msg_type: "text",
        content,
      }),
    },
  );

  const data = await res.json() as {
    code: number;
    msg: string;
    data?: { message_id: string };
  };

  if (data.code !== 0) {
    log.error("Failed to reply", { code: data.code, msg: data.msg, messageId });
    return null;
  }

  log.debug("Reply sent", { originalMessageId: messageId, replyId: data.data?.message_id });
  return { messageId: data.data?.message_id ?? "" };
}

/**
 * Send a Feishu interactive card message (rich formatting).
 */
export async function sendFeishuCard(
  token: string,
  receiveId: string,
  title: string,
  content: string,
  receiveIdType: "open_id" | "chat_id" = "open_id",
): Promise<{ messageId: string } | null> {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: title },
      template: "blue",
    },
    elements: [
      {
        tag: "markdown",
        content,
      },
    ],
  };

  const res = await fetch(
    `${FEISHU_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    },
  );

  const data = await res.json() as { code: number; msg: string; data?: { message_id: string } };

  if (data.code !== 0) {
    log.error("Failed to send card", { code: data.code, msg: data.msg });
    return null;
  }

  return { messageId: data.data?.message_id ?? "" };
}

/**
 * High-level helper: get token and send reply, handling token refresh.
 */
export async function feishuReply(
  appId: string,
  appSecret: string,
  opts: {
    messageId?: string;
    receiveId?: string;
    text: string;
    useCard?: boolean;
  },
): Promise<boolean> {
  try {
    const token = await getTenantToken(appId, appSecret);

    // Prefer replying to the original message
    if (opts.messageId) {
      const result = await replyFeishuMessage(token, opts.messageId, opts.text);
      return !!result;
    }

    // Fallback: send a new message to the user
    if (opts.receiveId) {
      if (opts.useCard) {
        const result = await sendFeishuCard(token, opts.receiveId, "OpenAgent", opts.text);
        return !!result;
      }
      const result = await sendFeishuMessage(token, opts.receiveId, opts.text);
      return !!result;
    }

    log.warn("feishuReply called without messageId or receiveId");
    return false;
  } catch (err) {
    log.error("feishuReply failed", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
