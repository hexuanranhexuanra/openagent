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
import {
  getOrCreateSession,
  appendMessage,
  getSessionMessages,
} from "../sessions/manager";
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

    const stream = provider.chat(history, tools, config.agent.systemPrompt);
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

    // Loop continues to next round with tool results in context
  }

  if (round >= MAX_TOOL_ROUNDS) {
    log.warn("Max tool rounds reached", { channel, peerId, rounds: round });
  }

  yield { type: "done" };
}
