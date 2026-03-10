import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider } from "./base";
import type { ChatMessage, StreamChunk, ToolDefinition } from "../../types";
import { createLogger } from "../../logger";

const log = createLogger("provider:anthropic");

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string, setupToken?: string) {
    if (setupToken) {
      // OAuth Bearer token from CLAUDE_CODE_OAUTH_TOKEN — uses Claude subscription billing.
      // Requires anthropic-beta: oauth-2025-04-20 header to enable OAuth auth on the API.
      this.client = new Anthropic({
        authToken: setupToken,
        apiKey: null as unknown as string,
        defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
      });
      log.info("Anthropic provider initialized (setup-token / OAuth)", { model });
    } else {
      this.client = new Anthropic({ apiKey });
      log.info("Anthropic provider initialized", { model });
    }
    this.model = model;
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
        // Ensure content is always a string — dynamic skills may return non-strings at runtime.
        const toolContent =
          typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
        anthropicMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.toolCallId ?? "",
              content: toolContent,
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
          // Use event.index to only emit the block that just completed.
          // Iterating all snapshot.content would re-emit earlier tool_use blocks
          // on every subsequent content_block_stop, producing duplicates.
          const snapshot = stream.currentMessage;
          const block = snapshot?.content[event.index];
          if (block?.type === "tool_use") {
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
