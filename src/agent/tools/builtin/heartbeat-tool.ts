import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolHandler } from "../../../types/index";
import { getHeartbeatService } from "../../../background/heartbeat";

const HEARTBEAT_PATH = resolve(process.cwd(), "user-space", "memory", "HEARTBEAT.md");

export const heartbeatTool: ToolHandler = {
  definition: {
    name: "heartbeat",
    description:
      "Manage the heartbeat task list (HEARTBEAT.md). " +
      "The agent checks this file every 30 minutes and executes each unchecked '- [ ] task' line. " +
      "Use this to self-schedule future thinking, reminders, or proactive checks. " +
      "Actions: read, add, clear, tick (trigger immediately).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "add", "clear", "tick"],
          description: "Operation to perform",
        },
        task: {
          type: "string",
          description: "[add] Task description to schedule",
        },
      },
      required: ["action"],
    },
  },

  async execute(args) {
    const action = args.action as string;

    switch (action) {
      case "read": {
        if (!existsSync(HEARTBEAT_PATH)) {
          return JSON.stringify({ tasks: [], note: "HEARTBEAT.md not yet created" });
        }
        const text = readFileSync(HEARTBEAT_PATH, "utf-8");
        const tasks = text
          .split("\n")
          .filter((l) => /^-\s+\[\s+\]/.test(l))
          .map((l) => l.replace(/^-\s+\[\s+\]\s*/, "").trim());
        return JSON.stringify({ tasks, count: tasks.length });
      }

      case "add": {
        const task = args.task as string;
        if (!task?.trim()) return JSON.stringify({ error: "add requires: task" });

        const existing = existsSync(HEARTBEAT_PATH)
          ? readFileSync(HEARTBEAT_PATH, "utf-8")
          : "# Heartbeat Tasks\n\n";

        const newContent = existing.trimEnd() + `\n- [ ] ${task.trim()}\n`;
        writeFileSync(HEARTBEAT_PATH, newContent);
        return JSON.stringify({ added: true, task: task.trim() });
      }

      case "clear": {
        if (!existsSync(HEARTBEAT_PATH)) {
          return JSON.stringify({ cleared: 0 });
        }
        const text = readFileSync(HEARTBEAT_PATH, "utf-8");
        // Remove only unchecked items, keep checked ones and headings
        const lines = text.split("\n");
        let cleared = 0;
        const kept = lines.filter((l) => {
          if (/^-\s+\[\s+\]/.test(l)) { cleared++; return false; }
          return true;
        });
        writeFileSync(HEARTBEAT_PATH, kept.join("\n"));
        return JSON.stringify({ cleared });
      }

      case "tick": {
        // Trigger one heartbeat cycle immediately (async, fire-and-forget)
        getHeartbeatService().tick().catch(() => {});
        return JSON.stringify({ triggered: true, note: "Heartbeat tick started in background" });
      }

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  },
};
