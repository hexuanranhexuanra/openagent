import type { ToolHandler } from "../../../types";

export const shellTool: ToolHandler = {
  definition: {
    name: "run_shell",
    description:
      "Execute a shell command on the host machine. Use with caution. Returns stdout, stderr, and exit code.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        cwd: {
          type: "string",
          description: "Working directory for the command. Defaults to home directory.",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds. Defaults to 30000.",
        },
      },
      required: ["command"],
    },
  },

  async execute(args) {
    const command = args.command as string;
    const cwd = (args.cwd as string) || process.env.HOME || "/tmp";
    const timeout = (args.timeout as number) || 30_000;

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
