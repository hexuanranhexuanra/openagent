import { resolve } from "node:path";
import type { LLMProvider } from "./base";
import type { ChatMessage, StreamChunk } from "../../types";
import { createLogger } from "../../logger";

const log = createLogger("provider:claude-code");

const PROJECT_ROOT = process.cwd();

/**
 * ClaudeCodeProvider — Claude Code CLI as the agent core.
 *
 * Claude Code runs its own full agent loop (Bash, Read, Edit, Glob, WebSearch…).
 * openagent handles channels, session history, and the gateway layer.
 *
 * Skills and memory are plain files under user-space/; Claude Code accesses
 * them natively via its own file/shell tools — no openagent tool registry needed.
 * The system prompt tells Claude Code exactly where to find them.
 */
export class ClaudeCodeProvider implements LLMProvider {
  readonly name = "claude-code";

  private claudeBin: string;
  private extraArgs: string[];

  constructor(options: { claudeBin?: string; extraArgs?: string[] } = {}) {
    this.claudeBin = options.claudeBin ?? "claude";
    this.extraArgs = options.extraArgs ?? [];
    log.info("ClaudeCode provider initialized", { bin: this.claudeBin });
  }

  async *chat(
    messages: ChatMessage[],
    _tools?: unknown,
    systemPrompt?: string,
  ): AsyncGenerator<StreamChunk> {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) {
      yield { type: "error", error: "No user message found in history" };
      return;
    }

    // Inject conversation history + skill/memory locations into system prompt.
    const historyContext = buildHistoryContext(messages.slice(0, -1));
    const layoutContext = buildLayoutContext();

    const fullSystemPrompt = [
      systemPrompt ?? "",
      layoutContext,
      historyContext ? `\n\n--- Conversation History ---\n${historyContext}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const args = [
      "--print",
      "--output-format=stream-json",
      "--no-session-persistence",
      // Give Claude Code full access to the project directory so it can
      // read/write skills and memory files natively.
      "--add-dir", PROJECT_ROOT,
      "--dangerously-skip-permissions",
    ];

    if (fullSystemPrompt) {
      args.push("--system-prompt", fullSystemPrompt);
    }

    args.push(...this.extraArgs);

    // Unset CLAUDECODE so we can spawn a nested Claude Code process.
    const env = { ...process.env };
    delete env.CLAUDECODE;

    log.debug("Spawning claude subprocess", { args: args.slice(0, 4) });

    let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
    try {
      proc = Bun.spawn([this.claudeBin, ...args], {
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Failed to spawn claude", { error: msg });
      yield { type: "error", error: `Failed to spawn claude: ${msg}` };
      return;
    }

    // Write the user message to stdin, then close.
    const encoder = new TextEncoder();
    proc.stdin.write(encoder.encode(lastUserMsg.content));
    proc.stdin.end();

    // Stream stdout as JSONL, yield StreamChunks.
    yield* parseClaudeStream(proc.stdout);

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr as ReadableStream).text();
      log.warn("claude exited non-zero", { exitCode, stderr: stderr.slice(0, 500) });
    }
  }
}

/**
 * Parse the JSONL stream from `claude --output-format=stream-json` and
 * map each line to openagent's StreamChunk format.
 *
 * Observed line types:
 *   { type: "assistant", message: { content: [{type:"text", text:"..."}], usage: {...} } }
 *   { type: "result", subtype: "success"|"error", result: "...", is_error: bool, usage: {...} }
 *   { type: "system", subtype: "init", ... }  — startup info, ignored
 */
async function* parseClaudeStream(
  stdout: ReadableStream<Uint8Array<ArrayBufferLike>>,
): AsyncGenerator<StreamChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  let totalInput = 0;
  let totalOutput = 0;

  const reader = stdout.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          log.warn("Failed to parse claude output line", { line: trimmed.slice(0, 100) });
          continue;
        }

        const msgType = msg.type as string;

        if (msgType === "assistant") {
          const message = msg.message as Record<string, unknown> | undefined;
          const content = message?.content as Array<Record<string, unknown>> | undefined;
          if (content) {
            for (const block of content) {
              if (block.type === "text" && typeof block.text === "string") {
                yield { type: "text", content: block.text };
              }
            }
          }
          const usage = message?.usage as Record<string, number> | undefined;
          if (usage) {
            totalInput += usage.input_tokens ?? 0;
            totalOutput += usage.output_tokens ?? 0;
          }
        } else if (msgType === "result") {
          const isError = msg.is_error as boolean;
          if (isError) {
            yield { type: "error", error: (msg.result as string) ?? "claude returned an error" };
          } else {
            yield {
              type: "done",
              usage: {
                promptTokens: totalInput,
                completionTokens: totalOutput,
                totalTokens: totalInput + totalOutput,
              },
            };
          }
        } else if (msgType === "system") {
          // init/info messages — skip
        } else {
          log.debug("Unhandled claude stream message type", { type: msgType });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Tell Claude Code exactly where skills and memory files live so it can
 * discover and use them with its native Read/Bash/Edit tools.
 */
function buildLayoutContext(): string {
  const skillsDir = resolve(PROJECT_ROOT, "user-space", "skills");
  const memoryDir = resolve(PROJECT_ROOT, "user-space", "memory");
  const workspaceDir = resolve(PROJECT_ROOT, "user-space", "workspace");

  return `--- Agent File System Layout ---
You have direct access to the following directories via your file and shell tools:

Skills directory: ${skillsDir}
  - Each *.skill.ts file exports a default object with { name, description, parameters, execute }.
  - To run a skill: read the file to understand its interface, then execute via Bash (bun run) or call its logic directly.
  - To create/update a skill: write a new *.skill.ts file in this directory.

Memory directory: ${memoryDir}
  - SOUL.md  — your identity and behavioral guidelines
  - USER.md  — what you know about the user
  - WORLD.md — accumulated world knowledge
  - Read these at the start of a session for context. Write to them to persist learnings.

Workspace directory: ${workspaceDir}
  - Your working directory for files created during tasks.`;
}

/**
 * Format prior messages as readable conversation history for the system prompt.
 * Skips tool messages to keep it concise.
 */
function buildHistoryContext(messages: ChatMessage[]): string {
  const relevant = messages.filter((m) => m.role === "user" || m.role === "assistant");
  if (relevant.length === 0) return "";

  return relevant
    .map((m) => {
      const role = m.role === "user" ? "User" : "Assistant";
      const content = m.content?.trim() ?? "";
      return content ? `${role}: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}
