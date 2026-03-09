import { Database } from "bun:sqlite";
import { createLogger } from "../logger";
import type { ChatMessage, Session } from "../types";
import { getConfig } from "../config";

const log = createLogger("sessions");

let db: Database;

function getDb(): Database {
  if (db) return db;

  const config = getConfig();
  const dbPath = config.storage.dbPath;

  const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
  if (dir) {
    require("node:fs").mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      messages TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_consolidated INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Migrate existing tables that pre-date the last_consolidated column.
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN last_consolidated INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists — ignore.
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_channel_peer
    ON sessions(channel, peer_id)
  `);

  log.info("Database initialized", { path: dbPath });
  return db;
}

export function getOrCreateSession(channel: string, peerId: string): Session {
  const database = getDb();
  const sessionId = `${channel}:${peerId}`;

  const row = database
    .query("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId) as Record<string, unknown> | null;

  if (row) {
    const raw = JSON.parse(row.messages as string) as ChatMessage[];
    const { messages, repairedCount } = repairTranscript(raw);

    if (repairedCount > 0) {
      log.warn("Repaired broken tool call transcript", { id: sessionId, repairedCount });
      database
        .query("UPDATE sessions SET messages = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(messages), Date.now(), sessionId);
    }

    return {
      id: row.id as string,
      channel: row.channel as string,
      peerId: row.peer_id as string,
      messages,
      metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  const now = Date.now();
  const session: Session = {
    id: sessionId,
    channel,
    peerId,
    messages: [],
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };

  database
    .query(
      "INSERT INTO sessions (id, channel, peer_id, messages, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      session.id,
      session.channel,
      session.peerId,
      JSON.stringify(session.messages),
      JSON.stringify(session.metadata),
      session.createdAt,
      session.updatedAt
    );

  log.info("Session created", { id: sessionId });
  return session;
}

export function appendMessage(sessionId: string, message: ChatMessage): void {
  const database = getDb();
  const config = getConfig();
  const maxHistory = config.agent.maxHistoryMessages;

  database.transaction(() => {
    const row = database
      .query("SELECT messages FROM sessions WHERE id = ?")
      .get(sessionId) as Record<string, unknown> | null;

    if (!row) {
      log.warn("Session not found for append", { id: sessionId });
      return;
    }

    const messages = JSON.parse(row.messages as string) as ChatMessage[];
    messages.push(message);

    const trimmed = messages.length > maxHistory
      ? messages.slice(messages.length - maxHistory)
      : messages;

    database
      .query("UPDATE sessions SET messages = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(trimmed), Date.now(), sessionId);
  })();
}

export function getSessionMessages(sessionId: string): ChatMessage[] {
  const database = getDb();

  const row = database
    .query("SELECT messages FROM sessions WHERE id = ?")
    .get(sessionId) as Record<string, unknown> | null;

  if (!row) return [];
  return JSON.parse(row.messages as string) as ChatMessage[];
}

export function resetSession(sessionId: string): void {
  const database = getDb();
  database
    .query("UPDATE sessions SET messages = '[]', updated_at = ? WHERE id = ?")
    .run(Date.now(), sessionId);
  log.info("Session reset", { id: sessionId });
}

/**
 * Remove the oldest `count` messages from a session's history and increment
 * last_consolidated by the same amount. Called after successful consolidation.
 */
export function removeConsolidatedMessages(sessionId: string, count: number): void {
  const database = getDb();
  database.transaction(() => {
    const row = database
      .query("SELECT messages, last_consolidated FROM sessions WHERE id = ?")
      .get(sessionId) as Record<string, unknown> | null;

    if (!row) return;

    const messages = JSON.parse(row.messages as string) as ChatMessage[];
    const trimmed = messages.slice(count);
    const consolidated = (row.last_consolidated as number) + count;

    database
      .query(
        "UPDATE sessions SET messages = ?, last_consolidated = ?, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(trimmed), consolidated, Date.now(), sessionId);
  })();

  log.info("Consolidated messages removed", { id: sessionId, removed: count });
}

/**
 * Repair a transcript that was interrupted mid-tool-execution.
 *
 * If an assistant message has tool_calls but some of those calls have no
 * matching tool result in the messages that follow, a synthetic error result
 * is injected. Without this, most LLMs reject the conversation with a
 * validation error because every tool_use must have a tool_result.
 */
function repairTranscript(
  messages: ChatMessage[],
): { messages: ChatMessage[]; repairedCount: number } {
  const out: ChatMessage[] = [];
  let repairedCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    out.push(msg);

    if (msg.role !== "assistant" || !msg.toolCalls?.length) continue;

    // Collect tool result IDs from the immediately following tool messages
    const respondedIds = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      if (messages[j].toolCallId) respondedIds.add(messages[j].toolCallId!);
      j++;
    }

    // Inject synthetic results for orphaned tool calls
    for (const tc of msg.toolCalls) {
      if (!respondedIds.has(tc.id)) {
        out.push({
          role: "tool",
          content: "[Tool execution was interrupted. Please retry the task.]",
          toolCallId: tc.id,
          timestamp: msg.timestamp + 1,
        });
        repairedCount++;
      }
    }
  }

  return { messages: out, repairedCount };
}

export function listSessions(): Session[] {
  const database = getDb();
  const rows = database.query("SELECT * FROM sessions ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: row.id as string,
    channel: row.channel as string,
    peerId: row.peer_id as string,
    messages: JSON.parse(row.messages as string) as ChatMessage[],
    metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  }));
}
