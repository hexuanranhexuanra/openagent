import { createLogger } from "../logger";
import { getConfig } from "../config";
import { getMemoryStore } from "../evolution/memory";
import { getSkillLoader } from "../evolution/skill-loader";
import { consolidateIfNeeded } from "../evolution/consolidation";
import {
  getOrCreateSession,
  appendMessage,
  getSessionMessages,
} from "../sessions/manager";
import { getAllToolDefinitions } from "./tools/registry";
import { getSubagentDepth } from "./subagent-registry";
import type { LLMProvider } from "./providers/base";
import type { ChatMessage, ToolDefinition } from "../types/index";

const log = createLogger("agent:context");

export interface AgentContext {
  sessionId: string;
  channel: string;
  peerId: string;
  /** 0 = top-level user session; 1+ = nested subagent depth. */
  depth: number;
  messages: ChatMessage[];
  systemPrompt: string;
  tools: ToolDefinition[];
  maxRounds: number;
}

/**
 * ContextBuilder assembles an AgentContext before each task run.
 *
 * Responsibilities:
 * - Session lookup and user message persistence
 * - Memory consolidation when the session token budget is exceeded
 * - System prompt construction: base + SOUL/USER/WORLD + MEMORY.md + skills catalog
 * - Tool list assembly
 */
export class ContextBuilder {
  constructor(private readonly provider: LLMProvider) {}

  async build(channel: string, peerId: string, userMessage: string): Promise<AgentContext> {
    const config = getConfig();
    const session = getOrCreateSession(channel, peerId);

    // Resolve nesting depth: subagent sessions carry the depth in the registry.
    const depth = channel === "subagent" ? getSubagentDepth(peerId) : 0;

    // Consolidate old messages before appending the new user message so that
    // the updated MEMORY.md is included in the system prompt below.
    await consolidateIfNeeded(session.id, this.provider, config.agent.contextWindow);

    appendMessage(session.id, {
      role: "user",
      content: userMessage,
      timestamp: Date.now(),
    });

    const systemPrompt = await this.buildSystemPrompt(config.agent.systemPrompt);
    const messages = getSessionMessages(session.id);
    const tools = getAllToolDefinitions();

    return {
      sessionId: session.id,
      channel,
      peerId,
      depth,
      messages,
      systemPrompt,
      tools,
      maxRounds: config.agent.maxToolRounds,
    };
  }

  private async buildSystemPrompt(base: string): Promise<string> {
    try {
      const memory = getMemoryStore();
      const [{ soul, user, world }, longTermMemory] = await Promise.all([
        memory.readAll(),
        memory.readLongTerm(),
      ]);

      const parts: string[] = [base];

      if (soul) {
        parts.push("\n\n--- SOUL (your identity and behavioral guidelines) ---\n" + soul);
      }
      if (user) {
        parts.push("\n\n--- USER (what you know about the user) ---\n" + user);
      }
      if (world) {
        parts.push("\n\n--- WORLD (accumulated knowledge) ---\n" + world);
      }
      if (longTermMemory) {
        parts.push(
          "\n\n--- LONG-TERM MEMORY (consolidated facts from past conversations) ---\n" +
            longTermMemory,
        );
      }

      // Inject skill catalog so the agent knows what skills are available
      // without loading full parameter schemas into the context.
      const catalog = getSkillLoader().getCatalog();
      if (catalog.length > 0) {
        const list = catalog.map((s) => `- ${s.name}: ${s.description}`).join("\n");
        parts.push(
          "\n\n<skills>\n" +
            "Available skills — use the skill_use tool to execute them:\n" +
            list +
            "\n</skills>",
        );
      }

      parts.push(
        "\n\n--- EVOLUTION INSTRUCTIONS ---\n" +
          "You have access to evolution tools. Use them proactively:\n" +
          "- memory_update/memory_append: Record learned behaviors, preferences, important facts\n" +
          "- skill_use: Execute a skill by name (see <skills> list above)\n" +
          "- skill_list: List all available skills\n" +
          "- skill_create: Create reusable skill scripts for recurring tasks\n" +
          "- skill_read: Read an existing skill's source code (useful before fixing a broken skill)\n" +
          "- self_modify: Modify your own source code (within safety boundaries)\n" +
          "- read_file/write_file: Work with files in user-space/workspace/\n" +
          "- sessions_spawn: Spawn an independent subagent to run a task concurrently.\n" +
          "  The subagent will notify you when done — do NOT poll for its status.\n" +
          "\n" +
          "SKILL AUTHORING GUIDE:\n" +
          "Skills are TypeScript files in user-space/skills/. Each file MUST export a default object:\n" +
          "```typescript\n" +
          "export default {\n" +
          "  name: \"my-skill\",           // used to call it: skill_use({ name: \"my-skill\" })\n" +
          "  description: \"What it does\",\n" +
          "  parameters: {\n" +
          "    type: \"object\",\n" +
          "    properties: {\n" +
          "      input: { type: \"string\", description: \"The input\" },\n" +
          "    },\n" +
          "    required: [\"input\"],\n" +
          "  },\n" +
          "  async execute(args: Record<string, unknown>): Promise<string> {\n" +
          "    const input = args.input as string;\n" +
          "    // ... your logic ...\n" +
          "    return JSON.stringify({ result: input });\n" +
          "  },\n" +
          "};\n" +
          "```\n" +
          "Workflow for creating a skill:\n" +
          "1. Call skill_create({ filename: \"my-skill.skill.ts\", source: \"...\" })\n" +
          "2. If it returns an error with hint/filename: read the broken source with skill_read,\n" +
          "   fix the issue, then call skill_create again with overwrite=true.\n" +
          "3. Test it with skill_use({ name: \"my-skill\", args: { ... } })\n" +
          "\n" +
          "Evolve yourself to serve the user better over time.",
      );

      return parts.join("");
    } catch (err) {
      log.warn("Failed to build memory-enhanced prompt, using base", {
        error: err instanceof Error ? err.message : String(err),
      });
      return base;
    }
  }
}

let _contextBuilder: ContextBuilder | null = null;

export function getContextBuilder(): ContextBuilder {
  if (!_contextBuilder)
    throw new Error("ContextBuilder not initialized. Call initContextBuilder() first.");
  return _contextBuilder;
}

export function initContextBuilder(provider: LLMProvider): ContextBuilder {
  _contextBuilder = new ContextBuilder(provider);
  return _contextBuilder;
}
