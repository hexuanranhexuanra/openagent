import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider } from "./base";
import type { ChatMessage, StreamChunk, ToolDefinition } from "../../types";
import { createLogger } from "../../logger";

const log = createLogger("provider:anthropic");

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    log.info("Anthropic provider initialized", { model });
  }

  async *chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
  ): AsyncGenerator<StreamChunk> {
    const anthropicMessages: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === "system") continue;

      if (msg.role === "tool") {
        anthropicMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.toolCallId ?? "",
              content: msg.content,
            },
          ],
        });
      } else if (msg.role === "assistant" && msg.toolCalls?.length) {
        const content: Anthropic.ContentBlockParam[] = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }
        anthropicMessages.push({ role: "assistant", content });
      } else {
        anthropicMessages.push({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        });
      }
    }

    const anthropicTools: Anthropic.Tool[] | undefined = tools?.length
      ? tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Tool.InputSchema,
        }))
      : undefined;

    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: anthropicMessages,
        tools: anthropicTools,
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            yield { type: "text", content: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            // Accumulating tool call JSON - handled at content_block_stop
          }
        } else if (event.type === "content_block_stop") {
          const snapshot = await stream.currentMessage();
          if (snapshot) {
            for (const block of snapshot.content) {
              if (block.type === "tool_use") {
                yield {
                  type: "tool_call",
                  toolCall: {
                    id: block.id,
                    type: "function",
                    function: {
                      name: block.name,
                      arguments: JSON.stringify(block.input),
                    },
                  },
                };
              }
            }
          }
        } else if (event.type === "message_stop") {
          const finalMessage = await stream.finalMessage();
          yield {
            type: "done",
            usage: {
              promptTokens: finalMessage.usage.input_tokens,
              completionTokens: finalMessage.usage.output_tokens,
              totalTokens:
                finalMessage.usage.input_tokens +
                finalMessage.usage.output_tokens,
            },
          };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Anthropic request failed", { error: message });
      yield { type: "error", error: message };
    }
  }
}
