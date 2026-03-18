"""Loop detector for stuck agent loops, matching TS agent/loop-detector.ts."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Literal


LoopLevel = Literal["warning", "critical"]


@dataclass
class LoopCheckResult:
    stuck: bool
    level: LoopLevel | None = None
    message: str | None = None


class LoopDetector:
    def __init__(
        self,
        *,
        window_size: int = 20,
        warn_at: int = 5,
        stop_at: int = 8,
        circuit_breaker: int = 30,
    ) -> None:
        self._window: list[str] = []
        self._total_calls = 0
        self._window_size = window_size
        self._warn_at = warn_at
        self._stop_at = stop_at
        self._circuit_breaker = circuit_breaker

    def check(self, tool_name: str, args: Any) -> LoopCheckResult:
        h = _hash_call(tool_name, args)
        self._window.append(h)
        self._total_calls += 1
        if len(self._window) > self._window_size:
            self._window.pop(0)

        # Circuit breaker
        if self._total_calls >= self._circuit_breaker:
            return LoopCheckResult(
                stuck=True,
                level="critical",
                message=(
                    f"Circuit breaker triggered: {self._total_calls} tool calls in this session. "
                    "Stop executing tools, summarise what you have accomplished so far, "
                    "and report to the user."
                ),
            )

        # Ping-pong: ABABAB
        if len(self._window) >= 6:
            tail = self._window[-6:]
            if (
                tail[0] == tail[2] == tail[4]
                and tail[1] == tail[3] == tail[5]
                and tail[0] != tail[1]
            ):
                return LoopCheckResult(
                    stuck=True,
                    level="critical",
                    message=(
                        "Loop detected: alternating between two tools with no progress. "
                        "Break the cycle — summarise your findings and take a different approach."
                    ),
                )

        # Generic repeat
        count = self._window.count(h)
        if count >= self._stop_at:
            return LoopCheckResult(
                stuck=True,
                level="critical",
                message=(
                    f'Loop detected: "{tool_name}" called {count} times with identical arguments. '
                    "You must stop and try a fundamentally different approach."
                ),
            )
        if count >= self._warn_at:
            return LoopCheckResult(
                stuck=True,
                level="warning",
                message=(
                    f'Warning: "{tool_name}" has been called {count} times with the same arguments. '
                    "Consider a different strategy to make progress."
                ),
            )

        return LoopCheckResult(stuck=False)


def _hash_call(tool_name: str, args: Any) -> str:
    payload = f"{tool_name}:{_stable_stringify(args)}"
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def _stable_stringify(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return json.dumps(value)
    if isinstance(value, (int, float, str)):
        return json.dumps(value)
    if isinstance(value, list):
        return "[" + ",".join(_stable_stringify(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        return "{" + ",".join(f"{json.dumps(k)}:{_stable_stringify(value[k])}" for k in keys) + "}"
    return json.dumps(str(value))
