import type { ToolHandler } from "../../../types";

export const shellTool: ToolHandler = {
  definition: {
    name: "run_shell",
    description:
      "Execute a shell command on the host machine. Returns stdout, stderr, and exit code. " +
      "Default working directory is the project root (where openagent.json lives). " +
      "Timeout is 10 seconds by default — keep commands short. " +
      "WARNING: Do NOT use 'find' without '-maxdepth' — it will scan the entire disk and hang. " +
      "Do NOT start/restart the gateway server (bun run start/daemon/dev) — " +
      "those are long-running processes. Use write_config for config changes.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        cwd: {
          type: "string",
          description:
            "Working directory. Defaults to the project root directory.",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds. Defaults to 10000.",
        },
      },
      required: ["command"],
    },
  },

  async execute(args) {
    const command = args.command as string;
    const cwd = (args.cwd as string) || process.cwd();
    const timeout = (args.timeout as number) || 10_000;

    try {
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), timeout);

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      clearTimeout(timeoutId);
      const exitCode = await proc.exited;

      return JSON.stringify({
        exitCode,
        stdout: stdout.slice(0, 10_000),
        stderr: stderr.slice(0, 5_000),
      });
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
