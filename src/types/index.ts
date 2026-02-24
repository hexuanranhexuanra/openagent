// ─── Gateway Protocol Types ───

export interface GatewayMessage {
  type: "event" | "req" | "res";
  id?: string;
  seq?: number;
}

export interface GatewayEvent extends GatewayMessage {
  type: "event";
  event: string;
  payload: Record<string, unknown>;
}

export interface GatewayRequest extends GatewayMessage {
  type: "req";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface GatewayResponse extends GatewayMessage {
  type: "res";
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: string;
}

// ─── Chat / Message Types ───

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  timestamp: number;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

// ─── Provider Types ───

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export interface StreamChunk {
  type: "text" | "tool_call" | "done" | "error";
  content?: string;
  toolCall?: ToolCall;
  error?: string;
  usage?: TokenUsage;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ─── Tool Types ───

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolHandler {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// ─── Session Types ───

export interface Session {
  id: string;
  channel: string;
  peerId: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

// ─── Channel Types ───

export interface IncomingMessage {
  channelType: string;
  channelId: string;
  peerId: string;
  content: string;
  mediaUrl?: string;
  timestamp: number;
  raw?: unknown;
}

export interface OutgoingMessage {
  channelType: string;
  channelId: string;
  peerId: string;
  content: string;
  replyToId?: string;
}
