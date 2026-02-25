import type { LLMProvider } from "./base";
import type { ChatMessage, StreamChunk, ToolDefinition } from "../../types";
import { createLogger } from "../../logger";

const log = createLogger("provider:bytedance-genai");

interface ResponsesAPIInput {
  role: string;
  content: string | { type: string; text: string }[];
}

interface ResponsesAPIToolDef {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface ResponsesAPIRequest {
  model: string;
  input: (ResponsesAPIInput | { type: string; call_id: string; output: string })[];
  tools?: ResponsesAPIToolDef[];
  instructions?: string;
  stream?: boolean;
}

interface ResponsesAPIOutputItem {
  type: string;
  id?: string;
  content?: { type: string; text: string }[];
  role?: string;
  status?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface ResponsesAPIResponse {
  id: string;
  status: string;
  output: ResponsesAPIOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  error?: { message: string; code: string };
}

/**
 * POST with manual redirect following that preserves method and body,
 * since standard fetch converts POST→GET on 301.
 */
async function postWithRedirect(
  url: string,
  body: string,
  headers: Record<string, string>,
  maxRedirects = 3,
): Promise<Response> {
  let currentUrl = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const resp = await fetch(currentUrl, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    });
    if (resp.status === 301 || resp.status === 302 || resp.status === 307 || resp.status === 308) {
      const location = resp.headers.get("location");
      if (!location) throw new Error(`Redirect without Location header from ${currentUrl}`);
      currentUrl = new URL(location, currentUrl).toString();
      log.debug("Following redirect", { from: currentUrl, to: location });
      continue;
    }
    return resp;
  }
  throw new Error(`Too many redirects (max ${maxRedirects})`);
}

export class ByteDanceGenAIProvider implements LLMProvider {
  readonly name = "bytedance-genai";
  private baseUrl: string;
  private model: string;
  private ak: string;

  constructor(model: string, baseUrl: string, ak: string) {
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    this.ak = ak;
    log.info("ByteDance GenAI provider initialized", {
      model,
      baseUrl: this.baseUrl,
    });
  }

  async *chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
  ): AsyncGenerator<StreamChunk> {
    const input: ResponsesAPIRequest["input"] = [];

    for (const msg of messages) {
      if (msg.role === "system") continue;
      if (msg.role === "tool") {
        input.push({
          type: "function_call_output",
          call_id: msg.toolCallId ?? "",
          output: msg.content,
        });
      } else if (msg.role === "assistant" && msg.toolCalls?.length) {
        if (msg.content) {
          input.push({
            role: "assistant",
            content: [{ type: "output_text", text: msg.content }],
          });
        }
        for (const tc of msg.toolCalls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          } as unknown as ResponsesAPIRequest["input"][number]);
        }
      } else if (msg.role === "assistant") {
        input.push({
          role: "assistant",
          content: [{ type: "output_text", text: msg.content }],
        });
      } else {
        input.push({
          role: msg.role,
          content: [{ type: "input_text", text: msg.content }],
        });
      }
    }

    const reqTools: ResponsesAPIToolDef[] | undefined = tools?.length
      ? tools.map((t) => ({
          type: "function" as const,
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }))
      : undefined;

    const reqBody: ResponsesAPIRequest = {
      model: this.model,
      input,
      stream: false,
    };
    if (systemPrompt) {
      reqBody.instructions = systemPrompt;
    }
    if (reqTools?.length) {
      reqBody.tools = reqTools;
    }

    const url = `${this.baseUrl}/responses?ak=${encodeURIComponent(this.ak)}`;
    const bodyStr = JSON.stringify(reqBody);

    try {
      const resp = await postWithRedirect(url, bodyStr, {
        "Content-Type": "application/json",
      });

      if (!resp.ok) {
        const errText = await resp.text();
        log.error("API request failed", { status: resp.status, body: errText });
        yield { type: "error", error: `API error ${resp.status}: ${errText}` };
        return;
      }

      const data = (await resp.json()) as ResponsesAPIResponse;

      if (data.error) {
        yield { type: "error", error: data.error.message };
        return;
      }

      for (const item of data.output) {
        if (item.type === "message" && item.content) {
          for (const part of item.content) {
            if (part.type === "output_text" && part.text) {
              yield { type: "text", content: part.text };
            }
          }
        } else if (item.type === "function_call" && item.name) {
          yield {
            type: "tool_call",
            toolCall: {
              id: item.call_id ?? item.id ?? `tc_${Date.now()}`,
              type: "function",
              function: {
                name: item.name,
                arguments: item.arguments ?? "{}",
              },
            },
          };
        }
      }

      yield {
        type: "done",
        usage: data.usage
          ? {
              promptTokens: data.usage.input_tokens,
              completionTokens: data.usage.output_tokens,
              totalTokens: data.usage.total_tokens,
            }
          : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("ByteDance GenAI request failed", { error: message });
      yield { type: "error", error: message };
    }
  }
}
