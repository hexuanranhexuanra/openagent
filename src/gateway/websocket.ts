import type { ServerWebSocket } from "bun";
import { nanoid } from "nanoid";
import { createLogger } from "../logger";
import { runAgent, cancelAgent, getAgentEngine } from "../agent";
import type { AgentStreamEvent } from "../agent";

const log = createLogger("gateway:ws");

interface WSClientData {
  id: string;
  peerId: string;
}

const clients = new Map<string, ServerWebSocket<WSClientData>>();

// Per-session message queue: buffer incoming messages while an agent task is running.
const sessionQueue = new Map<
  string,
  Array<{ id: string; content: string; ws: ServerWebSocket<WSClientData> }>
>();

export function handleWsOpen(ws: ServerWebSocket<WSClientData>): void {
  const clientId = nanoid(12);
  // Merge into existing ws.data — Hono stores its internal event handlers in ws.data.events.
  // Overwriting would drop `events` and cause every subsequent message to be rejected.
  Object.assign(ws.data as unknown as Record<string, unknown>, {
    id: clientId,
    peerId: `webchat:${clientId}`,
  });
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

      const [channel, ...rest] = ws.data.peerId.split(":");
      const peerId = rest.join(":");
      const sessionKey = ws.data.peerId;

      if (getAgentEngine().isRunning(channel, peerId)) {
        const queue = sessionQueue.get(sessionKey) ?? [];
        queue.push({ id, content, ws });
        sessionQueue.set(sessionKey, queue);
        ws.send(JSON.stringify({
          type: "res",
          id,
          ok: true,
          payload: { status: "queued", position: queue.length },
        }));
        return;
      }

      runChatSession(channel, peerId, sessionKey, id, content, ws);
      break;
    }

    case "cancel": {
      const [channel, ...rest] = ws.data.peerId.split(":");
      const peerId = rest.join(":");
      const cancelled = cancelAgent(channel, peerId);
      ws.send(JSON.stringify({
        type: "res",
        id,
        ok: true,
        payload: { cancelled },
      }));
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
          activeSessions: getAgentEngine().getActiveSessions(),
        },
      }));
      break;
    }

    case "reset": {
      const { resetSession } = await import("../sessions/manager");
      resetSession(ws.data.peerId);
      ws.send(JSON.stringify({ type: "res", id, ok: true, payload: { reset: true } }));
      break;
    }

    default:
      ws.send(JSON.stringify({ type: "res", id, ok: false, error: `Unknown method: ${method}` }));
  }
}

function runChatSession(
  channel: string,
  peerId: string,
  sessionKey: string,
  id: string,
  content: string,
  ws: ServerWebSocket<WSClientData>,
): void {
  ws.send(JSON.stringify({ type: "res", id, ok: true, payload: { status: "streaming" } }));

  (async () => {
    try {
      const stream = runAgent(channel, peerId, content);
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
    } finally {
      const queue = sessionQueue.get(sessionKey);
      if (queue?.length) {
        const next = queue.shift()!;
        if (queue.length === 0) sessionQueue.delete(sessionKey);
        runChatSession(channel, peerId, sessionKey, next.id, next.content, next.ws);
      }
    }
  })();
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
    // Clear buffered messages — the client is gone.
    // The active agent task (if any) cleans itself up via AgentEngine's abort.
    sessionQueue.delete(ws.data.peerId);
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
