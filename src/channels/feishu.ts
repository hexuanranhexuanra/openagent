import { Hono } from "hono";
import { nanoid } from "nanoid";
import { createLogger } from "../logger";
import { verifyLarkSignature } from "../middleware/auth";
import { idempotencyStore } from "../middleware/idempotency";
import { enqueueMessage } from "../queue";
import { auditLog } from "../audit";

const log = createLogger("channel:feishu");

interface FeishuConfig {
  encryptKey?: string;
  verificationToken?: string;
}

/**
 * Create Hono sub-routes for Feishu/Lark event webhook.
 *
 * Supports:
 * - URL verification challenge
 * - Message events (im.message.receive_v1)
 * - Event signature verification
 * - Idempotent event dedup
 */
export function createFeishuRoutes(config: FeishuConfig): Hono {
  const feishu = new Hono();

  feishu.post(
    "/webhook",
    verifyLarkSignature(config.encryptKey),
    async (c) => {
      let body: Record<string, unknown>;
      try {
        const rawBody = c.get("rawBody") as string | undefined;
        body = rawBody ? JSON.parse(rawBody) : await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }

      // ─── URL Verification Challenge ───
      if (body.type === "url_verification") {
        log.info("Feishu URL verification challenge received");
        return c.json({ challenge: body.challenge });
      }

      // ─── Event Processing ───
      const header = body.header as Record<string, unknown> | undefined;
      if (!header?.event_id) {
        return c.json({ error: "Missing event header" }, 400);
      }

      const eventId = header.event_id as string;
      const eventType = header.event_type as string;

      // Idempotency check
      if (idempotencyStore.isDuplicate(`feishu:${eventId}`)) {
        return c.json({ message: "Event already processed" }, 200);
      }

      log.info("Feishu event received", { eventId, eventType });

      // ─── Handle message events ───
      if (eventType === "im.message.receive_v1") {
        const event = body.event as Record<string, unknown>;
        const message = event?.message as Record<string, unknown>;
        const sender = event?.sender as Record<string, unknown>;

        if (!message || !sender) {
          return c.json({ error: "Malformed message event" }, 400);
        }

        const messageType = message.message_type as string;
        const senderId = (sender.sender_id as Record<string, unknown>)?.open_id as string ?? "unknown";

        // Only process text messages for now
        if (messageType !== "text") {
          log.debug("Skipping non-text message", { messageType });
          return c.json({ message: "Ignored non-text message" }, 200);
        }

        let textContent = "";
        try {
          const contentObj = JSON.parse(message.content as string);
          textContent = contentObj.text as string;
        } catch {
          textContent = (message.content as string) ?? "";
        }

        const taskId = `feishu-${eventId}-${nanoid(6)}`;

        auditLog({
          taskId,
          action: "message_received",
          who: senderId,
          channel: "feishu",
          detail: { eventId, messageType, textLength: textContent.length },
        });

        // Enqueue for async processing
        await enqueueMessage({
          taskId,
          channel: "feishu",
          peerId: senderId,
          content: textContent,
          priority: "high",
          createdAt: Date.now(),
        });

        return c.json({ message: "Event received", taskId }, 200);
      }

      log.debug("Unhandled event type", { eventType });
      return c.json({ message: "Event type not handled" }, 200);
    },
  );

  return feishu;
}
