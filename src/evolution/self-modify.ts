import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { createLogger } from "../logger";

const log = createLogger("evolution:selfmod");

const PROJECT_ROOT = process.cwd();
const BACKUP_DIR = resolve(PROJECT_ROOT, "data", "backups");

const ALLOWED_GLOBS = [
  "user-space/**",
  "src/agent/tools/builtin/**",
  "config/**",
];

const DENIED_PATHS = [
  "src/evolution/",
  "src/config/",
  "src/logger.ts",
  "src/index.ts",
  "src/worker.ts",
  "src/gateway/server.ts",
  "package.json",
  "tsconfig.json",
  ".env",
  ".git/",
];

export interface ModifyResult {
  success: boolean;
  reason?: string;
  backupPath?: string;
}

export class SelfModifier {
  private changeLog: Array<{
    timestamp: string;
    file: string;
    action: string;
    rationale: string;
  }> = [];

  isAllowed(filePath: string): boolean {
    const rel = relative(PROJECT_ROOT, resolve(PROJECT_ROOT, filePath));

    for (const denied of DENIED_PATHS) {
      if (rel.startsWith(denied) || rel === denied.replace(/\/$/, "")) {
        return false;
      }
    }

    for (const pattern of ALLOWED_GLOBS) {
      const prefix = pattern.replace("/**", "");
      if (rel.startsWith(prefix)) return true;
    }

    return false;
  }

  async modify(
    filePath: string,
    content: string,
    rationale: string,
  ): Promise<ModifyResult> {
    const absPath = resolve(PROJECT_ROOT, filePath);
    const rel = relative(PROJECT_ROOT, absPath);

    if (!this.isAllowed(rel)) {
      log.warn("Self-modify blocked", { path: rel, rationale });
      return {
        success: false,
        reason: `Path not in allowlist: ${rel}. Allowed: ${ALLOWED_GLOBS.join(", ")}`,
      };
    }

    // Backup existing file
    let backupPath: string | undefined;
    if (existsSync(absPath)) {
      backupPath = await this.backup(absPath, rel);
    }

    // Ensure parent directory exists
    const parentDir = absPath.substring(0, absPath.lastIndexOf("/"));
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    // Validate TypeScript syntax for .ts files
    if (filePath.endsWith(".ts")) {
      const valid = await this.validateSyntax(content);
      if (!valid) {
        return {
          success: false,
          reason: "TypeScript syntax validation failed",
          backupPath,
        };
      }
    }

    await Bun.write(absPath, content);

    this.changeLog.push({
      timestamp: new Date().toISOString(),
      file: rel,
      action: existsSync(absPath) ? "modify" : "create",
      rationale,
    });

    log.info("Self-modify applied", { path: rel, rationale });
    return { success: true, backupPath };
  }

  private async backup(absPath: string, rel: string): Promise<string> {
    if (!existsSync(BACKUP_DIR)) {
      mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const timestamp = Date.now();
    const safeName = rel.replace(/\//g, "__");
    const backupPath = resolve(BACKUP_DIR, `${timestamp}_${safeName}`);
    copyFileSync(absPath, backupPath);
    return backupPath;
  }

  private async validateSyntax(content: string): Promise<boolean> {
    try {
      // Use Bun's built-in transpiler for fast syntax checking
      new Bun.Transpiler({ loader: "ts" }).transformSync(content);
      return true;
    } catch (err) {
      log.warn("Syntax validation failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  getChangeLog() {
    return [...this.changeLog];
  }
}

let _modifier: SelfModifier | null = null;

export function getSelfModifier(): SelfModifier {
  if (!_modifier) _modifier = new SelfModifier();
  return _modifier;
}
