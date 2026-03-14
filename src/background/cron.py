"""Cron service — scheduled agent tasks with 5-field cron parser, matching TS background/cron.ts."""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from secrets import token_hex

from src.utils.logger import create_logger

log = create_logger("background:cron")

JOBS_DIR = Path("user-space/cron")
JOBS_FILE = JOBS_DIR / "jobs.json"


def _parse_field(field: str, min_val: int, max_val: int) -> list[int]:
    """Parse a single cron field into list of valid values."""
    values: set[int] = set()
    for part in field.split(","):
        part = part.strip()
        if part == "*":
            values.update(range(min_val, max_val + 1))
        elif part.startswith("*/"):
            step = int(part[2:])
            values.update(range(min_val, max_val + 1, step))
        elif "-" in part:
            start, end = part.split("-", 1)
            values.update(range(int(start), int(end) + 1))
        else:
            values.add(int(part))
    return sorted(v for v in values if min_val <= v <= max_val)


def next_run_date(cron_expr: str, from_dt: datetime | None = None) -> datetime | None:
    """Compute the next trigger time for a 5-field cron expression."""
    fields = cron_expr.strip().split()
    if len(fields) != 5:
        raise ValueError(f"Invalid cron expression: {cron_expr}. Expected 5 fields.")

    minutes = _parse_field(fields[0], 0, 59)
    hours = _parse_field(fields[1], 0, 23)
    doms = _parse_field(fields[2], 1, 31)
    months = _parse_field(fields[3], 1, 12)
    dows = _parse_field(fields[4], 0, 6)

    dt = (from_dt or datetime.now(timezone.utc)) + timedelta(minutes=1)
    dt = dt.replace(second=0, microsecond=0)

    # Brute-force scan up to 1 year
    end = dt + timedelta(days=366)
    while dt < end:
        if (
            dt.month in months
            and dt.day in doms
            and dt.weekday() in [d % 7 for d in dows]
            and dt.hour in hours
            and dt.minute in minutes
        ):
            return dt
        dt += timedelta(minutes=1)

    return None


class CronService:
    def __init__(self) -> None:
        self._jobs: dict[str, dict] = {}
        self._running: set[str] = set()
        self._task: asyncio.Task | None = None
        JOBS_DIR.mkdir(parents=True, exist_ok=True)
        self._load_jobs()

    def _load_jobs(self) -> None:
        if JOBS_FILE.exists():
            try:
                data = json.loads(JOBS_FILE.read_text(encoding="utf-8"))
                for job in data:
                    self._jobs[job["id"]] = job
            except Exception:
                pass

    def _save_jobs(self) -> None:
        JOBS_FILE.write_text(
            json.dumps(list(self._jobs.values()), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    def start(self) -> None:
        if self._task:
            return
        self._task = asyncio.get_event_loop().create_task(self._tick_loop())
        log.info("Cron service started", {"jobs": len(self._jobs)})

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None

    def add_job(
        self,
        name: str,
        cron_expr: str,
        task: str,
        target_channel: str = "webchat",
        target_peer: str = "broadcast",
    ) -> dict:
        # Validate cron expression
        nrd = next_run_date(cron_expr)
        if not nrd:
            raise ValueError(f"Invalid cron expression: {cron_expr}")

        job_id = token_hex(4)
        job = {
            "id": job_id,
            "name": name,
            "cron": cron_expr,
            "task": task,
            "targetChannel": target_channel,
            "targetPeer": target_peer,
            "enabled": True,
            "lastRunAt": None,
            "nextRunAt": nrd.isoformat(),
        }
        self._jobs[job_id] = job
        self._save_jobs()
        log.info("Cron job added", {"id": job_id, "name": name})
        return job

    def remove_job(self, job_id: str) -> bool:
        if job_id in self._jobs:
            del self._jobs[job_id]
            self._save_jobs()
            return True
        return False

    def list_jobs(self) -> list[dict]:
        return [
            {**j, "task": j["task"][:100]} for j in self._jobs.values()
        ]

    async def trigger_now(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job:
            return False
        await self._execute_job(job)
        return True

    async def _tick_loop(self) -> None:
        while True:
            await asyncio.sleep(1)
            now = datetime.now(timezone.utc)
            for job in list(self._jobs.values()):
                if not job.get("enabled"):
                    continue
                if job["id"] in self._running:
                    continue
                next_at = job.get("nextRunAt")
                if next_at and datetime.fromisoformat(next_at) <= now:
                    asyncio.get_event_loop().create_task(self._execute_job(job))

    async def _execute_job(self, job: dict) -> None:
        job_id = job["id"]
        if job_id in self._running:
            return
        self._running.add(job_id)

        try:
            log.info("Cron job executing", {"id": job_id, "name": job["name"]})

            from src.agents.init import run_agent
            from src.background.outbox import get_outbox

            text_parts: list[str] = []
            async for event in run_agent("cron", f"cron:{job_id}", job["task"]):
                if event.type == "text" and event.content:
                    text_parts.append(event.content)

            result = "".join(text_parts)
            if result:
                await get_outbox().push(
                    "cron",
                    {"channel": job.get("targetChannel", "webchat"), "peerId": job.get("targetPeer", "broadcast")},
                    result,
                    job_id,
                )

            job["lastRunAt"] = datetime.now(timezone.utc).isoformat()
            nrd = next_run_date(job["cron"])
            job["nextRunAt"] = nrd.isoformat() if nrd else None
            self._save_jobs()

        except Exception as e:
            log.warn("Cron job failed", {"id": job_id, "error": str(e)})
        finally:
            self._running.discard(job_id)


_service: CronService | None = None


def get_cron_service() -> CronService:
    global _service
    if _service is None:
        _service = CronService()
    return _service
