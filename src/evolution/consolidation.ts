import { createLogger } from "../logger";
import { getMemoryStore } from "./memory";
import { getSessionMessages, removeConsolidatedMessages } from "../sessions/manager";
import type { LLMProvider } from "../agent/providers/base";
import type { ChatMessage } from "../types/index";

const log = createLogger("evolution:consolidation");

// Fraction of the context window at which compaction fires.
const COMPACT_AT_RATIO = 0.65;
// Target fraction of the context window to retain after compaction.
const KEEP_RATIO = 0.35;
// Minimum number of turns to keep regardless of token budget.
const MIN_KEEP_TURNS = 3;
// 20% safety margin added to raw character-based estimates.
const SAFETY_MARGIN = 1.2;
// Token budget reserved for the compaction prompt + summary response.
const OVERHEAD_TOKENS = 4096;

/**
 * Estimate token count for a slice of messages.
 * Uses chars/4 heuristic with a safety margin — fast enough to run every request.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  const chars = messages.reduce((sum, m) => {
    const contentChars = typeof m.content === "string" ? m.content.length : 0;
    const toolChars = (m.toolCalls ?? []).reduce(
      (s, tc) => s + tc.function.arguments.length,
      0,
    );
    return sum + contentChars + toolChars;
  }, 0);
  return Math.ceil((chars / 4) * SAFETY_MARGIN);
}

/**
 * Consolidate session history into long-term memory when the estimated token
 * usage exceeds COMPACT_AT_RATIO of the model's context window.
 *
 * Old messages are summarised via LLM and written to:
 *   - MEMORY.md (overwritten with updated facts)
 *   - HISTORY.md (append-only event log)
 *
 * The session window is trimmed to KEEP_RATIO of the context window budget.
 * Failures are non-fatal: the session is left untouched and consolidation
 * will be retried on the next request.
 */
export async function consolidateIfNeeded(
  sessionId: string,
  provider: LLMProvider,
  contextWindow: number,
): Promise<void> {
  const messages = getSessionMessages(sessionId);
  if (messages.length === 0) return;

  const totalTokens = estimateTokens(messages);
  const compactThreshold = Math.floor(contextWindow * COMPACT_AT_RATIO);

  if (totalTokens < compactThreshold) return;

  // Walk from newest to oldest, accumulate tokens until we hit KEEP_RATIO of the budget.
  // Everything older than that cutpoint gets consolidated.
  const keepBudget = Math.floor(contextWindow * KEEP_RATIO);
  let keepCount = 0;
  let accTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens([messages[i]]);
    if (accTokens + msgTokens > keepBudget && keepCount >= MIN_KEEP_TURNS) break;
    accTokens += msgTokens;
    keepCount++;
  }

  // Ensure we always consolidate something (don't compact if nothing to drop)
  const toConsolidate = messages.slice(0, messages.length - keepCount);
  if (toConsolidate.length === 0) return;

  log.info("Memory consolidation triggered (token-aware)", {
    sessionId,
    totalMessages: messages.length,
    estimatedTokens: totalTokens,
    contextWindow,
    compactThreshold,
    consolidating: toConsolidate.length,
    keeping: keepCount,
  });

  try {
    await runConsolidation(sessionId, toConsolidate, provider, contextWindow);
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
  contextWindow: number,
): Promise<void> {
  const memory = getMemoryStore();
  const currentMemory = await memory.readLongTerm();

  // If the slice to consolidate is very large, summarise in two chunks and merge.
  const sliceTokens = estimateTokens(messages);
  const summaryBudget = Math.floor(contextWindow * KEEP_RATIO) - OVERHEAD_TOKENS;

  let summary: string;
  let memoryUpdate: string;

  if (sliceTokens > summaryBudget && messages.length > 4) {
    // Split into two halves, summarise each, then merge the two summaries.
    const mid = Math.floor(messages.length / 2);
    const [part1, part2] = [messages.slice(0, mid), messages.slice(mid)];

    const [res1, res2] = await Promise.all([
      callSummarise(part1, currentMemory, provider),
      callSummarise(part2, currentMemory, provider),
    ]);

    // Merge the two partial results
    const merged = await callMergeSummaries(
      `Part 1:\n${res1.summary}\n\nPart 2:\n${res2.summary}`,
      res2.memory_update, // take the later memory update as base
      provider,
    );
    summary = merged.summary;
    memoryUpdate = merged.memory_update;
  } else {
    const res = await callSummarise(messages, currentMemory, provider);
    summary = res.summary;
    memoryUpdate = res.memory_update;
  }

  await Promise.all([memory.appendHistory(summary), memory.writeLongTerm(memoryUpdate)]);
  removeConsolidatedMessages(sessionId, messages.length);

  log.info("Consolidation complete", { sessionId, consolidated: messages.length });
}

async function callSummarise(
  messages: ChatMessage[],
  currentMemory: string,
  provider: LLMProvider,
): Promise<{ summary: string; memory_update: string }> {
  const conversationText = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `[${m.role}]: ${(m.content ?? "").slice(0, 800)}`)
    .join("\n");

  const prompt = buildPrompt(conversationText, currentMemory);
  const result = await collectText(
    provider.chat(
      [{ role: "user", content: prompt, timestamp: Date.now() }],
      [],
      "You are a memory consolidation assistant. Respond with valid JSON only — no markdown fences.",
    ),
  );
  return parseOrThrow(result);
}

async function callMergeSummaries(
  combinedSummaries: string,
  baseMemory: string,
  provider: LLMProvider,
): Promise<{ summary: string; memory_update: string }> {
  const prompt = buildMergePrompt(combinedSummaries, baseMemory);
  const result = await collectText(
    provider.chat(
      [{ role: "user", content: prompt, timestamp: Date.now() }],
      [],
      "You are a memory consolidation assistant. Respond with valid JSON only — no markdown fences.",
    ),
  );
  return parseOrThrow(result);
}

async function collectText(
  stream: AsyncIterable<{ type: string; content?: string }>,
): Promise<string> {
  let out = "";
  for await (const chunk of stream) {
    if (chunk.type === "text" && chunk.content) out += chunk.content;
  }
  return out;
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
- "summary": A concise paragraph describing what happened. Appended to an append-only log.
- "memory_update": Full updated MEMORY.md content, merging important facts and preferences from this conversation into the existing memory. Be concise but thorough.

Respond with JSON only:
{"summary": "...", "memory_update": "..."}`;
}

function buildMergePrompt(combinedSummaries: string, baseMemory: string): string {
  return `Merge these two partial conversation summaries into one cohesive summary and an updated memory.

Current memory:
<memory>
${baseMemory || "(empty)"}
</memory>

Partial summaries to merge:
<summaries>
${combinedSummaries}
</summaries>

Produce a JSON object with exactly two string fields:
- "summary": A single merged paragraph preserving all decisions, TODOs, and constraints.
- "memory_update": The full updated MEMORY.md content after merging everything.

Respond with JSON only:
{"summary": "...", "memory_update": "..."}`;
}

function parseOrThrow(raw: string): { summary: string; memory_update: string } {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "")
      .trim();
    const obj = JSON.parse(cleaned);
    if (typeof obj.summary === "string" && typeof obj.memory_update === "string") {
      return obj as { summary: string; memory_update: string };
    }
  } catch {
    // fall through
  }
  throw new Error(`Could not parse consolidation JSON. Response: ${raw.slice(0, 300)}`);
}
