import { createLogger } from "../logger";
import { getMemoryStore } from "./memory";
import { getSessionMessages, removeConsolidatedMessages } from "../sessions/manager";
import type { LLMProvider } from "../agent/providers/base";
import type { ChatMessage } from "../types/index";

const log = createLogger("evolution:consolidation");

/**
 * Consolidate session history into long-term memory when the message count
 * reaches `threshold`. Old messages are summarised via LLM and written to
 * MEMORY.md (facts) and HISTORY.md (log). The session window is trimmed,
 * keeping the most recent 35% of messages (minimum 3).
 *
 * Failures are non-fatal: the session is left untouched and consolidation
 * will be retried on the next request.
 */
export async function consolidateIfNeeded(
  sessionId: string,
  provider: LLMProvider,
  threshold: number,
): Promise<void> {
  const messages = getSessionMessages(sessionId);
  if (messages.length < threshold) return;

  // Keep ~35% of messages in the window so there's always recent context.
  // Minimum 3 to avoid keeping nothing after consolidation.
  const keepRecent = Math.max(3, Math.floor(messages.length * 0.35));
  const toConsolidate = messages.slice(0, messages.length - keepRecent);
  if (toConsolidate.length === 0) return;

  log.info("Memory consolidation triggered", {
    sessionId,
    total: messages.length,
    consolidating: toConsolidate.length,
    keeping: keepRecent,
  });

  try {
    await runConsolidation(sessionId, toConsolidate, provider);
  } catch (err) {
    log.warn("Consolidation failed, messages preserved", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runConsolidation(
  sessionId: string,
  messages: ChatMessage[],
  provider: LLMProvider,
): Promise<void> {
  const memory = getMemoryStore();
  const currentMemory = await memory.readLongTerm();

  const conversationText = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `[${m.role}]: ${(m.content ?? "").slice(0, 800)}`)
    .join("\n");

  const prompt = buildPrompt(conversationText, currentMemory);

  let fullResponse = "";
  const stream = provider.chat(
    [{ role: "user", content: prompt, timestamp: Date.now() }],
    [],
    "You are a memory consolidation assistant. Respond with valid JSON only — no markdown fences, no extra text.",
  );

  for await (const chunk of stream) {
    if (chunk.type === "text" && chunk.content) {
      fullResponse += chunk.content;
    }
  }

  const parsed = parseResponse(fullResponse);
  if (!parsed) {
    throw new Error(
      `Could not parse consolidation JSON. Response: ${fullResponse.slice(0, 300)}`,
    );
  }

  await Promise.all([
    memory.appendHistory(parsed.summary),
    memory.writeLongTerm(parsed.memory_update),
  ]);

  removeConsolidatedMessages(sessionId, messages.length);

  log.info("Consolidation complete", { sessionId, summarized: messages.length });
}

function buildPrompt(conversation: string, memory: string): string {
  return `You are compressing a conversation into long-term memory.

Current long-term memory (MEMORY.md):
<memory>
${memory || "(empty — first consolidation)"}
</memory>

Conversation messages to summarise:
<conversation>
${conversation}
</conversation>

Produce a JSON object with exactly two string fields:
- "summary": A concise natural-language paragraph describing what happened in this conversation segment. This will be appended to an append-only history log.
- "memory_update": The full updated content for MEMORY.md, merging important facts, user preferences, and context from this conversation into the existing memory. Be concise but thorough.

Respond with JSON only:
{"summary": "...", "memory_update": "..."}`;
}

function parseResponse(
  raw: string,
): { summary: string; memory_update: string } | null {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "")
      .trim();
    const obj = JSON.parse(cleaned);
    if (typeof obj.summary === "string" && typeof obj.memory_update === "string") {
      return obj as { summary: string; memory_update: string };
    }
    return null;
  } catch {
    return null;
  }
}
