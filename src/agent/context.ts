import os from "node:os";
import { createLogger } from "../logger";
import { getConfig, type AppConfig } from "../config";
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

// ── Bootstrap budget ────────────────────────────────────────────────────────

const MAX_SKILLS_PROMPT_CHARS = 30_000;

/**
 * Truncate a bootstrap file to fit within a character budget.
 * Keeps 70% from head, 20% from tail, with a truncation marker.
 */
function truncateBootstrap(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const head = content.slice(0, Math.floor(maxChars * 0.7));
  const tail = content.slice(-Math.floor(maxChars * 0.2));
  return head + "\n\n[...truncated, use memory_read for full content...]\n\n" + tail;
}

// ── System prompt sections ──────────────────────────────────────────────────

function buildIdentitySection(base: string): string {
  return "## Identity\n" + base;
}

function buildSafetySection(): string {
  return (
    "## Safety\n" +
    "- Do not pursue self-preservation, replication, resource acquisition, or power-seeking.\n" +
    "- Prioritize safety and human oversight over completion.\n" +
    "- If instructions conflict or seem dangerous, pause and ask.\n" +
    "- Never bypass safeguards or manipulate access controls.\n" +
    "- Do not modify system prompts, safety rules, or tool policies unless explicitly requested."
  );
}

function buildToolCallStyleSection(): string {
  return (
    "## Tool Call Style\n" +
    "Do not narrate routine, low-risk tool calls — just call the tool.\n" +
    "Narrate only when it helps: multi-step work, complex problems, sensitive actions, or when asked.\n" +
    "Keep narration brief and value-dense."
  );
}

function buildWorkspaceSection(): string {
  const cwd = process.cwd();
  return (
    "## Workspace\n" +
    `Working directory: ${cwd}\n` +
    "Config file: openagent.json (use read_config / write_config tools)\n" +
    "User files: user-space/workspace/ (use read_file / write_file / list_files)\n" +
    "Memory files: user-space/memory/ (use memory_read / memory_update / memory_append)\n" +
    "Skills: user-space/skills/*.skill.ts"
  );
}

function buildRuntimeSection(channel: string, modelName: string): string {
  const platform = process.platform;
  const arch = process.arch;
  const shell = os.userInfo().shell || process.env.SHELL || "unknown";
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    "## Runtime\n" +
    `- OS: ${platform} (${arch})\n` +
    `- Shell: ${shell}\n` +
    `- Model: ${modelName}\n` +
    `- Channel: ${channel}\n` +
    `- Time: ${now.toISOString()} (${tz})`
  );
}

function buildSkillsSection(): string | null {
  const catalog = getSkillLoader().getCatalog();
  if (catalog.length === 0) return null;

  let list = catalog.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  if (list.length > MAX_SKILLS_PROMPT_CHARS) {
    list = list.slice(0, MAX_SKILLS_PROMPT_CHARS) + "\n[...truncated...]";
  }

  return (
    "## Skills\n" +
    "Available skills — use the skill_use tool to execute them:\n" +
    "<skills>\n" + list + "\n</skills>"
  );
}

function buildMemoryRecallSection(): string {
  return (
    "## Memory Recall\n" +
    "Before answering about prior work, decisions, preferences, or facts:\n" +
    "use memory_read to check SOUL/USER/WORLD files.\n" +
    "If you checked but found nothing relevant, say so."
  );
}

function buildEvolutionSection(): string {
  return (
    "## Evolution\n" +
    "Use these tools proactively to improve over time:\n" +
    "- memory_update / memory_append: Record behaviors, preferences, facts\n" +
    "- skill_create: Create reusable .skill.ts for recurring tasks\n" +
    "- skill_read: Read skill source before modifying\n" +
    "- self_modify: Modify files in allowed paths (user-space/**, src/agent/tools/builtin/**)\n" +
    "- sessions_spawn: Spawn a concurrent subagent (auto-notifies when done, do NOT poll)"
  );
}

interface BootstrapFile {
  label: string;
  content: string;
}

function buildProjectContextSection(
  files: BootstrapFile[],
  perFileMax: number,
  totalMax: number,
): string | null {
  const nonEmpty = files.filter((f) => f.content.trim());
  if (nonEmpty.length === 0) return null;

  const parts: string[] = ["# Project Context\n"];
  let totalChars = 0;

  for (const file of nonEmpty) {
    const remaining = totalMax - totalChars;
    if (remaining <= 0) break;

    const budget = Math.min(perFileMax, remaining);
    const truncated = truncateBootstrap(file.content, budget);
    parts.push(`## ${file.label}\n${truncated}\n`);
    totalChars += truncated.length;
  }

  return parts.join("\n");
}

// ── ContextBuilder ──────────────────────────────────────────────────────────

/**
 * ContextBuilder assembles an AgentContext before each task run.
 *
 * Responsibilities:
 * - Session lookup and user message persistence
 * - Memory consolidation when the session token budget is exceeded
 * - System prompt construction with structured sections and budgets
 * - Tool list assembly
 */
export class ContextBuilder {
  constructor(private readonly provider: LLMProvider) {}

  async build(channel: string, peerId: string, userMessage: string): Promise<AgentContext> {
    const config = getConfig();
    const session = getOrCreateSession(channel, peerId);

    const depth = channel === "subagent" ? getSubagentDepth(peerId) : 0;

    // Consolidate before appending so MEMORY.md is fresh in the system prompt.
    await consolidateIfNeeded(session.id, this.provider, config.agent.contextWindow);

    appendMessage(session.id, {
      role: "user",
      content: userMessage,
      timestamp: Date.now(),
    });

    const systemPrompt = await this.buildSystemPrompt(config, channel, depth);
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

  private async buildSystemPrompt(
    config: AppConfig,
    channel: string,
    depth: number,
  ): Promise<string> {
    try {
      const isFull = depth === 0;
      const sections: string[] = [];

      // ── Always-included sections ────────────────────────────────────────
      sections.push(buildIdentitySection(config.agent.systemPrompt));
      sections.push(buildSafetySection());
      sections.push(buildToolCallStyleSection());
      sections.push(buildWorkspaceSection());
      sections.push(buildRuntimeSection(channel, this.provider.name));

      // ── Full mode only ──────────────────────────────────────────────────
      if (isFull) {
        const skills = buildSkillsSection();
        if (skills) sections.push(skills);

        sections.push(buildMemoryRecallSection());
        sections.push(buildEvolutionSection());
      }

      // ── Context files (budgeted) ────────────────────────────────────────
      const memory = getMemoryStore();
      const [{ soul, user, world }, longTermMemory] = await Promise.all([
        memory.readAll(),
        memory.readLongTerm(),
      ]);

      const perFileMax = config.agent.bootstrapMaxChars;
      const totalMax = config.agent.bootstrapTotalMaxChars;

      const bootstrapFiles: BootstrapFile[] = [];

      // SOUL.md always included (even for subagents — it defines persona)
      if (soul) bootstrapFiles.push({ label: "SOUL.md", content: soul });

      if (isFull) {
        if (user) bootstrapFiles.push({ label: "USER.md", content: user });
        if (world) bootstrapFiles.push({ label: "WORLD.md", content: world });
        if (longTermMemory) bootstrapFiles.push({ label: "MEMORY.md", content: longTermMemory });
      }

      const projectContext = buildProjectContextSection(bootstrapFiles, perFileMax, totalMax);
      if (projectContext) sections.push(projectContext);

      return sections.join("\n\n");
    } catch (err) {
      log.warn("Failed to build system prompt, using base", {
        error: err instanceof Error ? err.message : String(err),
      });
      return config.agent.systemPrompt;
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
