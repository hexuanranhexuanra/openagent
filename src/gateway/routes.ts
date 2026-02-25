import { Hono } from "hono";
import { nanoid } from "nanoid";
import { listSessions, resetSession } from "../sessions/manager";
import { getAllToolDefinitions } from "../agent/tools/registry";
import { runAgent } from "../agent";
import { enqueueMessage } from "../queue";
import { createFeishuRoutes } from "../channels/feishu";
import { auditLog } from "../audit";
import { getConfig } from "../config";
import { buildConfigSchemaBundle } from "../config/json-schema";
import { getMemoryStore } from "../evolution/memory";
import { getSkillLoader } from "../evolution/skill-loader";

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

  const config = getConfig();
  const feishuCfg = config.channels.feishu;
  const feishuRoutes = createFeishuRoutes({
    encryptKey: feishuCfg.encryptKey || process.env.LARK_ENCRYPT_KEY,
    verificationToken: feishuCfg.verificationToken || process.env.LARK_VERIFICATION_TOKEN,
    appId: feishuCfg.appId || process.env.LARK_APP_ID,
    appSecret: feishuCfg.appSecret || process.env.LARK_APP_SECRET,
    replyMode: (process.env.FEISHU_REPLY_MODE as "sync" | "async") ?? "async",
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

  // ─── Config Schema (drives the dynamic config UI) ───

  api.get("/config/schema", (c) => {
    const bundle = buildConfigSchemaBundle();
    return c.json(bundle);
  });

  // ─── Config Management ───

  api.get("/config", (c) => {
    const config = getConfig();
    // Mask API keys for security
    const masked = JSON.parse(JSON.stringify(config));
    if (masked.providers?.openai?.apiKey) {
      const key = masked.providers.openai.apiKey;
      masked.providers.openai.apiKey = key.length > 8 ? key.slice(0, 8) + "..." : "***";
    }
    if (masked.providers?.anthropic?.apiKey) {
      const key = masked.providers.anthropic.apiKey;
      masked.providers.anthropic.apiKey = key.length > 8 ? key.slice(0, 8) + "..." : "***";
    }
    if (masked.gateway?.authToken) {
      masked.gateway.authToken = "***";
    }
    if (masked.channels?.feishu?.appSecret) {
      masked.channels.feishu.appSecret = "***";
    }
    if (masked.channels?.feishu?.encryptKey) {
      masked.channels.feishu.encryptKey = "***";
    }
    if (masked.channels?.telegram?.botToken) {
      masked.channels.telegram.botToken = "***";
    }
    return c.json(masked);
  });

  api.put("/config", async (c) => {
    const body = await c.req.json();
    const { resolve } = await import("node:path");
    const configPath = resolve(process.cwd(), "openagent.json");

    // Load existing file config, merge with updates
    let existing: Record<string, unknown> = {};
    const { existsSync } = await import("node:fs");
    if (existsSync(configPath)) {
      const text = await Bun.file(configPath).text();
      try { existing = JSON.parse(text); } catch { /* use empty */ }
    }

    const merged = deepMerge(existing, body);
    await Bun.write(configPath, JSON.stringify(merged, null, 2));

    return c.json({ ok: true, message: "Config saved. Restart gateway to apply changes." });
  });

  // ─── Memory Management ───

  api.get("/memory/:file", async (c) => {
    const file = c.req.param("file").toUpperCase() as "SOUL" | "USER" | "WORLD";
    if (!["SOUL", "USER", "WORLD"].includes(file)) {
      return c.json({ error: "Invalid memory file. Use: SOUL, USER, WORLD" }, 400);
    }
    const memory = getMemoryStore();
    const content = await memory.read(file);
    return c.json({ file, content });
  });

  api.get("/memory", async (c) => {
    const memory = getMemoryStore();
    const all = await memory.readAll();
    return c.json(all);
  });

  // ─── Skills ───

  api.get("/skills", (c) => {
    const loader = getSkillLoader();
    return c.json({
      files: loader.listSkillFiles(),
      loaded: loader.getLoaded().map((h) => ({
        name: h.definition.name,
        description: h.definition.description,
      })),
    });
  });

  return api;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      result[key] = sv;
    }
  }
  return result;
}
