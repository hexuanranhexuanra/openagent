"""Safe self-modification with allowlist/denylist, matching TS evolution/self-modify.ts."""

from __future__ import annotations

import ast
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

from src.utils.logger import create_logger

log = create_logger("evolution:self-modify")

PROJECT_ROOT = Path.cwd()

ALLOWED_GLOBS = [
    "user-space/",
    "src/agent/tools/builtin/",
    "config/",
]

DENIED_PATHS = [
    "src/evolution/",
    "src/config/",
    "src/logger.",
    "src/index.",
    "src/worker.",
    "src/gateway/server.",
    "package.json",
    "tsconfig.json",
    "pyproject.toml",
    ".env",
    ".git/",
]


@dataclass
class ModifyResult:
    success: bool
    reason: str | None = None
    backup_path: str | None = None


class SelfModifier:
    def __init__(self) -> None:
        self._change_log: list[dict] = []

    def is_allowed(self, file_path: str) -> bool:
        resolved = (PROJECT_ROOT / file_path).resolve()
        try:
            rel = str(resolved.relative_to(PROJECT_ROOT))
        except ValueError:
            return False

        for denied in DENIED_PATHS:
            if rel.startswith(denied):
                return False

        for allowed in ALLOWED_GLOBS:
            if rel.startswith(allowed):
                return True

        return False

    async def modify(self, file_path: str, content: str, rationale: str) -> ModifyResult:
        if not self.is_allowed(file_path):
            return ModifyResult(success=False, reason=f"Path not allowed: {file_path}")

        abs_path = (PROJECT_ROOT / file_path).resolve()
        backup_path = None

        if abs_path.exists():
            backup_path = await self._backup(abs_path, file_path)

        abs_path.parent.mkdir(parents=True, exist_ok=True)

        if file_path.endswith(".py"):
            if not self._validate_syntax(content):
                return ModifyResult(success=False, reason="Python syntax validation failed")

        abs_path.write_text(content, encoding="utf-8")

        self._change_log.append({
            "timestamp": time.time(),
            "file": file_path,
            "action": "modify",
            "rationale": rationale,
        })

        log.info("File modified", {"file": file_path, "rationale": rationale})
        return ModifyResult(success=True, backup_path=backup_path)

    async def _backup(self, abs_path: Path, rel: str) -> str:
        backup_dir = PROJECT_ROOT / "data" / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        ts = int(time.time())
        safe_name = rel.replace("/", "_").replace("\\", "_")
        backup_file = backup_dir / f"{ts}_{safe_name}"
        shutil.copy2(str(abs_path), str(backup_file))
        return str(backup_file)

    def _validate_syntax(self, content: str) -> bool:
        try:
            ast.parse(content)
            return True
        except SyntaxError:
            return False

    def get_change_log(self) -> list[dict]:
        return list(self._change_log)


_modifier: SelfModifier | None = None


def get_self_modifier() -> SelfModifier:
    global _modifier
    if _modifier is None:
        _modifier = SelfModifier()
    return _modifier
