"""Persistent memory store — SOUL.md, MEMORY.md, HISTORY.md, daily logs.

Redesigned from the original SOUL/USER/WORLD split to a simpler two-tier model:
- MEMORY.md: curated long-term memory, always loaded into context
- HISTORY.md: append-only event log, searchable on demand
- memory/YYYY-MM-DD.md: daily detail logs, searchable on demand
- SOUL.md: agent identity (rarely changes, always loaded)
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path

from src.utils.logger import create_logger

log = create_logger("evolution:memory")

# Legacy files that can still be read
READABLE_FILES = {"SOUL", "MEMORY", "HISTORY", "USER", "WORLD"}


class MemoryStore:
    def __init__(self, base_path: str = "user-space/memory") -> None:
        self._base = Path(base_path)
        self._base.mkdir(parents=True, exist_ok=True)
        # Ensure memory/ subdir for daily logs
        (self._base / "memory").mkdir(parents=True, exist_ok=True)

    @property
    def base_path(self) -> Path:
        return self._base

    # ── Core read/write ──

    def _file_path(self, name: str) -> Path:
        return self._base / f"{name}.md"

    async def read(self, file: str) -> str:
        """Read a memory file by name (SOUL, MEMORY, HISTORY) or relative path."""
        upper = file.upper()
        if upper in READABLE_FILES:
            p = self._file_path(upper)
        else:
            p = self._base / file
        if not p.exists():
            return ""
        return p.read_text(encoding="utf-8")

    async def read_soul(self) -> str:
        return await self.read("SOUL")

    async def read_long_term(self) -> str:
        return await self.read("MEMORY")

    async def write_long_term(self, content: str) -> None:
        self._file_path("MEMORY").write_text(content.strip() + "\n", encoding="utf-8")

    async def append_history(self, entry: str) -> None:
        """Append a timestamped entry to HISTORY.md."""
        p = self._file_path("HISTORY")
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
        block = f"\n[{now}] {entry.strip()}\n"
        with open(p, "a", encoding="utf-8") as f:
            f.write(block)

    async def append_daily_log(self, entry: str) -> None:
        """Append to memory/YYYY-MM-DD.md daily log file."""
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        p = self._base / "memory" / f"{today}.md"
        now = datetime.now(timezone.utc).strftime("%H:%M")
        block = f"\n[{now}] {entry.strip()}\n"
        with open(p, "a", encoding="utf-8") as f:
            f.write(block)

    # ── Bootstrap: read files for system prompt injection ──

    async def get_bootstrap_context(self) -> dict[str, str]:
        """Return files to inject into system prompt. Only SOUL + MEMORY."""
        result: dict[str, str] = {}
        soul = await self.read_soul()
        if soul:
            result["SOUL.md"] = soul
        memory = await self.read_long_term()
        if memory:
            result["MEMORY.md"] = memory
        return result

    # ── Search ──

    def iter_searchable_files(self) -> list[Path]:
        """List all files eligible for search (HISTORY.md + memory/*.md)."""
        files: list[Path] = []
        history = self._file_path("HISTORY")
        if history.exists():
            files.append(history)
        memory_dir = self._base / "memory"
        if memory_dir.exists():
            files.extend(sorted(memory_dir.glob("*.md")))
        return files

    async def search_grep(self, query: str, max_results: int = 10) -> list[dict]:
        """Simple keyword search across HISTORY.md and daily logs."""
        keywords = _extract_keywords(query)
        if not keywords:
            return []

        results: list[dict] = []
        for path in self.iter_searchable_files():
            content = path.read_text(encoding="utf-8")
            rel_path = str(path.relative_to(self._base))
            for i, line in enumerate(content.splitlines()):
                if not line.strip():
                    continue
                score = sum(1 for kw in keywords if kw.lower() in line.lower())
                if score > 0:
                    results.append({
                        "path": rel_path,
                        "line": i + 1,
                        "content": line.strip(),
                        "score": score / len(keywords),
                    })

        results.sort(key=lambda r: r["score"], reverse=True)
        return results[:max_results]

    # ── Legacy migration ──

    async def migrate_if_needed(self) -> None:
        """Merge legacy USER.md + WORLD.md into MEMORY.md on first run."""
        memory_path = self._file_path("MEMORY")
        user_path = self._file_path("USER")
        world_path = self._file_path("WORLD")

        if memory_path.exists():
            return  # Already migrated

        parts: list[str] = []
        if user_path.exists():
            content = user_path.read_text(encoding="utf-8").strip()
            if content:
                parts.append(f"## User Information\n{content}")
        if world_path.exists():
            content = world_path.read_text(encoding="utf-8").strip()
            if content:
                parts.append(f"## World Knowledge\n{content}")

        if parts:
            merged = "\n\n".join(parts) + "\n"
            memory_path.write_text(merged, encoding="utf-8")
            log.info("Migrated USER.md + WORLD.md → MEMORY.md")

    # ── Legacy compatibility ──

    async def update_section(self, file: str, section: str, content: str) -> None:
        """Update a markdown section in a memory file. Legacy compat."""
        header = section if section.startswith("#") else f"## {section}"
        level = header.split(" ")[0]
        p = self._file_path(file.upper())

        if not p.exists():
            p.write_text(f"{header}\n{content}\n", encoding="utf-8")
            return

        text = p.read_text(encoding="utf-8")
        escaped_header = re.escape(header)
        pattern = rf"(^{escaped_header}\s*\n)([\s\S]*?)(?=^{re.escape(level)} |\Z)"
        match = re.search(pattern, text, re.MULTILINE)

        if match:
            new_text = text[: match.start(2)] + content + "\n" + text[match.end(2) :]
        else:
            new_text = text.rstrip() + f"\n\n{header}\n{content}\n"

        p.write_text(new_text, encoding="utf-8")

    async def append_entry(self, file: str, section: str, entry: str) -> None:
        """Append a timestamped entry to a section. Legacy compat."""
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
        timestamped = f"- [{now}] {entry}"

        header = section if section.startswith("#") else f"## {section}"
        p = self._file_path(file.upper())

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


def _extract_keywords(query: str) -> list[str]:
    """Extract search keywords from a query string."""
    tokens = re.findall(r"[\w\u4e00-\u9fff]+", query.lower())
    stop_words = {
        "the", "a", "an", "is", "are", "was", "were", "be", "been",
        "have", "has", "had", "do", "does", "did", "will", "would",
        "could", "should", "may", "might", "can", "shall",
        "i", "you", "he", "she", "it", "we", "they",
        "this", "that", "these", "those", "what", "which", "who",
        "how", "when", "where", "why", "and", "or", "not", "no",
        "in", "on", "at", "to", "for", "of", "with", "by", "from",
        "about", "into", "through", "during", "before", "after",
    }
    return [t for t in tokens if len(t) > 1 and t not in stop_words]


# ── FTS search backend (optional) ──

class FTSMemoryIndex:
    """SQLite FTS5-based full-text search index for memory files."""

    def __init__(self, db_path: str = "data/memory_index.db") -> None:
        self._db_path = db_path
        self._cached_hashes: dict[str, str] = {}

    async def init(self) -> None:
        import aiosqlite
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self._db_path) as db:
            await db.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
                USING fts5(path, content, tokenize='unicode61 remove_diacritics 2')
            """)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS file_hashes (
                    path TEXT PRIMARY KEY,
                    hash TEXT NOT NULL
                )
            """)
            await db.commit()

        # Load cached hashes
        async with aiosqlite.connect(self._db_path) as db:
            cursor = await db.execute("SELECT path, hash FROM file_hashes")
            rows = await cursor.fetchall()
            self._cached_hashes = {row[0]: row[1] for row in rows}

    async def sync(self, memory_dir: Path) -> int:
        """Incremental sync: only re-index changed files. Returns count of re-indexed files."""
        import aiosqlite

        reindexed = 0
        all_paths: set[str] = set()

        async with aiosqlite.connect(self._db_path) as db:
            # Index HISTORY.md and memory/*.md
            files_to_check: list[Path] = []
            history = memory_dir / "HISTORY.md"
            if history.exists():
                files_to_check.append(history)
            sub = memory_dir / "memory"
            if sub.exists():
                files_to_check.extend(sorted(sub.glob("*.md")))

            for path in files_to_check:
                str_path = str(path)
                all_paths.add(str_path)
                content = path.read_text(encoding="utf-8")
                file_hash = hashlib.sha256(content.encode()).hexdigest()

                if self._cached_hashes.get(str_path) == file_hash:
                    continue

                # Delete old entries
                await db.execute("DELETE FROM memory_fts WHERE path = ?", (str_path,))

                # Insert chunks
                for chunk in _split_chunks(content):
                    await db.execute(
                        "INSERT INTO memory_fts (path, content) VALUES (?, ?)",
                        (str_path, chunk),
                    )

                # Update hash
                await db.execute(
                    "INSERT OR REPLACE INTO file_hashes (path, hash) VALUES (?, ?)",
                    (str_path, file_hash),
                )
                self._cached_hashes[str_path] = file_hash
                reindexed += 1

            # Remove deleted files from index
            for cached_path in list(self._cached_hashes.keys()):
                if cached_path not in all_paths:
                    await db.execute("DELETE FROM memory_fts WHERE path = ?", (cached_path,))
                    await db.execute("DELETE FROM file_hashes WHERE path = ?", (cached_path,))
                    del self._cached_hashes[cached_path]

            await db.commit()

        return reindexed

    async def search(self, query: str, max_results: int = 10) -> list[dict]:
        import aiosqlite

        # Escape FTS5 special characters
        safe_query = re.sub(r'[^\w\s\u4e00-\u9fff]', ' ', query)
        terms = safe_query.split()
        if not terms:
            return []
        fts_query = " OR ".join(terms)

        async with aiosqlite.connect(self._db_path) as db:
            cursor = await db.execute(
                """
                SELECT path, content, bm25(memory_fts) as score
                FROM memory_fts
                WHERE memory_fts MATCH ?
                ORDER BY score
                LIMIT ?
                """,
                (fts_query, max_results),
            )
            rows = await cursor.fetchall()
            return [
                {"path": row[0], "content": row[1], "score": -row[2]}
                for row in rows
            ]


def _split_chunks(content: str, chunk_size: int = 500) -> list[str]:
    """Split content into chunks by paragraph, ~chunk_size chars each."""
    paragraphs = content.split("\n\n")
    chunks: list[str] = []
    current = ""
    for para in paragraphs:
        if len(current) + len(para) > chunk_size and current:
            chunks.append(current.strip())
            current = para
        else:
            current += "\n\n" + para if current else para
    if current.strip():
        chunks.append(current.strip())
    return chunks if chunks else [content]


# ── Singleton ──

_store: MemoryStore | None = None
_fts_index: FTSMemoryIndex | None = None


def get_memory_store() -> MemoryStore:
    global _store
    if _store is None:
        _store = MemoryStore()
    return _store


def get_fts_index() -> FTSMemoryIndex | None:
    return _fts_index


async def init_fts_index(db_path: str = "data/memory_index.db") -> FTSMemoryIndex:
    global _fts_index
    _fts_index = FTSMemoryIndex(db_path)
    await _fts_index.init()
    return _fts_index
