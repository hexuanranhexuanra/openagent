import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config";
import { setLogLevel } from "../logger";
import { initAgent, runAgent } from "../agent";
import { startGateway } from "../gateway/server";
import { resetSession } from "../sessions/manager";

export function createCli(): Command {
  const program = new Command();

  program
    .name("openagent")
    .description("OpenAgent — Self-evolving personal AI assistant")
    .version("0.2.0");

  // ─── Gateway Server ───

  program
    .command("gateway")
    .description("Start the OpenAgent gateway server")
    .option("-p, --port <port>", "Gateway port")
    .option("-H, --host <host>", "Gateway host")
    .option("-v, --verbose", "Enable verbose logging")
    .action(async (opts) => {
      if (opts.port) process.env.GATEWAY_PORT = opts.port;
      if (opts.host) process.env.GATEWAY_HOST = opts.host;

      const config = loadConfig();
      setLogLevel(opts.verbose ? "debug" : config.logging.level);
      initAgent();

      const server = startGateway();

      // Start Feishu WebSocket if credentials are configured
      const feishuAppId = config.channels.feishu.appId || process.env.LARK_APP_ID;
      const feishuAppSecret = config.channels.feishu.appSecret || process.env.LARK_APP_SECRET;
      let feishuConnected = false;
      if (feishuAppId && feishuAppSecret) {
        const { startFeishuWS } = await import("../channels/feishu-ws.js");
        startFeishuWS({ appId: feishuAppId, appSecret: feishuAppSecret });
        feishuConnected = true;
      }

      console.log("");
      console.log(chalk.bold("  🤖 OpenAgent Gateway"));
      console.log(chalk.gray("  ─────────────────────────────────"));
      console.log(`  ${chalk.green("HTTP")}    http://${server.hostname}:${server.port}`);
      console.log(`  ${chalk.blue("WS")}      ws://${server.hostname}:${server.port}/ws`);
      console.log(`  ${chalk.magenta("WebChat")} http://${server.hostname}:${server.port}/`);
      console.log(chalk.gray("  ─────────────────────────────────"));
      const { getProviderName } = await import("../agent/index.js");
      console.log(`  Provider: ${chalk.yellow(getProviderName())}`);
      if (feishuConnected) {
        console.log(`  Feishu:   ${chalk.green("connected")} (WebSocket)`);
      }
      console.log(`  PID:      ${chalk.cyan(String(process.pid))}`);
      console.log("");

      const shutdown = () => {
        console.log("\n  Shutting down...");
        if (feishuConnected) {
          import("../channels/feishu-ws.js").then(({ stopFeishuWS }) => stopFeishuWS());
        }
        server.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });

  // ─── Interactive Chat REPL ───

  program
    .command("chat")
    .description("Start an interactive chat session with the agent")
    .option("-s, --session <id>", "Session ID (default: cli:repl)")
    .option("-v, --verbose", "Show tool calls and debug info")
    .action(async (opts) => {
      const config = loadConfig();
      setLogLevel(opts.verbose ? "debug" : "warn");
      initAgent();

      const sessionId = opts.session ?? "repl";

      console.log("");
      console.log(chalk.bold("  🤖 OpenAgent Chat"));
      console.log(chalk.gray("  ─────────────────────────────────"));
      console.log(chalk.gray("  Type your message and press Enter."));
      console.log(chalk.gray("  Commands: /reset /exit /tools /memory"));
      console.log(chalk.gray("  ─────────────────────────────────"));
      console.log("");

      const prompt = () => process.stdout.write(chalk.green("→ "));

      prompt();

      for await (const line of readLines()) {
        const input = line.trim();
        if (!input) {
          prompt();
          continue;
        }

        // Slash commands
        if (input.startsWith("/")) {
          await handleSlashCommand(input, sessionId, opts.verbose);
          prompt();
          continue;
        }

        // Run agent
        process.stdout.write("\n");
        try {
          const stream = runAgent("cli", `cli:${sessionId}`, input);
          for await (const event of stream) {
            switch (event.type) {
              case "text":
                process.stdout.write(event.content ?? "");
                break;
              case "tool_start":
                if (opts.verbose) {
                  process.stderr.write(
                    chalk.gray(`\n  ⚙ ${event.toolName}(${JSON.stringify(event.toolArgs).slice(0, 100)})\n`),
                  );
                }
                break;
              case "tool_result":
                if (opts.verbose) {
                  const preview = (event.toolResult ?? "").slice(0, 200);
                  process.stderr.write(chalk.gray(`  ↪ ${preview}\n`));
                }
                break;
              case "error":
                process.stderr.write(chalk.red(`\n  Error: ${event.error}\n`));
                break;
              case "done":
                break;
            }
          }
        } catch (err) {
          process.stderr.write(
            chalk.red(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`),
          );
        }

        process.stdout.write("\n\n");
        prompt();
      }
    });

  // ─── One-shot Agent ───

  program
    .command("agent")
    .description("Send a one-shot message to the agent")
    .requiredOption("-m, --message <text>", "Message to send")
    .action(async (opts) => {
      loadConfig();
      initAgent();

      const stream = runAgent("cli", "cli-oneshot", opts.message);
      for await (const event of stream) {
        switch (event.type) {
          case "text":
            process.stdout.write(event.content ?? "");
            break;
          case "tool_start":
            process.stderr.write(chalk.gray(`\n[tool: ${event.toolName}]\n`));
            break;
          case "tool_result":
            process.stderr.write(
              chalk.gray(`[result: ${(event.toolResult ?? "").slice(0, 200)}]\n`),
            );
            break;
          case "error":
            process.stderr.write(chalk.red(`\nError: ${event.error}\n`));
            break;
          case "done":
            process.stdout.write("\n");
            break;
        }
      }
    });

  // ─── Status ───

  program
    .command("status")
    .description("Check gateway status")
    .option("-p, --port <port>", "Gateway port")
    .action(async (opts) => {
      const port = opts.port || process.env.GATEWAY_PORT || "19090";
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        const data = await res.json();
        console.log(chalk.green("  Gateway is running"));
        console.log(JSON.stringify(data, null, 2));
      } catch {
        console.log(chalk.red("  Gateway is not running"));
        process.exit(1);
      }
    });

  // ─── Doctor ───

  program
    .command("doctor")
    .description("Check configuration and environment")
    .action(async () => {
      console.log(chalk.bold("\n  🩺 OpenAgent Doctor\n"));

      console.log(`  Bun:       ${chalk.green(Bun.version)}`);

      try {
        const config = loadConfig();
        console.log(`  Config:    ${chalk.green("loaded")}`);
        console.log(`  Provider:  ${chalk.yellow(config.agent.defaultProvider)}`);

        const providerKey =
          config.agent.defaultProvider === "openai"
            ? config.providers.openai.apiKey
            : config.providers.anthropic.apiKey;

        console.log(
          `  API Key:   ${providerKey ? chalk.green("set (" + providerKey.slice(0, 8) + "...)") : chalk.red("NOT SET")}`,
        );
      } catch (err) {
        console.log(`  Config:    ${chalk.red("error")} - ${err}`);
      }

      // Check memory files
      const { existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      for (const file of ["SOUL.md", "USER.md", "WORLD.md"]) {
        const path = resolve(process.cwd(), "user-space", "memory", file);
        const exists = existsSync(path);
        console.log(
          `  ${file.padEnd(10)} ${exists ? chalk.green("✓") : chalk.yellow("missing")}`,
        );
      }

      // Check PM2
      try {
        const proc = Bun.spawnSync(["pm2", "--version"]);
        const version = new TextDecoder().decode(proc.stdout).trim();
        console.log(`  PM2:       ${chalk.green(version)}`);
      } catch {
        console.log(`  PM2:       ${chalk.yellow("not found (optional)")}`);
      }

      console.log("");
    });

  return program;
}

// ─── Helpers ───

async function handleSlashCommand(
  input: string,
  sessionId: string,
  verbose: boolean,
): Promise<void> {
  const cmd = input.split(" ")[0].toLowerCase();

  switch (cmd) {
    case "/exit":
    case "/quit":
      console.log(chalk.gray("\n  Bye!\n"));
      process.exit(0);

    case "/reset":
      resetSession(`cli:cli:${sessionId}`);
      console.log(chalk.yellow("  Session reset.\n"));
      break;

    case "/tools": {
      const { getAllToolDefinitions } = await import("../agent/tools/registry");
      const tools = getAllToolDefinitions();
      console.log(chalk.bold(`\n  Available tools (${tools.length}):\n`));
      for (const t of tools) {
        console.log(`  ${chalk.cyan(t.name.padEnd(20))} ${chalk.gray(t.description.slice(0, 60))}`);
      }
      console.log("");
      break;
    }

    case "/memory": {
      const { getMemoryStore } = await import("../evolution/memory");
      const memory = getMemoryStore();
      const { soul, user, world } = await memory.readAll();
      console.log(chalk.bold("\n  📝 Memory Status:"));
      console.log(`  SOUL.md:  ${chalk.gray(soul.length + " bytes")}`);
      console.log(`  USER.md:  ${chalk.gray(user.length + " bytes")}`);
      console.log(`  WORLD.md: ${chalk.gray(world.length + " bytes")}`);
      console.log("");
      break;
    }

    case "/skills": {
      const { getSkillLoader } = await import("../evolution/skill-loader");
      const loader = getSkillLoader();
      const files = loader.listSkillFiles();
      if (files.length === 0) {
        console.log(chalk.gray("  No skills loaded.\n"));
      } else {
        console.log(chalk.bold(`\n  Skills (${files.length}):`));
        for (const f of files) {
          console.log(`  ${chalk.cyan(f)}`);
        }
        console.log("");
      }
      break;
    }

    default:
      console.log(chalk.gray(`  Unknown command: ${cmd}\n`));
  }
}

async function* readLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder();

  // Use Bun's stdin reader for efficient line reading
  const reader = Bun.stdin.stream().getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
    }
  }

  if (buffer.length > 0) {
    yield buffer;
  }
}
