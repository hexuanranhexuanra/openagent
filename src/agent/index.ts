import { createLogger } from "../logger";
import { getConfig } from "../config";
import type { LLMProvider } from "./providers/base";
import { OpenAIProvider } from "./providers/openai";
import { AnthropicProvider } from "./providers/anthropic";
import { ByteDanceGenAIProvider } from "./providers/bytedance-genai";
import { ClaudeCodeProvider } from "./providers/claude-code";
import { registerTool } from "./tools/registry";
import { dateTimeTool } from "./tools/builtin/datetime";
import { webSearchTool } from "./tools/builtin/web-search";
import { shellTool } from "./tools/builtin/shell";
import { readFileTool, writeFileTool, listFilesTool } from "./tools/builtin/file-ops";
import {
  memoryUpdateTool,
  memoryAppendTool,
  memoryReadTool,
  skillUseTool,
  skillCreateTool,
  skillListTool,
  selfModifyTool,
  subagentSpawnTool,
} from "./tools/builtin/evolution-tools";
import { cronTool } from "./tools/builtin/cron-tool";
import { heartbeatTool } from "./tools/builtin/heartbeat-tool";
import { getSkillLoader } from "../evolution/skill-loader";
import { initContextBuilder } from "./context";
import { initAgentEngine, getAgentEngine } from "./engine";

export type { AgentStreamEvent } from "./types";
export { getAgentEngine } from "./engine";
export type { TaskInfo, TaskStatus } from "./engine";

const log = createLogger("agent");

let _providerName = "unknown";

export async function initAgent(): Promise<void> {
  registerTool(dateTimeTool);
  registerTool(webSearchTool);
  registerTool(shellTool);
  registerTool(readFileTool);
  registerTool(writeFileTool);
  registerTool(listFilesTool);
  registerTool(memoryUpdateTool);
  registerTool(memoryAppendTool);
  registerTool(memoryReadTool);
  registerTool(skillUseTool);
  registerTool(skillCreateTool);
  registerTool(skillListTool);
  registerTool(selfModifyTool);
  registerTool(cronTool);
  registerTool(heartbeatTool);
  registerTool(subagentSpawnTool);

  const provider = buildProvider();
  _providerName = provider.name;
  initContextBuilder(provider);
  initAgentEngine(provider);

  await loadSkills();

  log.info("Agent initialized", { provider: provider.name });
}

function buildProvider(): LLMProvider {
  const config = getConfig();
  const providerName = config.agent.defaultProvider;
  const oai = config.providers.openai;

  const isByteDance =
    (oai.queryParams?.ak && oai.baseUrl?.includes("byteintl.net")) ||
    oai.baseUrl?.includes("tiktok-row.org");

  if (providerName === "claude-code") {
    return new ClaudeCodeProvider();
  }

  if (providerName === "anthropic") {
    if (!config.providers.anthropic.apiKey) {
      log.warn("Anthropic API key not set, falling back to OpenAI");
      return isByteDance
        ? new ByteDanceGenAIProvider(oai.model, oai.baseUrl, oai.queryParams.ak)
        : new OpenAIProvider(oai.apiKey, oai.model, oai.baseUrl, oai.queryParams);
    }
    return new AnthropicProvider(
      config.providers.anthropic.apiKey,
      config.providers.anthropic.model,
    );
  }

  if (isByteDance) {
    return new ByteDanceGenAIProvider(oai.model, oai.baseUrl, oai.queryParams.ak);
  }

  return new OpenAIProvider(oai.apiKey, oai.model, oai.baseUrl, oai.queryParams);
}

async function loadSkills(): Promise<void> {
  try {
    // Populate the skill catalog (name + description) without registering
    // individual tool schemas — they are dispatched lazily via skill_use.
    await getSkillLoader().loadAll();
  } catch (err) {
    log.warn("Skill loading failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function getProviderName(): string {
  return _providerName;
}

/**
 * Backwards-compatible entry point. Delegates to AgentEngine.startTask().
 */
export async function* runAgent(
  channel: string,
  peerId: string,
  userMessage: string,
): AsyncGenerator<import("./types").AgentStreamEvent> {
  yield* getAgentEngine().startTask(channel, peerId, userMessage);
}

/**
 * Cancel the running task for a session. Returns true if cancelled.
 */
export function cancelAgent(channel: string, peerId: string): boolean {
  return getAgentEngine().cancelTask(channel, peerId);
}
