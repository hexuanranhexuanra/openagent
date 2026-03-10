import { createLogger } from "../logger";
import { appendMessage, getSessionMessages } from "../sessions/manager";
import { executeTool } from "./tools/registry";
import { LoopDetector } from "./loop-detector";
import { setCurrentRunContext } from "./subagent-registry";
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
    const loopDetector = new LoopDetector();

    while (round < ctx.maxRounds) {
      if (signal.aborted) return;

      round++;
      yield { type: "progress", round, maxRounds: ctx.maxRounds };
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

      // Expose current session identity to tools (e.g. sessions_spawn).
      setCurrentRunContext({ channel: ctx.channel, peerId: ctx.peerId, depth: ctx.depth });

      for (const tc of pendingToolCalls) {
        if (signal.aborted) return;

        const toolName = tc.function.name;
        let toolArgs: Record<string, unknown> = {};
        try {
          toolArgs = JSON.parse(tc.function.arguments);
        } catch {
          log.warn("Failed to parse tool arguments, skipping execution", {
            toolName,
            rawArgs: tc.function.arguments.slice(0, 300),
          });
          appendMessage(ctx.sessionId, {
            role: "tool",
            content: `[Error: Could not parse tool arguments as JSON. Raw: ${tc.function.arguments.slice(0, 300)}]`,
            toolCallId: tc.id,
            timestamp: Date.now(),
          });
          continue;
        }

        // Check for loops BEFORE executing — avoids wasting a tool call
        const loopCheck = loopDetector.check(toolName, toolArgs);
        if (loopCheck.stuck && loopCheck.level === "critical") {
          log.warn("Loop detector: critical — aborting run", {
            sessionId: ctx.sessionId,
            message: loopCheck.message,
          });
          // Persist a synthetic tool result so the LLM turn is valid, then surface the error
          appendMessage(ctx.sessionId, {
            role: "tool",
            content: `[LOOP DETECTED] ${loopCheck.message}`,
            toolCallId: tc.id,
            timestamp: Date.now(),
          });
          // Remaining tool calls in this batch also need synthetic results
          for (const remaining of pendingToolCalls.slice(pendingToolCalls.indexOf(tc) + 1)) {
            appendMessage(ctx.sessionId, {
              role: "tool",
              content: "[Skipped — loop detection aborted the run]",
              toolCallId: remaining.id,
              timestamp: Date.now(),
            });
          }
          yield { type: "error", error: loopCheck.message };
          return;
        }

        yield { type: "tool_start", toolName, toolArgs };

        let result = await executeTool(toolName, toolArgs);

        // Cap oversized tool results to prevent context window exhaustion
        const MAX_TOOL_RESULT_CHARS = 24_000; // ~6k tokens
        if (result.length > MAX_TOOL_RESULT_CHARS) {
          log.warn("Tool result truncated", { toolName, originalLength: result.length });
          result =
            result.slice(0, MAX_TOOL_RESULT_CHARS) +
            `\n\n[Result truncated: original was ${result.length} chars, kept first ${MAX_TOOL_RESULT_CHARS}]`;
        }

        // Append loop warning to the tool result so the LLM self-corrects next round
        if (loopCheck.stuck && loopCheck.level === "warning") {
          log.warn("Loop detector: warning", {
            sessionId: ctx.sessionId,
            toolName,
            message: loopCheck.message,
          });
          result += `\n\n[LOOP WARNING] ${loopCheck.message}`;
        }

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
      yield {
        type: "error",
        error:
          `Reached the limit of ${ctx.maxRounds} tool rounds without completing the task. ` +
          "Send a follow-up message to continue, or ask the agent to summarise progress so far.",
      };
    }
  }
}
