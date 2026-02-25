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
import type { JobStreamEvent, MessageJobData } from "./queue";
import { feishuReply } from "./channels/feishu-api";
import { auditLog } from "./audit";

const log = createLogger("worker");

// Accumulate text chunks per task, flush on "done"
const textBuffers = new Map<string, { chunks: string[]; jobData: MessageJobData }>();

async function deliverToChannel(taskId: string, jobData: MessageJobData, text: string) {
  const config = loadConfig();

  if (jobData.channel === "feishu") {
    const feishuCfg = config.channels.feishu;
    if (!feishuCfg.appId || !feishuCfg.appSecret) {
      log.warn("Feishu appId/appSecret not configured, cannot reply", { taskId });
      return;
    }
    const ok = await feishuReply(feishuCfg.appId, feishuCfg.appSecret, {
      messageId: jobData.feishuMessageId,
      receiveId: jobData.peerId,
      text,
    });
    if (!ok) log.error("Feishu reply delivery failed", { taskId });
    return;
  }

  // Other channels (telegram, webchat, etc.) would be handled here
  log.debug("No delivery handler for channel", { channel: jobData.channel, taskId });
}

async function main() {
  const config = loadConfig();
  setLogLevel(config.logging.level);

  log.info("Worker process starting", { pid: process.pid });

  initAgent();
  await initQueue();

  onJobStream((streamEvent: JobStreamEvent) => {
    const { taskId, jobData, event } = streamEvent;

    switch (event.type) {
      case "text": {
        let buf = textBuffers.get(taskId);
        if (!buf) {
          buf = { chunks: [], jobData };
          textBuffers.set(taskId, buf);
        }
        if (event.content) buf.chunks.push(event.content);
        break;
      }

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

      case "done": {
        auditLog({
          taskId,
          action: "task_complete",
          who: jobData.peerId,
          channel: jobData.channel,
          detail: { usage: event.usage },
        });

        const buf = textBuffers.get(taskId);
        if (buf && buf.chunks.length > 0) {
          const fullText = buf.chunks.join("");
          deliverToChannel(taskId, buf.jobData, fullText).catch((err) =>
            log.error("Delivery error", { taskId, error: String(err) }),
          );
        }
        textBuffers.delete(taskId);
        break;
      }

      case "error":
        auditLog({
          taskId,
          action: "task_error",
          who: jobData.peerId,
          channel: jobData.channel,
          detail: { error: event.error },
        });
        textBuffers.delete(taskId);
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
