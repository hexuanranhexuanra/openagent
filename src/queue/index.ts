import { Queue, Worker, type Job } from "bunqueue";
import { createLogger } from "../logger";
import { runAgent, type AgentStreamEvent } from "../agent";

const log = createLogger("queue");

let messageQueue: Queue | null = null;
let messageWorker: Worker | null = null;

interface MessageJobData {
  channel: string;
  peerId: string;
  content: string;
  wsClientId?: string;
}

type OnStreamCallback = (
  jobData: MessageJobData,
  event: AgentStreamEvent,
) => void;

let streamCallback: OnStreamCallback | null = null;

export function onJobStream(cb: OnStreamCallback): void {
  streamCallback = cb;
}

export async function initQueue(): Promise<void> {
  messageQueue = new Queue("messages", {
    connection: { mode: "embedded" },
  });

  messageWorker = new Worker(
    "messages",
    async (job: Job<MessageJobData>) => {
      const { channel, peerId, content, wsClientId } = job.data;
      log.info("Processing message job", { jobId: job.id, channel, peerId });

      try {
        const stream = runAgent(channel, peerId, content);
        for await (const event of stream) {
          if (streamCallback) {
            streamCallback({ channel, peerId, content, wsClientId }, event);
          }
        }
      } catch (err) {
        log.error("Job processing failed", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    {
      connection: { mode: "embedded" },
      concurrency: 1,
    },
  );

  messageWorker.on("completed", (job: Job) => {
    log.debug("Job completed", { jobId: job.id });
  });

  messageWorker.on("failed", (job: Job | undefined, err: Error) => {
    log.error("Job failed", {
      jobId: job?.id,
      error: err.message,
    });
  });

  log.info("Message queue initialized (embedded mode)");
}

export async function enqueueMessage(data: MessageJobData): Promise<string> {
  if (!messageQueue) {
    throw new Error("Queue not initialized");
  }

  const job = await messageQueue.add("chat", data, {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  });

  log.debug("Message enqueued", { jobId: job.id });
  return job.id ?? "unknown";
}

export async function shutdownQueue(): Promise<void> {
  if (messageWorker) {
    await messageWorker.close();
  }
  if (messageQueue) {
    await messageQueue.close();
  }
  log.info("Queue shut down");
}
