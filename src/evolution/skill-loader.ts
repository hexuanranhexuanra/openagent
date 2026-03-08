import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { createLogger } from "../logger";
import type { ToolHandler } from "../types/index";

const log = createLogger("evolution:skills");

export interface Skill {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface SkillMeta {
  name: string;
  description: string;
}

export class SkillLoader {
  private skillsDir: string;
  private loadGeneration = 0;

  // filename → handler (for hot-reload tracking)
  private byFile = new Map<string, ToolHandler>();
  // skill.name → handler (for catalog + executeSkill lookup)
  private byName = new Map<string, ToolHandler>();

  constructor(skillsDir?: string) {
    this.skillsDir =
      skillsDir ?? resolve(process.cwd(), "user-space", "skills");
    if (!existsSync(this.skillsDir)) {
      mkdirSync(this.skillsDir, { recursive: true });
    }
  }

  async loadAll(): Promise<void> {
    this.loadGeneration++;
    const glob = new Bun.Glob("**/*.skill.ts");

    for await (const file of glob.scan(this.skillsDir)) {
      try {
        await this.loadOne(file);
      } catch (err) {
        log.error("Failed to load skill", {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info("Skill catalog ready", { count: this.byName.size });
  }

  private async loadOne(filename: string): Promise<ToolHandler | null> {
    const fullPath = resolve(this.skillsDir, filename);
    if (!existsSync(fullPath)) return null;

    const mod = await import(`${fullPath}?gen=${this.loadGeneration}`);
    const skill: Skill = mod.default;

    if (!skill?.name || !skill?.execute) {
      log.warn("Invalid skill module, skipping", { filename });
      return null;
    }

    const handler: ToolHandler = {
      definition: {
        name: `skill_${skill.name}`,
        description: skill.description,
        parameters: skill.parameters,
      },
      execute: skill.execute,
    };

    this.byFile.set(filename, handler);
    this.byName.set(skill.name, handler);
    log.info("Skill loaded", { name: skill.name, file: filename });
    return handler;
  }

  /**
   * Return lightweight skill metadata for system prompt injection.
   * Does not include parameter schemas — those are loaded on demand.
   */
  getCatalog(): SkillMeta[] {
    return [...this.byName.entries()].map(([name, handler]) => ({
      name,
      description: handler.definition.description,
    }));
  }

  /**
   * Execute a skill by name. Lazy-loads if not yet in cache.
   */
  async executeSkill(name: string, args: Record<string, unknown>): Promise<string> {
    let handler = this.byName.get(name);

    if (!handler) {
      // Try to find and load the skill from disk.
      const glob = new Bun.Glob("**/*.skill.ts");
      for await (const file of glob.scan(this.skillsDir)) {
        if (!this.byFile.has(file)) {
          this.loadGeneration++;
          await this.loadOne(file);
        }
      }
      handler = this.byName.get(name);
    }

    if (!handler) {
      const available = [...this.byName.keys()].join(", ") || "none";
      throw new Error(`Skill not found: "${name}". Available skills: ${available}`);
    }

    return handler.execute(args);
  }

  /**
   * Hot-reload a single skill after creation or modification.
   */
  async hotReload(filename: string): Promise<ToolHandler | null> {
    this.loadGeneration++;
    return this.loadOne(filename);
  }

  /**
   * Create a new skill file from source code.
   */
  async createSkill(filename: string, sourceCode: string): Promise<string> {
    if (!filename.endsWith(".skill.ts")) {
      filename = `${filename}.skill.ts`;
    }

    const fullPath = resolve(this.skillsDir, filename);
    if (existsSync(fullPath)) {
      throw new Error(`Skill already exists: ${filename}`);
    }

    await Bun.write(fullPath, sourceCode);
    log.info("Skill file created", { filename });
    return fullPath;
  }

  listSkillFiles(): string[] {
    const glob = new Bun.Glob("**/*.skill.ts");
    const files: string[] = [];
    for (const file of glob.scanSync(this.skillsDir)) {
      files.push(file);
    }
    return files;
  }
}

let _loader: SkillLoader | null = null;

export function getSkillLoader(): SkillLoader {
  if (!_loader) _loader = new SkillLoader();
  return _loader;
}
