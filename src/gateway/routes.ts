import { Hono } from "hono";
import { nanoid } from "nanoid";
import { listSessions, resetSession } from "../sessions/manager";
import { getAllToolDefinitions } from "../agent/tools/registry";
import { runAgent } from "../agent";
import { enqueueMessage } from "../queue";
import { createFeishuRoutes } from "../channels/feishu";
import { auditLog } from "../audit";

export function createApiRoutes(): Hono {
  const api = new Hono();

  // ─── Health & Status ───

  api.get("/health", (c) => {
    return c.json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  api.get("/status", (c) => {
    return c.json({
      version: "0.2.0",
      runtime: "bun",
      pid: process.pid,
      memoryMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    });
  });

  // ─── Session Management ───

  api.get("/sessions", (c) => {
    const sessions = listSessions().map((s) => ({
      id: s.id,
      channel: s.channel,
      peerId: s.peerId,
      messageCount: s.messages.length,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
    return c.json({ sessions });
  });

  api.post("/sessions/:id/reset", (c) => {
    const id = c.req.param("id");
    resetSession(id);
    return c.json({ ok: true, sessionId: id });
  });

  // ─── Tool Listing ───

  api.get("/tools", (c) => {
    return c.json({ tools: getAllToolDefinitions() });
  });

  // ─── Sync Chat (low-latency direct path) ───

  api.post("/chat", async (c) => {
    const body = await c.req.json<{ message: string; peerId?: string }>();
    if (!body.message) {
      return c.json({ error: "Missing 'message' field" }, 400);
    }

    const peerId = body.peerId ?? "api-user";
    const taskId = `api-${nanoid(10)}`;
    let fullResponse = "";

    auditLog({
      taskId,
      action: "sync_chat",
      who: peerId,
      channel: "api",
      detail: { messageLength: body.message.length },
    });

    const stream = runAgent("api", peerId, body.message);
    for await (const event of stream) {
      if (event.type === "text") {
        fullResponse += event.content ?? "";
      }
      if (event.type === "error") {
        return c.json({ error: event.error, taskId }, 500);
      }
    }

    return c.json({ response: fullResponse, taskId });
  });

  // ─── Async Chat (enqueue for Worker processing) ───

  api.post("/chat/async", async (c) => {
    const body = await c.req.json<{ message: string; peerId?: string; channel?: string }>();
    if (!body.message) {
      return c.json({ error: "Missing 'message' field" }, 400);
    }

    const peerId = body.peerId ?? "api-user";
    const channel = body.channel ?? "api";
    const taskId = `async-${nanoid(10)}`;

    auditLog({
      taskId,
      action: "async_chat_enqueued",
      who: peerId,
      channel,
      detail: { messageLength: body.message.length },
    });

    await enqueueMessage({
      taskId,
      channel,
      peerId,
      content: body.message,
      priority: "default",
      createdAt: Date.now(),
    });

    return c.json({ taskId, status: "queued" }, 202);
  });

  // ─── Feishu/Lark Webhook ───

  const feishuRoutes = createFeishuRoutes({
    encryptKey: process.env.LARK_ENCRYPT_KEY,
    verificationToken: process.env.LARK_VERIFICATION_TOKEN,
  });
  api.route("/webhook/feishu", feishuRoutes);

  // ─── Generic Webhook (for other integrations) ───

  api.post("/webhook/generic", async (c) => {
    const body = await c.req.json<{ source: string; peerId: string; message: string }>();
    if (!body.source || !body.message) {
      return c.json({ error: "Missing 'source' or 'message'" }, 400);
    }

    const taskId = `webhook-${nanoid(10)}`;

    await enqueueMessage({
      taskId,
      channel: body.source,
      peerId: body.peerId ?? "webhook-user",
      content: body.message,
      priority: "default",
      createdAt: Date.now(),
    });

    return c.json({ taskId, status: "queued" }, 202);
  });

  return api;
}
