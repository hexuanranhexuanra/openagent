import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { ToolHandler } from "../../../types";

const WORKSPACE_ROOT = resolve(process.cwd(), "user-space", "workspace");

function resolveSafe(userPath: string): string | null {
  const full = resolve(WORKSPACE_ROOT, userPath);
  if (!full.startsWith(WORKSPACE_ROOT)) return null;
  return full;
}

export const readFileTool: ToolHandler = {
  definition: {
    name: "read_file",
    description:
      "Read the contents of a file from the workspace (user-space/workspace/). " +
      "Returns the file content with line numbers.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to workspace root",
        },
      },
      required: ["path"],
    },
  },

  async execute(args) {
    const userPath = args.path as string;
    const absPath = resolveSafe(userPath);
    if (!absPath) return JSON.stringify({ error: "Path traversal not allowed" });
    if (!existsSync(absPath)) return JSON.stringify({ error: `File not found: ${userPath}` });

    const content = await Bun.file(absPath).text();
    const numbered = content
      .split("\n")
      .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
      .join("\n");

    return numbered;
  },
};

export const writeFileTool: ToolHandler = {
  definition: {
    name: "write_file",
    description:
      "Write content to a file in the workspace (user-space/workspace/). " +
      "Creates parent directories if needed. Overwrites existing files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to workspace root",
        },
        content: {
          type: "string",
          description: "Content to write",
        },
      },
      required: ["path", "content"],
    },
  },

  async execute(args) {
    const userPath = args.path as string;
    const content = args.content as string;
    const absPath = resolveSafe(userPath);
    if (!absPath) return JSON.stringify({ error: "Path traversal not allowed" });

    const dir = absPath.substring(0, absPath.lastIndexOf("/"));
    const { mkdirSync } = await import("node:fs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    await Bun.write(absPath, content);
    return JSON.stringify({
      written: userPath,
      bytes: content.length,
    });
  },
};

export const listFilesTool: ToolHandler = {
  definition: {
    name: "list_files",
    description:
      "List files and directories in the workspace (user-space/workspace/).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to workspace root. Defaults to '.'",
        },
      },
      required: [],
    },
  },

  async execute(args) {
    const userPath = (args.path as string) || ".";
    const absPath = resolveSafe(userPath);
    if (!absPath) return JSON.stringify({ error: "Path traversal not allowed" });
    if (!existsSync(absPath)) return JSON.stringify({ error: `Directory not found: ${userPath}` });

    const entries = readdirSync(absPath, { withFileTypes: true });
    const listing = entries.map((e) => {
      const prefix = e.isDirectory() ? "📁" : "📄";
      let size = "";
      if (e.isFile()) {
        const stat = statSync(resolve(absPath, e.name));
        size = ` (${stat.size}B)`;
      }
      return `${prefix} ${e.name}${size}`;
    });

    return listing.join("\n") || "(empty directory)";
  },
};
