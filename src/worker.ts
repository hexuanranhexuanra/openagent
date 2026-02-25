/**
 * Worker 独立进程入口
 *
 * 由 PM2 独立启动，负责消费 Bunqueue 中的任务，
 * 执行 Agent 循环（LLM 调用 + 工具执行），
 * 并将结果通过回调推送回消息渠道。
 */
import { loadConfig } from "./config";
import { setLogLevel, createLogger } from "./logger";
import { initAgent } from "./agent";
import { initQueue, initWorker, onJobStream, shutdownQueue } from "./queue";
import type { JobStreamEvent } from "./queue";
import { auditLog } from "./audit";

const log = createLogger("worker");

async function main() {
  const config = loadConfig();
  setLogLevel(config.logging.level);

  log.info("Worker process starting", { pid: process.pid });

  initAgent();
  await initQueue();

  // Stream callback: forward results to the appropriate channel
  onJobStream((streamEvent: JobStreamEvent) => {
    const { taskId, jobData, event } = streamEvent;

    switch (event.type) {
      case "text":
        // In a full implementation, this would push text chunks
        // back to the originating channel (Feishu, Telegram, WebSocket, etc.)
        break;

      case "tool_start":
        auditLog({
          taskId,
          action: "tool_call",
          who: jobData.peerId,
          channel: jobData.channel,
          detail: { tool: event.toolName, args: event.toolArgs },
        });
        break;

      case "tool_result":
        auditLog({
          taskId,
          action: "tool_result",
          who: jobData.peerId,
          channel: jobData.channel,
          detail: { tool: event.toolName, result: event.toolResult?.slice(0, 500) },
        });
        break;

      case "done":
        auditLog({
          taskId,
          action: "task_complete",
          who: jobData.peerId,
          channel: jobData.channel,
          detail: { usage: event.usage },
        });
        break;

      case "error":
        auditLog({
          taskId,
          action: "task_error",
          who: jobData.peerId,
          channel: jobData.channel,
          detail: { error: event.error },
        });
        break;
    }
  });

  await initWorker();

  log.info("Worker ready, consuming queue", { pid: process.pid });

  // Graceful shutdown
  const shutdown = async () => {
    log.info("Worker shutting down...");
    await shutdownQueue();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("Worker startup failed", { error: String(err) });
  process.exit(1);
});
