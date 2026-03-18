"""Subagent orchestration, matching TS agent/subagent-registry.ts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

_current_context: dict | None = None

# Subagent depth tracking
_subagent_depths: dict[str, int] = {}


def set_current_run_context(*, channel: str, peer_id: str, depth: int) -> None:
    global _current_context
    _current_context = {"channel": channel, "peer_id": peer_id, "depth": depth}


def get_current_run_context() -> dict | None:
    return _current_context


def get_subagent_depth(run_id: str) -> int:
    return _subagent_depths.get(run_id, 0)


def set_subagent_depth(run_id: str, depth: int) -> None:
    _subagent_depths[run_id] = depth
