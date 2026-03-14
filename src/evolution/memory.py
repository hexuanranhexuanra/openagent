"""Persistent memory store for SOUL/USER/WORLD.md files, matching TS evolution/memory.ts."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

from src.utils.logger import create_logger

log = create_logger("evolution:memory")

MEMORY_FILES = {"SOUL", "USER", "WORLD"}


class MemoryStore:
    def __init__(self, base_path: str = "user-space/memory") -> None:
        self._base = Path(base_path)
        self._base.mkdir(parents=True, exist_ok=True)

    def _file_path(self, name: str) -> Path:
        return self._base / f"{name}.md"

    async def read(self, file: str) -> str:
        if file not in MEMORY_FILES:
            raise ValueError(f"Invalid memory file: {file}")
        p = self._file_path(file)
        if not p.exists():
            return ""
        return p.read_text(encoding="utf-8")

    async def write(self, file: str, content: str) -> None:
        if file not in MEMORY_FILES:
            raise ValueError(f"Invalid memory file: {file}")
        self._file_path(file).write_text(content, encoding="utf-8")

    async def read_all(self) -> tuple[str, str, str]:
        soul = await self.read("SOUL")
        user = await self.read("USER")
        world = await self.read("WORLD")
        return soul, user, world

    async def read_long_term(self) -> str:
        p = self._base / "MEMORY.md"
        if not p.exists():
            return ""
        return p.read_text(encoding="utf-8")

    async def write_long_term(self, content: str) -> None:
        p = self._base / "MEMORY.md"
        p.write_text(content.strip() + "\n", encoding="utf-8")

    async def append_history(self, summary: str) -> None:
        p = self._base / "HISTORY.md"
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
        entry = f"\n---\n[{now}]\n{summary}\n"
        with open(p, "a", encoding="utf-8") as f:
            f.write(entry)

    async def update_section(self, file: str, section: str, content: str) -> None:
        if file not in MEMORY_FILES:
            raise ValueError(f"Invalid memory file: {file}")

        header = section if section.startswith("#") else f"## {section}"
        level = header.split(" ")[0]  # "##" or "###"
        p = self._file_path(file)

        if not p.exists():
            p.write_text(f"{header}\n{content}\n", encoding="utf-8")
            return

        text = p.read_text(encoding="utf-8")

        # Match the section header and content until next same-level header
        escaped_header = re.escape(header)
        pattern = rf"(^{escaped_header}\s*\n)([\s\S]*?)(?=^{re.escape(level)} |\Z)"
        match = re.search(pattern, text, re.MULTILINE)

        if match:
            new_text = text[: match.start(2)] + content + "\n" + text[match.end(2) :]
        else:
            new_text = text.rstrip() + f"\n\n{header}\n{content}\n"

        p.write_text(new_text, encoding="utf-8")

    async def append_entry(self, file: str, section: str, entry: str) -> None:
        if file not in MEMORY_FILES:
            raise ValueError(f"Invalid memory file: {file}")

        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
        timestamped = f"- [{now}] {entry}"

        header = section if section.startswith("#") else f"## {section}"
        p = self._file_path(file)

        if not p.exists():
            p.write_text(f"{header}\n{timestamped}\n", encoding="utf-8")
            return

        text = p.read_text(encoding="utf-8")
        escaped_header = re.escape(header)
        level = header.split(" ")[0]
        pattern = rf"(^{escaped_header}\s*\n)([\s\S]*?)(?=^{re.escape(level)} |\Z)"
        match = re.search(pattern, text, re.MULTILINE)

        if match:
            section_content = match.group(2)
            new_section = section_content.rstrip() + "\n" + timestamped + "\n"
            new_text = text[: match.start(2)] + new_section + text[match.end(2) :]
        else:
            new_text = text.rstrip() + f"\n\n{header}\n{timestamped}\n"

        p.write_text(new_text, encoding="utf-8")


_store: MemoryStore | None = None


def get_memory_store() -> MemoryStore:
    global _store
    if _store is None:
        _store = MemoryStore()
    return _store
