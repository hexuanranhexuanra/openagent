/**
 * Quick verification script for Memory Consolidation + Skill Lazy Loading.
 *
 * Run with:
 *   bun run scripts/test-features.ts
 */

import { loadConfig } from "../src/config";
import { initAgent } from "../src/agent";
import { getOrCreateSession, appendMessage, getSessionMessages } from "../src/sessions/manager";
import { consolidateIfNeeded } from "../src/evolution/consolidation";
import { getMemoryStore } from "../src/evolution/memory";
import { getSkillLoader } from "../src/evolution/skill-loader";
import { getAllToolDefinitions } from "../src/agent/tools/registry";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function ok(msg: string) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function fail(msg: string) { console.log(`${RED}✗${RESET} ${msg}`); }
function info(msg: string) { console.log(`${YELLOW}→${RESET} ${msg}`); }
function section(msg: string) { console.log(`\n${BOLD}${msg}${RESET}`); }

loadConfig();
await initAgent();

// ── 1. Skill Lazy Loading ────────────────────────────────────────────────────

section("1. Skill Lazy Loading");

const tools = getAllToolDefinitions();
const skillTools = tools.filter((t) => t.name.startsWith("skill_") && t.name !== "skill_use" && t.name !== "skill_create" && t.name !== "skill_list");
const hasSkillUse = tools.some((t) => t.name === "skill_use");

if (skillTools.length === 0) {
  ok("No individual skill schemas injected into tool registry");
} else {
  fail(`Found ${skillTools.length} skill schemas still registered directly: ${skillTools.map(t => t.name).join(", ")}`);
}

if (hasSkillUse) {
  ok("skill_use dispatcher tool is registered");
} else {
  fail("skill_use tool NOT found in registry");
}

const catalog = getSkillLoader().getCatalog();
info(`Skill catalog: ${catalog.length} skills — ${catalog.map(s => s.name).join(", ") || "(none yet)"}`);

// ── 2. Skill Create + Lazy Execute ──────────────────────────────────────────

section("2. Skill Create + Execute via skill_use");

const loader = getSkillLoader();
const testSkillFile = "test-hello.skill.ts";
const testSkillSrc = `
export default {
  name: "test-hello",
  description: "Returns a greeting for the given name",
  parameters: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  execute: async (args: Record<string, unknown>) => {
    return \`Hello, \${args.name}!\`;
  },
};
`;

try {
  // Clean up previous run
  const { existsSync, unlinkSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const skillPath = resolve(process.cwd(), "user-space", "skills", testSkillFile);
  if (existsSync(skillPath)) unlinkSync(skillPath);

  await loader.createSkill(testSkillFile, testSkillSrc);
  await loader.hotReload(testSkillFile);

  const result = await loader.executeSkill("test-hello", { name: "World" });
  if (result === "Hello, World!") {
    ok(`executeSkill("test-hello") → "${result}"`);
  } else {
    fail(`Unexpected result: "${result}"`);
  }

  const catalogAfter = loader.getCatalog();
  if (catalogAfter.some((s) => s.name === "test-hello")) {
    ok("New skill appears in catalog immediately after creation");
  } else {
    fail("New skill NOT in catalog after creation");
  }

  // Clean up
  const { unlinkSync: rm } = await import("node:fs");
  rm(skillPath);
} catch (err) {
  fail(`Skill test threw: ${err instanceof Error ? err.message : String(err)}`);
}

// ── 3. Memory Consolidation ──────────────────────────────────────────────────

section("3. Memory Consolidation");

// Use a throwaway session so we don't pollute real history
const testChannel = "test";
const testPeer = `consolidation-test-${Date.now()}`;
const session = getOrCreateSession(testChannel, testPeer);

// Threshold = floor(maxHistoryMessages * 0.8). To trigger easily we need
// messages >= threshold. Let's add 6 messages (threshold at default 50 would
// be 40 — too many). Set a low threshold for this test.
const TEST_THRESHOLD = 4;

info(`Seeding ${TEST_THRESHOLD + 1} messages into test session (threshold = ${TEST_THRESHOLD})...`);
for (let i = 0; i <= TEST_THRESHOLD; i++) {
  appendMessage(session.id, {
    role: i % 2 === 0 ? "user" : "assistant",
    content: `Message ${i}: The user prefers TypeScript and dislikes verbose code.`,
    timestamp: Date.now(),
  });
}

const beforeCount = getSessionMessages(session.id).length;
info(`Session has ${beforeCount} messages before consolidation`);

const { getContextBuilder } = await import("../src/agent/context.js");
const provider = (getContextBuilder() as any).provider;

await consolidateIfNeeded(session.id, provider, TEST_THRESHOLD);

const afterCount = getSessionMessages(session.id).length;
const memory = getMemoryStore();
const longTermMemory = await memory.readLongTerm();
const historyExists = await (async () => {
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  return existsSync(resolve(process.cwd(), "user-space", "memory", "HISTORY.md"));
})();

if (afterCount < beforeCount) {
  ok(`Session trimmed: ${beforeCount} → ${afterCount} messages`);
} else {
  fail(`Session NOT trimmed (still ${afterCount} messages) — consolidation may have failed or LLM call errored`);
}

if (longTermMemory) {
  ok("MEMORY.md has content");
  info(`MEMORY.md preview:\n${longTermMemory.slice(0, 300)}`);
} else {
  fail("MEMORY.md is empty — LLM consolidation response may have failed to parse");
}

if (historyExists) {
  ok("HISTORY.md was created");
} else {
  fail("HISTORY.md was NOT created");
}

console.log("");
