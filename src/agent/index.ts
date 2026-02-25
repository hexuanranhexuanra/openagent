import { createLogger } from "../logger";
import { getConfig } from "../config";
import type { LLMProvider } from "./providers/base";
import { OpenAIProvider } from "./providers/openai";
import { AnthropicProvider } from "./providers/anthropic";
import {
  registerTool,
  getAllToolDefinitions,
  executeTool,
} from "./tools/registry";
import { dateTimeTool } from "./tools/builtin/datetime";
import { webSearchTool } from "./tools/builtin/web-search";
import { shellTool } from "./tools/builtin/shell";
import { readFileTool, writeFileTool, listFilesTool } from "./tools/builtin/file-ops";
import {
  memoryUpdateTool,
  memoryAppendTool,
  memoryReadTool,
  skillCreateTool,
  skillListTool,
  selfModifyTool,
} from "./tools/builtin/evolution-tools";
import {
  getOrCreateSession,
  appendMessage,
  getSessionMessages,
} from "../sessions/manager";
import { getMemoryStore } from "../evolution/memory";
import { getSkillLoader } from "../evolution/skill-loader";
import { reflectOnConversation } from "../evolution/reflection";
import type { ChatMessage, StreamChunk, ToolCall } from "../types";

const log = createLogger("agent");

let provider: LLMProvider;
const MAX_TOOL_ROUNDS = 10;

export function initAgent(): void {
  const config = getConfig();

  // Register built-in tools
  registerTool(dateTimeTool);
  registerTool(webSearchTool);
  registerTool(shellTool);

  // File operation tools
  registerTool(readFileTool);
  registerTool(writeFileTool);
  registerTool(listFilesTool);

  // Evolution tools
  registerTool(memoryUpdateTool);
  registerTool(memoryAppendTool);
  registerTool(memoryReadTool);
  registerTool(skillCreateTool);
  registerTool(skillListTool);
  registerTool(selfModifyTool);

  // Load dynamic skills
  loadSkills();

  // Init LLM provider
  const providerName = config.agent.defaultProvider;

  if (providerName === "anthropic") {
    if (!config.providers.anthropic.apiKey) {
      log.warn("Anthropic API key not set, falling back to OpenAI");
      provider = new OpenAIProvider(
        config.providers.openai.apiKey,
        config.providers.openai.model,
        config.providers.openai.baseUrl,
      );
    } else {
      provider = new AnthropicProvider(
        config.providers.anthropic.apiKey,
        config.providers.anthropic.model,
      );
    }
  } else {
    provider = new OpenAIProvider(
      config.providers.openai.apiKey,
      config.providers.openai.model,
      config.providers.openai.baseUrl,
    );
  }

  log.info("Agent initialized", { provider: provider.name });
}

async function loadSkills(): Promise<void> {
  try {
    const loader = getSkillLoader();
    const skills = await loader.loadAll();
    for (const skill of skills) {
      registerTool(skill);
    }
  } catch (err) {
    log.warn("Skill loading failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build a system prompt that includes the agent's memory (SOUL + USER + WORLD).
 */
async function buildSystemPrompt(basePrompt: string): Promise<string> {
  try {
    const memory = getMemoryStore();
    const { soul, user, world } = await memory.readAll();

    const parts: string[] = [basePrompt];

    if (soul) {
      parts.push("\n\n--- SOUL (your identity and behavioral guidelines) ---\n" + soul);
    }
    if (user) {
      parts.push("\n\n--- USER (what you know about the user) ---\n" + user);
    }
    if (world) {
      parts.push("\n\n--- WORLD (accumulated knowledge) ---\n" + world);
    }

    parts.push(
      "\n\n--- EVOLUTION INSTRUCTIONS ---\n" +
      "You have access to evolution tools. Use them proactively:\n" +
      "- memory_update/memory_append: Record learned behaviors, preferences, important facts\n" +
      "- skill_create: Create reusable skill scripts for recurring tasks\n" +
      "- self_modify: Modify your own source code (within safety boundaries)\n" +
      "- read_file/write_file: Work with files in user-space/workspace/\n" +
      "Evolve yourself to serve the user better over time.",
    );

    return parts.join("");
  } catch (err) {
    log.warn("Failed to build memory-enhanced prompt, using base", {
      error: err instanceof Error ? err.message : String(err),
    });
    return basePrompt;
  }
}

export interface AgentStreamEvent {
  type: "text" | "tool_start" | "tool_result" | "done" | "error";
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  error?: string;
}

/**
 * Core agent loop: takes a user message, runs LLM with tools in a loop,
 * and yields streaming events back to the caller.
 */
export async function* runAgent(
  channel: string,
  peerId: string,
  userMessage: string,
): AsyncGenerator<AgentStreamEvent> {
  const config = getConfig();
  const session = getOrCreateSession(channel, peerId);
  const tools = getAllToolDefinitions();

  // Build memory-enhanced system prompt
  const systemPrompt = await buildSystemPrompt(config.agent.systemPrompt);

  // Append user message
  const userMsg: ChatMessage = {
    role: "user",
    content: userMessage,
    timestamp: Date.now(),
  };
  appendMessage(session.id, userMsg);

  let round = 0;
  let fullResponse = "";
  let pendingToolCalls: ToolCall[] = [];

  while (round < MAX_TOOL_ROUNDS) {
    round++;
    const history = getSessionMessages(session.id);

    const stream = provider.chat(history, tools, systemPrompt);
    let roundText = "";
    pendingToolCalls = [];

    for await (const chunk of stream) {
      switch (chunk.type) {
        case "text":
          roundText += chunk.content ?? "";
          yield { type: "text", content: chunk.content };
          break;

        case "tool_call":
          if (chunk.toolCall) {
            pendingToolCalls.push(chunk.toolCall);
          }
          break;

        case "done":
          if (chunk.usage) {
            log.debug("Usage", {
              round,
              prompt: chunk.usage.promptTokens,
              completion: chunk.usage.completionTokens,
            });
          }
          break;

        case "error":
          yield { type: "error", error: chunk.error };
          return;
      }
    }

    // Save assistant message
    if (roundText || pendingToolCalls.length) {
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: roundText,
        toolCalls: pendingToolCalls.length ? pendingToolCalls : undefined,
        timestamp: Date.now(),
      };
      appendMessage(session.id, assistantMsg);
      fullResponse += roundText;
    }

    // No tool calls? We're done.
    if (pendingToolCalls.length === 0) {
      break;
    }

    // Execute tool calls and feed results back
    for (const tc of pendingToolCalls) {
      const toolName = tc.function.name;
      let toolArgs: Record<string, unknown> = {};
      try {
        toolArgs = JSON.parse(tc.function.arguments);
      } catch {
        toolArgs = {};
      }

      yield { type: "tool_start", toolName, toolArgs };

      const result = await executeTool(toolName, toolArgs);

      yield { type: "tool_result", toolName, toolResult: result };

      const toolMsg: ChatMessage = {
        role: "tool",
        content: result,
        toolCallId: tc.id,
        timestamp: Date.now(),
      };
      appendMessage(session.id, toolMsg);
    }
  }

  if (round >= MAX_TOOL_ROUNDS) {
    log.warn("Max tool rounds reached", { channel, peerId, rounds: round });
  }

  // Async reflection — don't block the response
  const finalMessages = getSessionMessages(session.id);
  reflectOnConversation(finalMessages, channel, peerId).catch(() => {});

  yield { type: "done" };
}
