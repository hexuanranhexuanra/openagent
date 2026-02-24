import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, getConfig } from "../config";
import { setLogLevel } from "../logger";
import { initAgent } from "../agent";
import { startGateway } from "../gateway/server";

export function createCli(): Command {
  const program = new Command();

  program
    .name("openagent")
    .description("OpenAgent - Your personal AI assistant gateway")
    .version("0.1.0");

  program
    .command("gateway")
    .description("Start the OpenAgent gateway server")
    .option("-p, --port <port>", "Gateway port", "18789")
    .option("-H, --host <host>", "Gateway host", "127.0.0.1")
    .option("-v, --verbose", "Enable verbose logging")
    .action(async (opts) => {
      if (opts.port) process.env.GATEWAY_PORT = opts.port;
      if (opts.host) process.env.GATEWAY_HOST = opts.host;

      const config = loadConfig();

      if (opts.verbose) {
        setLogLevel("debug");
      } else {
        setLogLevel(config.logging.level);
      }

      initAgent();

      const server = startGateway();

      console.log("");
      console.log(chalk.bold("  OpenAgent Gateway"));
      console.log(chalk.gray("  ─────────────────────────────────"));
      console.log(`  ${chalk.green("HTTP")}    http://${server.hostname}:${server.port}`);
      console.log(`  ${chalk.blue("WS")}      ws://${server.hostname}:${server.port}/ws`);
      console.log(`  ${chalk.magenta("WebChat")} http://${server.hostname}:${server.port}/`);
      console.log(chalk.gray("  ─────────────────────────────────"));
      console.log(`  Provider: ${chalk.yellow(config.agent.defaultProvider)}`);
      console.log(`  PID:      ${chalk.cyan(String(process.pid))}`);
      console.log("");

      const shutdown = () => {
        console.log("\n  Shutting down...");
        server.stop();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });

  program
    .command("agent")
    .description("Send a one-shot message to the agent")
    .requiredOption("-m, --message <text>", "Message to send")
    .action(async (opts) => {
      loadConfig();
      initAgent();

      const { runAgent } = await import("../agent");
      const stream = runAgent("cli", "cli-user", opts.message);

      for await (const event of stream) {
        switch (event.type) {
          case "text":
            process.stdout.write(event.content ?? "");
            break;
          case "tool_start":
            process.stderr.write(
              chalk.gray(`\n[tool: ${event.toolName}]\n`),
            );
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

  program
    .command("status")
    .description("Check gateway status")
    .option("-p, --port <port>", "Gateway port", "18789")
    .action(async (opts) => {
      try {
        const res = await fetch(`http://127.0.0.1:${opts.port}/api/health`);
        const data = await res.json();
        console.log(chalk.green("Gateway is running"));
        console.log(JSON.stringify(data, null, 2));
      } catch {
        console.log(chalk.red("Gateway is not running"));
        process.exit(1);
      }
    });

  program
    .command("doctor")
    .description("Check configuration and environment")
    .action(async () => {
      console.log(chalk.bold("\n  OpenAgent Doctor\n"));

      // Check Bun
      console.log(`  Bun version: ${chalk.green(Bun.version)}`);

      // Check config
      try {
        const config = loadConfig();
        console.log(`  Config:      ${chalk.green("loaded")}`);
        console.log(`  Provider:    ${chalk.yellow(config.agent.defaultProvider)}`);

        const providerKey =
          config.agent.defaultProvider === "openai"
            ? config.providers.openai.apiKey
            : config.providers.anthropic.apiKey;

        if (providerKey) {
          console.log(`  API Key:     ${chalk.green("set")} (${providerKey.slice(0, 8)}...)`);
        } else {
          console.log(`  API Key:     ${chalk.red("NOT SET")}`);
        }
      } catch (err) {
        console.log(`  Config:      ${chalk.red("error")} - ${err}`);
      }

      // Check PM2
      try {
        const proc = Bun.spawnSync(["pm2", "--version"]);
        const version = new TextDecoder().decode(proc.stdout).trim();
        console.log(`  PM2:         ${chalk.green(version)}`);
      } catch {
        console.log(`  PM2:         ${chalk.yellow("not found (optional)")}`);
      }

      console.log("");
    });

  return program;
}
