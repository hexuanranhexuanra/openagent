/**
 * Compare old vs new system prompt.
 *
 * Usage:
 *   bun run tests/compare-prompts.ts
 *
 * Outputs both prompts side-by-side with token estimates and section breakdowns.
 */
import { loadConfig } from "../src/config";
import { getMemoryStore } from "../src/evolution/memory";
import { getSkillLoader } from "../src/evolution/skill-loader";

// Force fresh config
const config = loadConfig();

// ── Old prompt (pre-optimization) ────────────────────────────────────────────

async function buildOldPrompt(depth = 0): Promise<string> {
  const memory = getMemoryStore();
  const [{ soul, user, world }, longTermMemory] = await Promise.all([
    memory.readAll(),
    memory.readLongTerm(),
  ]);

  const parts: string[] = [config.agent.systemPrompt];

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

  if (depth === 0) {
    parts.push(
      "\n\n--- EVOLUTION INSTRUCTIONS ---\n" +
        "Use evolution tools proactively to improve over time:\n" +
        "- memory_update/memory_append: Record learned behaviors, preferences, important facts\n" +
        "- skill_use: Execute a skill by name (see <skills> list above)\n" +
        "- skill_list: List all available skills\n" +
        "- skill_create: Create reusable TypeScript skills for recurring tasks.\n" +
        "  Each skill exports default { name, description, parameters (JSON Schema), async execute(args) → string }.\n" +
        "  Filename: <name>.skill.ts. Fix errors by reading with skill_read, then skill_create with overwrite=true.\n" +
        "- skill_read: Read an existing skill's source code\n" +
        "- self_modify: Modify source files within allowed paths (user-space/**, src/agent/tools/builtin/**)\n" +
        "- read_file/write_file: Work with files in user-space/workspace/\n" +
        "- sessions_spawn: Spawn an independent subagent for a concurrent task.\n" +
        "  The subagent notifies you when done — do NOT poll for status.",
    );
  } else {
    parts.push(
      "\n\n--- AVAILABLE EVOLUTION TOOLS ---\n" +
        "memory_update, memory_append, skill_use, read_file, write_file.",
    );
  }

  return parts.join("");
}

// ── New prompt (post-optimization) ───────────────────────────────────────────

async function buildNewPrompt(depth = 0): Promise<string> {
  // Use the actual ContextBuilder internals by importing them
  const { ContextBuilder, initContextBuilder } = await import("../src/agent/context");

  // We need a mock provider just for the name
  const mockProvider = {
    name: "anthropic (claude-sonnet-4)",
    chat: async function* () {},
  } as any;

  const builder = new ContextBuilder(mockProvider);
  // Access private method via prototype trick
  return (builder as any).buildSystemPrompt(config, "cli", depth);
}

// ── Analysis helpers ─────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil((text.length / 4) * 1.2);
}

function extractSections(prompt: string): { header: string; chars: number; tokens: number }[] {
  const sections: { header: string; chars: number; tokens: number }[] = [];
  const lines = prompt.split("\n");
  let currentHeader = "(preamble)";
  let currentContent = "";

  for (const line of lines) {
    if (line.startsWith("## ") || line.startsWith("# ") || line.startsWith("--- ")) {
      if (currentContent) {
        sections.push({
          header: currentHeader,
          chars: currentContent.length,
          tokens: estimateTokens(currentContent),
        });
      }
      currentHeader = line.replace(/^#+\s*/, "").replace(/^---\s*/, "").replace(/\s*---$/, "").trim();
      currentContent = "";
    } else {
      currentContent += line + "\n";
    }
  }
  if (currentContent) {
    sections.push({
      header: currentHeader,
      chars: currentContent.length,
      tokens: estimateTokens(currentContent),
    });
  }
  return sections;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await getSkillLoader().loadAll();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  SYSTEM PROMPT COMPARISON: OLD vs NEW");
  console.log("═══════════════════════════════════════════════════════════════\n");

  for (const depth of [0, 1] as const) {
    const label = depth === 0 ? "TOP-LEVEL (depth=0)" : "SUBAGENT (depth=1)";
    console.log(`\n${"─".repeat(60)}`);
    console.log(`  ${label}`);
    console.log(`${"─".repeat(60)}`);

    const oldPrompt = await buildOldPrompt(depth);
    const newPrompt = await buildNewPrompt(depth);

    const oldTokens = estimateTokens(oldPrompt);
    const newTokens = estimateTokens(newPrompt);
    const saved = oldTokens - newTokens;
    const pct = ((saved / oldTokens) * 100).toFixed(1);

    console.log(`\n  OLD: ${oldPrompt.length} chars / ~${oldTokens} tokens`);
    console.log(`  NEW: ${newPrompt.length} chars / ~${newTokens} tokens`);
    console.log(`  SAVED: ${saved} tokens (${pct}%)\n`);

    console.log("  OLD sections:");
    for (const s of extractSections(oldPrompt)) {
      console.log(`    ${s.header.padEnd(50)} ${String(s.chars).padStart(6)} chars  ~${String(s.tokens).padStart(5)} tok`);
    }

    console.log("\n  NEW sections:");
    for (const s of extractSections(newPrompt)) {
      console.log(`    ${s.header.padEnd(50)} ${String(s.chars).padStart(6)} chars  ~${String(s.tokens).padStart(5)} tok`);
    }

    // Check for new sections not in old
    const oldHeaders = new Set(extractSections(oldPrompt).map((s) => s.header));
    const newHeaders = new Set(extractSections(newPrompt).map((s) => s.header));
    const added = [...newHeaders].filter((h) => !oldHeaders.has(h));
    const removed = [...oldHeaders].filter((h) => !newHeaders.has(h));

    if (added.length > 0) {
      console.log("\n  ✅ NEW sections added:");
      for (const h of added) console.log(`    + ${h}`);
    }
    if (removed.length > 0) {
      console.log("\n  ⚠️  Sections removed/renamed:");
      for (const h of removed) console.log(`    - ${h}`);
    }
  }

  // Print full new prompt for review
  console.log("\n\n═══════════════════════════════════════════════════════════════");
  console.log("  FULL NEW PROMPT (depth=0)");
  console.log("═══════════════════════════════════════════════════════════════\n");
  const fullNew = await buildNewPrompt(0);
  console.log(fullNew);

  console.log("\n\n═══════════════════════════════════════════════════════════════");
  console.log("  FULL NEW PROMPT (depth=1, subagent)");
  console.log("═══════════════════════════════════════════════════════════════\n");
  const subNew = await buildNewPrompt(1);
  console.log(subNew);
}

main().catch(console.error);
