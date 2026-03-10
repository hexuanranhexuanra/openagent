export interface AgentStreamEvent {
  type: "text" | "tool_start" | "tool_result" | "done" | "error" | "progress";
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  error?: string;
  /** Round counter for "progress" events. */
  round?: number;
  maxRounds?: number;
}
