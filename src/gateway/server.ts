import { Hono } from "hono";
import { cors } from "hono/cors";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { createApiRoutes } from "./routes";
import { handleWsOpen, handleWsMessage, handleWsClose } from "./websocket";
import { bearerAuth } from "../middleware/auth";
import { createLogger } from "../logger";
import { getConfig } from "../config";
import { getAppHtml } from "./app-ui";

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

  // Auth for API routes (skip webhook endpoints which have their own auth)
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/webhook/")) {
      await next();
      return;
    }
    return bearerAuth(config.gateway.authToken)(c, next);
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

  // ─── Unified SPA ───
  const appHtml = getAppHtml();
  app.get("/", (c) => c.html(appHtml));
  app.get("/config", (c) => c.redirect("/#settings"));

  return { app, websocket };
}

export function startGateway() {
  const config = getConfig();
  const { app, websocket } = createGateway();

  // Wrap websocket handlers with guards: Bun's WS handler is global,
  // so connections not upgraded via Hono's /ws route lack ws.data.events
  const safeWebsocket = {
    ...websocket,
    open(ws: ServerWebSocket) {
      if ((ws.data as Record<string, unknown>)?.events) websocket.open?.(ws);
    },
    message(ws: ServerWebSocket, message: string | Buffer) {
      if ((ws.data as Record<string, unknown>)?.events) websocket.message(ws, message);
      else ws.close(1008, "Invalid connection");
    },
    close(ws: ServerWebSocket, code: number, reason: string) {
      if ((ws.data as Record<string, unknown>)?.events) websocket.close?.(ws, code, reason);
    },
  };

  const server = Bun.serve({
    fetch: app.fetch,
    websocket: safeWebsocket,
    port: config.gateway.port,
    hostname: config.gateway.host,
  });

  log.info("Gateway started", {
    url: `http://${config.gateway.host}:${config.gateway.port}`,
    ws: `ws://${config.gateway.host}:${config.gateway.port}/ws`,
  });

  return server;
}
