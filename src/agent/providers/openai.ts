import OpenAI from "openai";
import type { LLMProvider } from "./base";
import type { ChatMessage, StreamChunk, ToolDefinition } from "../../types";
import { createLogger } from "../../logger";

const log = createLogger("provider:openai");

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string, baseUrl?: string, queryParams?: Record<string, string>) {
    const opts: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: apiKey || "unused",
      baseURL: baseUrl,
    };
    // Support query-param auth (e.g. ByteDance GenAI uses ?ak=...)
    if (queryParams && Object.keys(queryParams).length > 0) {
      opts.defaultQuery = queryParams;
    }
    this.client = new OpenAI(opts);
    this.model = model;
    log.info("OpenAI provider initialized", { model, baseUrl: baseUrl ?? "default" });
  }

  async *chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
  ): AsyncGenerator<StreamChunk> {
    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (systemPrompt) {
      openaiMessages.push({ role: "system", content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === "tool") {
        openaiMessages.push({
          role: "tool",
          content: msg.content,
          tool_call_id: msg.toolCallId ?? "",
        });
      } else if (msg.role === "assistant" && msg.toolCalls?.length) {
        openaiMessages.push({
          role: "assistant",
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        });
      } else {
        openaiMessages.push({
          role: msg.role as "user" | "assistant" | "system",
          content: msg.content,
        });
      }
    }

    const openaiTools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined =
      tools?.length
        ? tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters as Record<string, unknown>,
            },
          }))
        : undefined;

    try {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: openaiMessages,
        tools: openaiTools,
        stream: true,
      });

      let currentToolCall: { id: string; name: string; args: string } | null = null;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { type: "text", content: delta.content };
        }

        if (delta.tool_calls?.length) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              if (currentToolCall) {
                yield {
                  type: "tool_call",
                  toolCall: {
                    id: currentToolCall.id,
                    type: "function",
                    function: { name: currentToolCall.name, arguments: currentToolCall.args },
                  },
                };
              }
              currentToolCall = { id: tc.id, name: tc.function?.name ?? "", args: "" };
            }
            if (tc.function?.name && currentToolCall) {
              currentToolCall.name = tc.function.name;
            }
            if (tc.function?.arguments && currentToolCall) {
              currentToolCall.args += tc.function.arguments;
            }
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          if (currentToolCall) {
            yield {
              type: "tool_call",
              toolCall: {
                id: currentToolCall.id,
                type: "function",
                function: { name: currentToolCall.name, arguments: currentToolCall.args },
              },
            };
            currentToolCall = null;
          }

          if (chunk.usage) {
            yield {
              type: "done",
              usage: {
                promptTokens: chunk.usage.prompt_tokens,
                completionTokens: chunk.usage.completion_tokens,
                totalTokens: chunk.usage.total_tokens,
              },
            };
          } else {
            yield { type: "done" };
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("OpenAI request failed", { error: message });
      yield { type: "error", error: message };
    }
  }
}
