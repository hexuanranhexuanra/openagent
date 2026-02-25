import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { createLogger } from "../logger";
import type { ToolHandler, ToolDefinition } from "../types";

const log = createLogger("evolution:skills");

export interface Skill {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export class SkillLoader {
  private skillsDir: string;
  private loaded = new Map<string, ToolHandler>();
  private loadGeneration = 0;

  constructor(skillsDir?: string) {
    this.skillsDir =
      skillsDir ?? resolve(process.cwd(), "user-space", "skills");
    if (!existsSync(this.skillsDir)) {
      mkdirSync(this.skillsDir, { recursive: true });
    }
  }

  async loadAll(): Promise<ToolHandler[]> {
    this.loadGeneration++;
    const handlers: ToolHandler[] = [];
    const glob = new Bun.Glob("**/*.skill.ts");

    for await (const file of glob.scan(this.skillsDir)) {
      try {
        const handler = await this.loadOne(file);
        if (handler) handlers.push(handler);
      } catch (err) {
        log.error("Failed to load skill", {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info("Skills loaded", { count: handlers.length });
    return handlers;
  }

  private async loadOne(filename: string): Promise<ToolHandler | null> {
    const fullPath = resolve(this.skillsDir, filename);
    if (!existsSync(fullPath)) return null;

    // Bust module cache by appending unique query string
    const mod = await import(`${fullPath}?gen=${this.loadGeneration}`);
    const skill: Skill = mod.default;

    if (!skill?.name || !skill?.execute) {
      log.warn("Invalid skill module, skipping", { filename });
      return null;
    }

    const handler: ToolHandler = {
      definition: {
        name: `skill_${skill.name}`,
        description: `[Skill] ${skill.description}`,
        parameters: skill.parameters,
      },
      execute: skill.execute,
    };

    this.loaded.set(filename, handler);
    log.info("Skill loaded", { name: skill.name, file: filename });
    return handler;
  }

  /**
   * Hot-reload a single skill after creation or modification.
   */
  async hotReload(filename: string): Promise<ToolHandler | null> {
    this.loadGeneration++;
    const handler = await this.loadOne(filename);
    if (handler) {
      this.loaded.set(filename, handler);
    }
    return handler;
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

  getLoaded(): ToolHandler[] {
    return [...this.loaded.values()];
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
