import { Hono } from "hono";
import { listSessions, resetSession } from "../sessions/manager";
import { getAllToolDefinitions } from "../agent/tools/registry";

export function createApiRoutes(): Hono {
  const api = new Hono();

  api.get("/health", (c) => {
    return c.json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

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

  api.get("/tools", (c) => {
    return c.json({ tools: getAllToolDefinitions() });
  });

  api.get("/status", (c) => {
    return c.json({
      version: "0.1.0",
      runtime: "bun",
      pid: process.pid,
      memoryMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    });
  });

  return api;
}
