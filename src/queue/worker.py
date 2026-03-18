"""Async queue-based job processing, matching TS queue/index.ts."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from secrets import token_hex
from typing import Callable, Awaitable

from src.utils.logger import create_logger

log = create_logger("queue")


@dataclass
class MessageJob:
    task_id: str
    channel: str
    peer_id: str
    content: str
    ws_client_id: str | None = None
    feishu_message_id: str | None = None
    chat_id: str | None = None
    priority: int = 0

    @staticmethod
    def create(
        channel: str, peer_id: str, content: str, **kwargs
    ) -> MessageJob:
        return MessageJob(
            task_id=token_hex(5),
            channel=channel,
            peer_id=peer_id,
            content=content,
            **kwargs,
        )


StreamCallback = Callable[[dict], Awaitable[None]]

_queue: asyncio.Queue[MessageJob] | None = None
_workers: list[asyncio.Task] = []
_stream_callback: StreamCallback | None = None


async def init_queue() -> None:
    global _queue
    _queue = asyncio.Queue()


async def init_worker(concurrency: int = 2) -> None:
    for _ in range(concurrency):
        task = asyncio.get_event_loop().create_task(_worker_loop())
        _workers.append(task)
    log.info("Queue workers started", {"concurrency": concurrency})


def on_job_stream(callback: StreamCallback) -> None:
    global _stream_callback
    _stream_callback = callback


async def enqueue_message(job: MessageJob) -> None:
    if _queue is None:
        raise RuntimeError("Queue not initialized")
    await _queue.put(job)
    log.debug("Job enqueued", {"taskId": job.task_id, "channel": job.channel})


async def _worker_loop() -> None:
    from src.agents.init import run_agent

    while True:
        if _queue is None:
            await asyncio.sleep(1)
            continue

        job = await _queue.get()
        try:
            async for event in run_agent(job.channel, job.peer_id, job.content):
                if _stream_callback:
                    await _stream_callback({
                        "taskId": job.task_id,
                        "jobData": {
                            "channel": job.channel,
                            "peerId": job.peer_id,
                            "feishuMessageId": job.feishu_message_id,
                        },
                        "event": {
                            "type": event.type,
                            "content": event.content,
                            "toolName": event.tool_name,
                            "toolArgs": event.tool_args,
                            "toolResult": event.tool_result,
                            "error": event.error,
                        },
                    })
        except Exception as e:
            log.error("Worker error", {"taskId": job.task_id, "error": str(e)})
        finally:
            _queue.task_done()


async def shutdown_queue() -> None:
    for task in _workers:
        task.cancel()
    _workers.clear()
    log.info("Queue workers stopped")
