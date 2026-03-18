"""JSONL audit logger, matching TS audit.ts. Daily-rotated files."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

AUDIT_DIR = Path.cwd() / "data" / "audit"

_initialized = False


def _ensure_dir() -> None:
    global _initialized
    if _initialized:
        return
    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    _initialized = True


def audit_log(
    *,
    task_id: str,
    action: str,
    who: str,
    channel: str,
    detail: dict | None = None,
) -> None:
    _ensure_dir()

    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y-%m-%d")
    file_path = AUDIT_DIR / f"audit-{date_str}.jsonl"

    entry: dict = {
        "ts": now.isoformat(),
        "taskId": task_id,
        "action": action,
        "who": who,
        "channel": channel,
    }
    if detail:
        entry["detail"] = detail

    try:
        with open(file_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass
