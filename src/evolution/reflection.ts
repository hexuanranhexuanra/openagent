import { getMemoryStore } from "./memory";
import { createLogger } from "../logger";
import type { ChatMessage } from "../types";

const log = createLogger("evolution:reflection");

/**
 * Analyze a completed conversation and extract learnings.
 * Runs asynchronously after each conversation to update USER.md.
 *
 * Uses a simple heuristic approach (no extra LLM call) to keep costs low.
 * For deeper reflection, wire this to a cheap model (haiku/mini).
 */
export async function reflectOnConversation(
  messages: ChatMessage[],
  channel: string,
  peerId: string,
): Promise<void> {
  try {
    const memory = getMemoryStore();

    const userMessages = messages.filter((m) => m.role === "user");
    const toolMessages = messages.filter((m) => m.role === "tool");

    if (userMessages.length === 0) return;

    // Track interaction count
    const summary = [
      `Channel: ${channel}, Peer: ${peerId}`,
      `Messages: ${userMessages.length} user, ${toolMessages.length} tool calls`,
      `Topics: ${extractTopicHints(userMessages)}`,
    ].join(" | ");

    await memory.appendEntry("USER", "## Interaction History Summary", summary);

    // Detect language preference from user messages
    const lastUserMsg = userMessages[userMessages.length - 1];
    if (lastUserMsg) {
      const hasChineseChars = /[\u4e00-\u9fff]/.test(lastUserMsg.content);
      if (hasChineseChars) {
        // Already default, but could be used for dynamic switching
      }
    }

    log.debug("Reflection completed", { channel, peerId, messageCount: messages.length });
  } catch (err) {
    log.warn("Reflection failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function extractTopicHints(messages: ChatMessage[]): string {
  const allText = messages.map((m) => m.content).join(" ");
  // Extract potential topic keywords (simple heuristic)
  const words = allText
    .replace(/[^\w\u4e00-\u9fff\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);

  const freq = new Map<string, number>();
  for (const w of words) {
    const lower = w.toLowerCase();
    freq.set(lower, (freq.get(lower) ?? 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w)
    .join(", ") || "general";
}
