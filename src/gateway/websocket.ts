import type { ServerWebSocket } from "bun";
import { nanoid } from "nanoid";
import { createLogger } from "../logger";
import { runAgent, type AgentStreamEvent } from "../agent";

const log = createLogger("gateway:ws");

interface WSClientData {
  id: string;
  peerId: string;
}

const clients = new Map<string, ServerWebSocket<WSClientData>>();

export function handleWsOpen(ws: ServerWebSocket<WSClientData>): void {
  const clientId = nanoid(12);
  ws.data = { id: clientId, peerId: `webchat:${clientId}` };
  clients.set(clientId, ws);
  log.info("WebSocket connected", { clientId });

  ws.send(JSON.stringify({
    type: "event",
    event: "connected",
    payload: { clientId, peerId: ws.data.peerId },
  }));
}

export async function handleWsMessage(
  ws: ServerWebSocket<WSClientData>,
  message: string | Buffer,
): Promise<void> {
  const text = typeof message === "string" ? message : message.toString();
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(text);
  } catch {
    ws.send(JSON.stringify({ type: "res", ok: false, error: "Invalid JSON" }));
    return;
  }

  const msgType = parsed.type as string;
  const msgId = parsed.id as string | undefined;

  if (msgType === "req") {
    await handleRequest(ws, msgId ?? "", parsed.method as string, parsed.params as Record<string, unknown> ?? {});
  } else if (msgType === "event" && parsed.event === "ping") {
    ws.send(JSON.stringify({ type: "event", event: "pong", payload: {} }));
  }
}

async function handleRequest(
  ws: ServerWebSocket<WSClientData>,
  id: string,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  switch (method) {
    case "chat": {
      const content = params.message as string;
      if (!content) {
        ws.send(JSON.stringify({ type: "res", id, ok: false, error: "Missing 'message' param" }));
        return;
      }

      ws.send(JSON.stringify({ type: "res", id, ok: true, payload: { status: "streaming" } }));

      const peerId = ws.data.peerId;
      try {
        const stream = runAgent("webchat", peerId, content);
        for await (const event of stream) {
          sendStreamEvent(ws, event);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error("Agent error in WS", { error: errMsg });
        ws.send(JSON.stringify({
          type: "event",
          event: "agent_error",
          payload: { error: errMsg },
        }));
      }
      break;
    }

    case "status": {
      ws.send(JSON.stringify({
        type: "res",
        id,
        ok: true,
        payload: {
          uptime: process.uptime(),
          memoryMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
          clients: clients.size,
        },
      }));
      break;
    }

    case "reset": {
      const { resetSession } = await import("../sessions/manager");
      resetSession(`webchat:${ws.data.peerId}`);
      ws.send(JSON.stringify({ type: "res", id, ok: true, payload: { reset: true } }));
      break;
    }

    default:
      ws.send(JSON.stringify({ type: "res", id, ok: false, error: `Unknown method: ${method}` }));
  }
}

function sendStreamEvent(ws: ServerWebSocket<WSClientData>, event: AgentStreamEvent): void {
  try {
    ws.send(JSON.stringify({ type: "event", event: `agent_${event.type}`, payload: event }));
  } catch {
    // client disconnected
  }
}

export function handleWsClose(ws: ServerWebSocket<WSClientData>): void {
  if (ws.data?.id) {
    clients.delete(ws.data.id);
    log.info("WebSocket disconnected", { clientId: ws.data.id });
  }
}

export function broadcastEvent(event: string, payload: Record<string, unknown>): void {
  const msg = JSON.stringify({ type: "event", event, payload });
  for (const ws of clients.values()) {
    try {
      ws.send(msg);
    } catch {
      // skip failed sends
    }
  }
}
