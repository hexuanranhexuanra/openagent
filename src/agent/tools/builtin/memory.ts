import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { resolve, join, relative, normalize } from "node:path";
import type { ToolHandler } from "../../../types";

const MEMORIES_ROOT = resolve(process.cwd(), "data", "memories");

function ensureRoot(peerId: string): string {
  const userDir = resolve(MEMORIES_ROOT, sanitizePath(peerId));
  if (!existsSync(userDir)) {
    mkdirSync(userDir, { recursive: true });
  }
  return userDir;
}

function sanitizePath(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_\-.:@]/g, "_");
}

function resolveSafe(root: string, userPath: string): string | null {
  const normalized = normalize(userPath).replace(/^\/+/, "");
  const full = resolve(root, normalized);
  if (!full.startsWith(root)) return null;
  return full;
}

function formatWithLineNumbers(content: string): string {
  const lines = content.split("\n");
  return lines
    .map((line, i) => {
      const num = String(i + 1).padStart(6, " ");
      return `${num}\t${line}`;
    })
    .join("\n");
}

export const memoryTool: ToolHandler = {
  definition: {
    name: "memory",
    description:
      "Read and write to a persistent memory filesystem at /memories/. " +
      "Use this to store and recall user preferences, notes, conversation summaries, " +
      "and other information across sessions. " +
      "Commands: view, create, edit, delete, ls.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["view", "create", "edit", "delete", "ls"],
          description: "The memory operation to perform",
        },
        path: {
          type: "string",
          description: "File path relative to /memories/ (e.g. 'user_preferences.md')",
        },
        content: {
          type: "string",
          description: "File content (for create and edit commands)",
        },
        peerId: {
          type: "string",
          description: "User identifier for workspace isolation",
        },
      },
      required: ["command", "path"],
    },
  },

  async execute(args) {
    const command = args.command as string;
    const rawPath = args.path as string;
    const content = args.content as string | undefined;
    const peerId = (args.peerId as string) || "default";

    const root = ensureRoot(peerId);
    const filePath = resolveSafe(root, rawPath);

    if (!filePath) {
      return "Error: Invalid path. Path traversal is not allowed.";
    }

    switch (command) {
      case "view": {
        if (!existsSync(filePath)) {
          return `Error: File not found: /memories/${rawPath}`;
        }
        const data = readFileSync(filePath, "utf-8");
        const numbered = formatWithLineNumbers(data);
        return `Here's the content of /memories/${rawPath} with line numbers:\n${numbered}`;
      }

      case "create": {
        if (!content) {
          return "Error: 'content' is required for create command.";
        }
        if (existsSync(filePath)) {
          return `Error: File already exists: /memories/${rawPath}. Use 'edit' to update.`;
        }
        const dir = filePath.substring(0, filePath.lastIndexOf("/"));
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(filePath, content, "utf-8");
        return `Created /memories/${rawPath} (${content.length} bytes)`;
      }

      case "edit": {
        if (!content) {
          return "Error: 'content' is required for edit command.";
        }
        if (!existsSync(filePath)) {
          return `Error: File not found: /memories/${rawPath}. Use 'create' first.`;
        }
        writeFileSync(filePath, content, "utf-8");
        return `Updated /memories/${rawPath} (${content.length} bytes)`;
      }

      case "delete": {
        if (!existsSync(filePath)) {
          return `Error: File not found: /memories/${rawPath}`;
        }
        unlinkSync(filePath);
        return `Deleted /memories/${rawPath}`;
      }

      case "ls": {
        const targetDir = existsSync(filePath) && statSync(filePath).isDirectory()
          ? filePath
          : root;

        const entries = readdirSync(targetDir, { withFileTypes: true });
        if (entries.length === 0) {
          return `Directory /memories/${relative(root, targetDir) || "."} is empty.`;
        }

        const listing = entries.map((e) => {
          const prefix = e.isDirectory() ? "[dir]  " : "[file] ";
          const fullPath = join(targetDir, e.name);
          let sizeInfo = "";
          if (e.isFile()) {
            const stat = statSync(fullPath);
            sizeInfo = ` (${stat.size} bytes)`;
          }
          return `  ${prefix}${e.name}${sizeInfo}`;
        });

        const relDir = relative(root, targetDir) || ".";
        return `Contents of /memories/${relDir}:\n${listing.join("\n")}`;
      }

      default:
        return `Error: Unknown command '${command}'. Use: view, create, edit, delete, ls.`;
    }
  },
};
