import type { ChatMessage, StreamChunk, ToolDefinition } from "../../types";

export interface LLMProvider {
  readonly name: string;

  chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
  ): AsyncGenerator<StreamChunk>;
}
