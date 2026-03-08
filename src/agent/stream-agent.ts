import { createLogger } from "../logger";
import { appendMessage, getSessionMessages } from "../sessions/manager";
import { executeTool } from "./tools/registry";
import type { AgentContext } from "./context";
import type { AgentStreamEvent } from "./types";
import type { LLMProvider } from "./providers/base";
import type { ToolCall } from "../types";

const log = createLogger("agent:stream");

/**
 * StreamAgent — stateless ReAct (Reasoning + Acting) execution engine.
 *
 * Takes a fully-assembled AgentContext and an AbortSignal.
 * Yields structured AgentStreamEvents. Has no knowledge of sessions,
 * channels, or task lifecycle — those are AgentEngine's concern.
 *
 * Can be reused by AgentEngine (user chat), CronService,
 * HeartbeatService, SubAgent, etc.
 */
export class StreamAgent {
  constructor(private readonly provider: LLMProvider) {}

  async *run(ctx: AgentContext, signal: AbortSignal): AsyncGenerator<AgentStreamEvent> {
    let round = 0;

    while (round < ctx.maxRounds) {
      if (signal.aborted) return;

      round++;
      const messages = getSessionMessages(ctx.sessionId);
      const stream = this.provider.chat(messages, ctx.tools, ctx.systemPrompt);

      let roundText = "";
      const pendingToolCalls: ToolCall[] = [];

      for await (const chunk of stream) {
        if (signal.aborted) return;

        switch (chunk.type) {
          case "text":
            roundText += chunk.content ?? "";
            yield { type: "text", content: chunk.content };
            break;

          case "tool_call":
            if (chunk.toolCall) pendingToolCalls.push(chunk.toolCall);
            break;

          case "done":
            if (chunk.usage) {
              log.debug("Round usage", {
                round,
                sessionId: ctx.sessionId,
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

      if (roundText || pendingToolCalls.length) {
        appendMessage(ctx.sessionId, {
          role: "assistant",
          content: roundText,
          toolCalls: pendingToolCalls.length ? pendingToolCalls : undefined,
          timestamp: Date.now(),
        });
      }

      // No tool calls → natural end of ReAct loop
      if (pendingToolCalls.length === 0) break;

      for (const tc of pendingToolCalls) {
        if (signal.aborted) return;

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

        appendMessage(ctx.sessionId, {
          role: "tool",
          content: result,
          toolCallId: tc.id,
          timestamp: Date.now(),
        });
      }
    }

    if (round >= ctx.maxRounds) {
      log.warn("Max tool rounds reached", { sessionId: ctx.sessionId, rounds: round });
    }
  }
}
