import { Hono } from "hono";
import { cors } from "hono/cors";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { createApiRoutes } from "./routes";
import { handleWsOpen, handleWsMessage, handleWsClose } from "./websocket";
import { createLogger } from "../logger";
import { getConfig } from "../config";
import { getWebChatHtml } from "./webchat-ui";

const log = createLogger("gateway");

interface WSData {
  id: string;
  peerId: string;
}

export function createGateway() {
  const config = getConfig();
  const app = new Hono();
  const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

  // ─── Middleware ───
  app.use("*", cors());

  app.use("*", async (c, next) => {
    const authToken = config.gateway.authToken;
    if (authToken && c.req.path.startsWith("/api/")) {
      const token = c.req.header("Authorization")?.replace("Bearer ", "");
      if (token !== authToken) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }
    await next();
  });

  // ─── API Routes ───
  const api = createApiRoutes();
  app.route("/api", api);

  // ─── WebSocket ───
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        handleWsOpen(ws.raw as ServerWebSocket<WSData>);
      },
      onMessage(event, ws) {
        handleWsMessage(ws.raw as ServerWebSocket<WSData>, event.data as string);
      },
      onClose(_event, ws) {
        handleWsClose(ws.raw as ServerWebSocket<WSData>);
      },
    })),
  );

  // ─── WebChat UI ───
  app.get("/", (c) => {
    return c.html(getWebChatHtml());
  });

  return { app, websocket };
}

export function startGateway() {
  const config = getConfig();
  const { app, websocket } = createGateway();

  const server = Bun.serve({
    fetch: app.fetch,
    websocket,
    port: config.gateway.port,
    hostname: config.gateway.host,
  });

  log.info("Gateway started", {
    url: `http://${config.gateway.host}:${config.gateway.port}`,
    ws: `ws://${config.gateway.host}:${config.gateway.port}/ws`,
  });

  return server;
}
