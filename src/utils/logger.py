"""Structured JSON logger matching the TS implementation's output format."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

LOG_LEVELS = {"debug": 0, "info": 1, "warn": 2, "error": 3}

_current_level: str = os.environ.get("LOG_LEVEL", "info").lower()


def set_log_level(level: str) -> None:
    global _current_level
    _current_level = level


def _should_log(level: str) -> bool:
    return LOG_LEVELS.get(level, 1) >= LOG_LEVELS.get(_current_level, 1)


def _log(level: str, scope: str, msg: str, data: dict | None = None) -> None:
    if not _should_log(level):
        return

    entry: dict = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "scope": scope,
        "msg": msg,
    }
    if data:
        entry["data"] = data

    line = json.dumps(entry, ensure_ascii=False)

    print(line, file=sys.stderr)


class Logger:
    __slots__ = ("_scope",)

    def __init__(self, scope: str) -> None:
        self._scope = scope

    def debug(self, msg: str, data: dict | None = None) -> None:
        _log("debug", self._scope, msg, data)

    def info(self, msg: str, data: dict | None = None) -> None:
        _log("info", self._scope, msg, data)

    def warn(self, msg: str, data: dict | None = None) -> None:
        _log("warn", self._scope, msg, data)

    def error(self, msg: str, data: dict | None = None) -> None:
        _log("error", self._scope, msg, data)


def create_logger(scope: str) -> Logger:
    return Logger(scope)
