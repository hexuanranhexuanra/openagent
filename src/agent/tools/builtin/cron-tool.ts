import type { ToolHandler } from "../../../types/index";
import { getCronService } from "../../../background/cron";

export const cronTool: ToolHandler = {
  definition: {
    name: "cron",
    description:
      "Manage scheduled agent tasks (cron jobs). " +
      "Use this to schedule recurring work: daily digests, periodic checks, reminders. " +
      "Actions: add, remove, list, trigger.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "remove", "list", "trigger"],
          description: "Operation to perform",
        },
        name: {
          type: "string",
          description: "[add] Human-readable job name",
        },
        cron_expr: {
          type: "string",
          description:
            "[add] Standard 5-field cron expression: 'min hour dom month dow'. " +
            "Examples: '*/30 * * * *' (every 30 min), '0 9 * * *' (daily at 9am), '0 9 * * 1' (every Monday 9am)",
        },
        task: {
          type: "string",
          description: "[add] Natural language instruction the agent will execute on schedule",
        },
        target_channel: {
          type: "string",
          enum: ["webchat", "feishu"],
          description: "[add] Where to deliver the output (default: webchat)",
        },
        target_peer: {
          type: "string",
          description:
            "[add] Target peer ID for feishu (open_id or chat_id). Not needed for webchat.",
        },
        job_id: {
          type: "string",
          description: "[remove, trigger] ID of the job to operate on",
        },
      },
      required: ["action"],
    },
  },

  async execute(args) {
    const action = args.action as string;
    const svc = getCronService();

    switch (action) {
      case "add": {
        const name = args.name as string;
        const cronExpr = args.cron_expr as string;
        const task = args.task as string;
        const channel = (args.target_channel as "webchat" | "feishu") ?? "webchat";
        const peerId = (args.target_peer as string) ?? "broadcast";

        if (!name || !cronExpr || !task) {
          return JSON.stringify({ error: "add requires: name, cron_expr, task" });
        }

        try {
          const job = svc.addJob({ name, cron: cronExpr, task, target: { channel, peerId } });
          return JSON.stringify({
            added: true,
            job: { id: job.id, name: job.name, cron: job.cron, nextRunAt: new Date(job.nextRunAt).toISOString() },
          });
        } catch (err) {
          return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }
      }

      case "remove": {
        const jobId = args.job_id as string;
        if (!jobId) return JSON.stringify({ error: "remove requires: job_id" });
        const removed = svc.removeJob(jobId);
        return JSON.stringify({ removed, jobId });
      }

      case "list": {
        const jobs = svc.listJobs().map((j) => ({
          id: j.id,
          name: j.name,
          cron: j.cron,
          task: j.task.slice(0, 100),
          enabled: j.enabled,
          lastRunAt: j.lastRunAt ? new Date(j.lastRunAt).toISOString() : null,
          nextRunAt: new Date(j.nextRunAt).toISOString(),
        }));
        return JSON.stringify({ jobs, count: jobs.length });
      }

      case "trigger": {
        const jobId = args.job_id as string;
        if (!jobId) return JSON.stringify({ error: "trigger requires: job_id" });
        const triggered = await svc.triggerNow(jobId);
        return JSON.stringify({ triggered, jobId });
      }

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  },
};
