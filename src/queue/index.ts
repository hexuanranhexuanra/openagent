import { Queue, Worker, type Job } from "bunqueue/client";
import { createLogger } from "../logger";
import { runAgent, type AgentStreamEvent } from "../agent";

const log = createLogger("queue");

let messageQueue: Queue | null = null;
let messageWorker: Worker | null = null;

// ─── Job Types ───

export interface MessageJobData {
  taskId: string;
  channel: string;
  peerId: string;
  content: string;
  wsClientId?: string;
  /** Feishu original message_id for threaded reply */
  feishuMessageId?: string;
  /** Feishu chat_id for group chat scenarios */
  chatId?: string;
  priority?: "high" | "default" | "low";
  createdAt: number;
}

export interface JobStreamEvent {
  taskId: string;
  jobData: MessageJobData;
  event: AgentStreamEvent;
}

type OnStreamCallback = (streamEvent: JobStreamEvent) => void;

let streamCallback: OnStreamCallback | null = null;

export function onJobStream(cb: OnStreamCallback): void {
  streamCallback = cb;
}

// ─── Queue Init (used by both API and Worker) ───

export async function initQueue(): Promise<Queue> {
  if (messageQueue) return messageQueue;

  messageQueue = new Queue("messages", {
    connection: { mode: "embedded" },
  });

  log.info("Message queue initialized (embedded mode)");
  return messageQueue;
}

// ─── Worker Init (only used by Worker process) ───

export async function initWorker(): Promise<void> {
  if (!messageQueue) await initQueue();

  messageWorker = new Worker(
    "messages",
    async (job: Job<MessageJobData>) => {
      const { taskId, channel, peerId, content } = job.data;
      log.info("Processing job", { taskId, jobId: job.id, channel, peerId });

      try {
        const stream = runAgent(channel, peerId, content);
        for await (const event of stream) {
          if (streamCallback) {
            streamCallback({ taskId, jobData: job.data, event });
          }
        }
      } catch (err) {
        log.error("Job processing failed", {
          taskId,
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    {
      connection: { mode: "embedded" },
      concurrency: 2,
    },
  );

  messageWorker.on("completed", (job: Job) => {
    log.debug("Job completed", { jobId: job.id });
  });

  messageWorker.on("failed", (job: Job | undefined, err: Error) => {
    log.error("Job failed permanently (DLQ)", {
      jobId: job?.id,
      error: err.message,
    });
  });

  log.info("Worker initialized", { concurrency: 2 });
}

// ─── Enqueue (used by API process) ───

export async function enqueueMessage(data: MessageJobData): Promise<string> {
  const queue = await initQueue();

  const job = await queue.add("chat", data, {
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  });

  log.debug("Message enqueued", { taskId: data.taskId, jobId: job.id });
  return job.id ?? data.taskId;
}

// ─── Shutdown ───

export async function shutdownQueue(): Promise<void> {
  if (messageWorker) await messageWorker.close();
  if (messageQueue) await messageQueue.close();
  log.info("Queue shut down");
}
