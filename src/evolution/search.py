"""Hybrid memory search — Vector + FTS + MMR + Temporal Decay.

Implements OpenClaw-style multi-stage retrieval pipeline:
  Query → [Vector Search ∥ FTS Search] → Hybrid Merge → MMR → Temporal Decay → Results
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import aiosqlite

from src.evolution.embeddings import (
    EmbeddingCache,
    EmbeddingProvider,
    cosine_similarity,
    _vec_to_blob,
    _blob_to_vec,
)
from src.utils.logger import create_logger

log = create_logger("evolution:search")


@dataclass
class SearchResult:
    path: str
    content: str
    score: float
    start_line: int = 0
    end_line: int = 0
    source: str = ""  # "vector", "fts", "hybrid"

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "content": self.content,
            "score": round(self.score, 4),
            "start_line": self.start_line,
            "end_line": self.end_line,
            "source": self.source,
        }


@dataclass
class SearchConfig:
    max_results: int = 6
    min_score: float = 0.25
    vector_weight: float = 0.7
    text_weight: float = 0.3
    mmr_enabled: bool = True
    mmr_lambda: float = 0.7
    temporal_decay_enabled: bool = True
    temporal_decay_half_life_days: int = 30


@dataclass
class Chunk:
    """A text chunk with source location info."""
    path: str
    content: str
    start_line: int
    end_line: int
    content_hash: str = ""

    def __post_init__(self):
        if not self.content_hash:
            self.content_hash = hashlib.sha256(self.content.encode()).hexdigest()[:16]


# ── Chunking with line number tracking ──


def split_chunks_with_lines(
    content: str, chunk_size: int = 400, overlap: int = 80
) -> list[Chunk]:
    """Split markdown content into chunks, preserving line number mapping.

    Uses markdown-aware splitting: respects paragraph and heading boundaries.
    """
    lines = content.splitlines(keepends=True)
    if not lines:
        return []

    chunks: list[Chunk] = []
    current_lines: list[str] = []
    current_start = 1
    current_chars = 0

    for i, line in enumerate(lines, 1):
        is_heading = line.startswith("#")
        is_blank = not line.strip()

        # Split at heading boundaries or when size exceeded
        if current_lines and (
            (is_heading and current_chars > overlap)
            or (is_blank and current_chars >= chunk_size)
            or (current_chars >= chunk_size * 1.5)
        ):
            text = "".join(current_lines).strip()
            if text:
                chunks.append(Chunk(
                    path="",  # Set by caller
                    content=text,
                    start_line=current_start,
                    end_line=i - 1,
                ))

            # Overlap: keep last few lines for context continuity
            overlap_chars = 0
            overlap_start = len(current_lines)
            for j in range(len(current_lines) - 1, -1, -1):
                overlap_chars += len(current_lines[j])
                if overlap_chars >= overlap:
                    overlap_start = j
                    break

            kept = current_lines[overlap_start:]
            current_lines = kept
            current_start = i - len(kept)
            current_chars = sum(len(l) for l in current_lines)

        current_lines.append(line)
        current_chars += len(line)

    # Final chunk
    if current_lines:
        text = "".join(current_lines).strip()
        if text:
            chunks.append(Chunk(
                path="",
                content=text,
                start_line=current_start,
                end_line=len(lines),
            ))

    return chunks


# ── Hybrid Memory Index ──


class HybridMemoryIndex:
    """SQLite-backed index supporting FTS5 + vector search with hybrid ranking."""

    def __init__(
        self,
        db_path: str = "data/memory_index.db",
        embedding_provider: EmbeddingProvider | None = None,
    ) -> None:
        self._db_path = db_path
        self._embedder = embedding_provider
        self._cache = EmbeddingCache(db_path)
        self._file_hashes: dict[str, str] = {}

    async def init(self) -> None:
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self._db_path) as db:
            # File metadata
            await db.execute("""
                CREATE TABLE IF NOT EXISTS files (
                    path TEXT PRIMARY KEY,
                    hash TEXT NOT NULL,
                    modified_at REAL NOT NULL DEFAULT 0
                )
            """)
            # Chunks with line mapping
            await db.execute("""
                CREATE TABLE IF NOT EXISTS chunks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    path TEXT NOT NULL,
                    content TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    start_line INTEGER NOT NULL,
                    end_line INTEGER NOT NULL,
                    FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
                )
            """)
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path)"
            )
            # FTS5 virtual table
            await db.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
                USING fts5(content, content='chunks', content_rowid='id',
                           tokenize='unicode61 remove_diacritics 2')
            """)
            # FTS sync triggers
            for op, old_new in [
                ("INSERT", "new"),
                ("DELETE", "old"),
                ("UPDATE", "old"),
            ]:
                trigger_name = f"chunks_ai_{op.lower()}"
                # Use IF NOT EXISTS isn't supported for triggers, so try/except
                try:
                    if op == "UPDATE":
                        await db.execute(f"""
                            CREATE TRIGGER {trigger_name} AFTER {op} ON chunks BEGIN
                                INSERT INTO chunks_fts(chunks_fts, rowid, content)
                                    VALUES('delete', old.id, old.content);
                                INSERT INTO chunks_fts(rowid, content)
                                    VALUES(new.id, new.content);
                            END
                        """)
                    elif op == "DELETE":
                        await db.execute(f"""
                            CREATE TRIGGER {trigger_name} AFTER {op} ON chunks BEGIN
                                INSERT INTO chunks_fts(chunks_fts, rowid, content)
                                    VALUES('delete', {old_new}.id, {old_new}.content);
                            END
                        """)
                    else:
                        await db.execute(f"""
                            CREATE TRIGGER {trigger_name} AFTER {op} ON chunks BEGIN
                                INSERT INTO chunks_fts(rowid, content)
                                    VALUES({old_new}.id, {old_new}.content);
                            END
                        """)
                except Exception:
                    pass  # Trigger already exists

            # Vector storage (raw blob column on chunks table)
            try:
                await db.execute(
                    "ALTER TABLE chunks ADD COLUMN embedding BLOB"
                )
            except Exception:
                pass  # Column already exists

            # Embedding cache
            await self._cache.init(db)

            await db.commit()

        # Load file hashes
        async with aiosqlite.connect(self._db_path) as db:
            cursor = await db.execute("SELECT path, hash FROM files")
            rows = await cursor.fetchall()
            self._file_hashes = {row[0]: row[1] for row in rows}

        log.info("HybridMemoryIndex initialized", {
            "db": self._db_path,
            "has_embedder": self._embedder is not None,
            "indexed_files": len(self._file_hashes),
        })

    async def sync(self, memory_dir: Path) -> int:
        """Incremental sync: re-index changed files, remove deleted. Returns count."""
        reindexed = 0
        current_paths: set[str] = set()

        # Collect all searchable files
        files_to_check: list[Path] = []
        history = memory_dir / "HISTORY.md"
        if history.exists():
            files_to_check.append(history)
        sub = memory_dir / "memory"
        if sub.exists():
            files_to_check.extend(sorted(sub.glob("*.md")))

        async with aiosqlite.connect(self._db_path) as db:
            for path in files_to_check:
                str_path = str(path)
                current_paths.add(str_path)

                content = path.read_text(encoding="utf-8")
                file_hash = hashlib.sha256(content.encode()).hexdigest()

                if self._file_hashes.get(str_path) == file_hash:
                    continue

                # Re-index this file
                await self._reindex_file(db, str_path, content, path.stat().st_mtime)
                self._file_hashes[str_path] = file_hash
                reindexed += 1

            # Remove deleted files
            for old_path in list(self._file_hashes.keys()):
                if old_path not in current_paths:
                    await db.execute("DELETE FROM chunks WHERE path = ?", (old_path,))
                    await db.execute("DELETE FROM files WHERE path = ?", (old_path,))
                    del self._file_hashes[old_path]
                    reindexed += 1

            await db.commit()

        if reindexed > 0:
            log.info("Memory index synced", {"reindexed": reindexed})

        return reindexed

    async def _reindex_file(
        self, db: aiosqlite.Connection, path: str, content: str, mtime: float
    ) -> None:
        # Remove old chunks
        await db.execute("DELETE FROM chunks WHERE path = ?", (path,))

        # Split into chunks with line mapping
        chunks = split_chunks_with_lines(content)
        if not chunks:
            return

        for chunk in chunks:
            chunk.path = path

        # Insert chunks
        chunk_ids: list[int] = []
        for chunk in chunks:
            cursor = await db.execute(
                "INSERT INTO chunks (path, content, content_hash, start_line, end_line) "
                "VALUES (?, ?, ?, ?, ?)",
                (chunk.path, chunk.content, chunk.content_hash, chunk.start_line, chunk.end_line),
            )
            chunk_ids.append(cursor.lastrowid)

        # Compute embeddings if provider available
        if self._embedder:
            await self._embed_chunks(db, chunks, chunk_ids)

        # Update file hash
        await db.execute(
            "INSERT OR REPLACE INTO files (path, hash, modified_at) VALUES (?, ?, ?)",
            (path, hashlib.sha256(content.encode()).hexdigest(), mtime),
        )

    async def _embed_chunks(
        self,
        db: aiosqlite.Connection,
        chunks: list[Chunk],
        chunk_ids: list[int],
    ) -> None:
        """Compute and store embeddings, using cache where possible."""
        provider_name = self._embedder.name

        # Check cache
        hashes = [c.content_hash for c in chunks]
        cached = await self._cache.get_many(db, hashes, provider_name)

        # Find uncached
        to_embed: list[tuple[int, Chunk]] = []
        for i, chunk in enumerate(chunks):
            if chunk.content_hash not in cached:
                to_embed.append((i, chunk))

        # Embed uncached
        if to_embed:
            texts = [c.content for _, c in to_embed]
            try:
                vectors = await self._embedder.embed(texts)
            except Exception as e:
                log.error("Embedding failed during indexing", {"error": str(e)})
                return

            # Store in cache
            cache_items = [
                (to_embed[i][1].content_hash, vectors[i])
                for i in range(len(to_embed))
            ]
            await self._cache.put_many(db, cache_items, provider_name)

            # Merge into cached dict
            for i, (_, chunk) in enumerate(to_embed):
                cached[chunk.content_hash] = vectors[i]

        # Write embeddings to chunks table
        for i, chunk in enumerate(chunks):
            vec = cached.get(chunk.content_hash)
            if vec:
                await db.execute(
                    "UPDATE chunks SET embedding = ? WHERE id = ?",
                    (_vec_to_blob(vec), chunk_ids[i]),
                )

    # ── Search ──

    async def search(
        self,
        query: str,
        config: SearchConfig | None = None,
    ) -> list[SearchResult]:
        """Hybrid search: Vector + FTS → merge → MMR → temporal decay."""
        if config is None:
            config = SearchConfig()

        # Sync before search to ensure freshness
        from src.evolution.memory import get_memory_store
        store = get_memory_store()
        await self.sync(store.base_path)

        # Run vector and FTS in parallel
        fts_results = await self._search_fts(query, config.max_results * 3)
        vector_results: list[SearchResult] = []

        if self._embedder:
            vector_results = await self._search_vector(query, config.max_results * 3)

        # Hybrid merge
        if vector_results and fts_results:
            merged = _hybrid_merge(
                vector_results, fts_results,
                config.vector_weight, config.text_weight,
            )
        elif vector_results:
            merged = vector_results
        else:
            merged = fts_results

        # Filter by min score
        merged = [r for r in merged if r.score >= config.min_score]

        # Temporal decay
        if config.temporal_decay_enabled:
            merged = _apply_temporal_decay(merged, config.temporal_decay_half_life_days)

        # Re-sort after decay
        merged.sort(key=lambda r: r.score, reverse=True)

        # MMR reranking for diversity
        if config.mmr_enabled and len(merged) > 1:
            merged = _mmr_rerank(merged, config.mmr_lambda, config.max_results)
        else:
            merged = merged[: config.max_results]

        return merged

    async def _search_vector(self, query: str, limit: int) -> list[SearchResult]:
        """Cosine similarity search using embeddings."""
        if not self._embedder:
            return []

        try:
            query_vec = await self._embedder.embed_single(query)
        except Exception as e:
            log.error("Query embedding failed", {"error": str(e)})
            return []

        results: list[SearchResult] = []

        async with aiosqlite.connect(self._db_path) as db:
            cursor = await db.execute(
                "SELECT id, path, content, start_line, end_line, embedding "
                "FROM chunks WHERE embedding IS NOT NULL"
            )
            rows = await cursor.fetchall()

        for row in rows:
            chunk_id, path, content, start_line, end_line, emb_blob = row
            if not emb_blob:
                continue
            chunk_vec = _blob_to_vec(emb_blob)
            score = cosine_similarity(query_vec, chunk_vec)
            results.append(SearchResult(
                path=path,
                content=content,
                score=score,
                start_line=start_line,
                end_line=end_line,
                source="vector",
            ))

        results.sort(key=lambda r: r.score, reverse=True)
        return results[:limit]

    async def _search_fts(self, query: str, limit: int) -> list[SearchResult]:
        """BM25-ranked full-text search."""
        safe_query = re.sub(r'[^\w\s\u4e00-\u9fff]', ' ', query)
        terms = safe_query.split()
        if not terms:
            return []
        fts_query = " OR ".join(terms)

        results: list[SearchResult] = []

        async with aiosqlite.connect(self._db_path) as db:
            try:
                cursor = await db.execute(
                    """
                    SELECT c.path, c.content, c.start_line, c.end_line,
                           bm25(chunks_fts) as rank
                    FROM chunks_fts
                    JOIN chunks c ON c.id = chunks_fts.rowid
                    WHERE chunks_fts MATCH ?
                    ORDER BY rank
                    LIMIT ?
                    """,
                    (fts_query, limit),
                )
                rows = await cursor.fetchall()
            except Exception as e:
                log.warn("FTS search failed, returning empty", {"error": str(e)})
                return []

        for row in rows:
            path, content, start_line, end_line, rank = row
            results.append(SearchResult(
                path=path,
                content=content,
                score=-rank,  # bm25() returns negative, lower = better
                start_line=start_line,
                end_line=end_line,
                source="fts",
            ))

        return results

    async def get_chunk_context(
        self, path: str, start_line: int, end_line: int
    ) -> str | None:
        """Read a specific range of lines from a file (for memory_get)."""
        p = Path(path)
        if not p.exists():
            return None
        lines = p.read_text(encoding="utf-8").splitlines()
        selected = lines[max(0, start_line - 1): end_line]
        return "\n".join(f"{i:4d} | {line}" for i, line in enumerate(selected, start_line))


# ── Hybrid merge ──


def _normalize_scores(results: list[SearchResult]) -> list[SearchResult]:
    """Min-max normalize scores to [0, 1]."""
    if not results:
        return results
    scores = [r.score for r in results]
    min_s, max_s = min(scores), max(scores)
    spread = max_s - min_s
    if spread == 0:
        for r in results:
            r.score = 1.0
    else:
        for r in results:
            r.score = (r.score - min_s) / spread
    return results


def _hybrid_merge(
    vector_results: list[SearchResult],
    fts_results: list[SearchResult],
    vector_weight: float = 0.7,
    text_weight: float = 0.3,
) -> list[SearchResult]:
    """Merge vector and FTS results with weighted scores."""
    _normalize_scores(vector_results)
    _normalize_scores(fts_results)

    # Build score maps keyed by (path, start_line)
    merged: dict[tuple[str, int], SearchResult] = {}

    for r in vector_results:
        key = (r.path, r.start_line)
        merged[key] = SearchResult(
            path=r.path,
            content=r.content,
            score=r.score * vector_weight,
            start_line=r.start_line,
            end_line=r.end_line,
            source="hybrid",
        )

    for r in fts_results:
        key = (r.path, r.start_line)
        if key in merged:
            merged[key].score += r.score * text_weight
        else:
            merged[key] = SearchResult(
                path=r.path,
                content=r.content,
                score=r.score * text_weight,
                start_line=r.start_line,
                end_line=r.end_line,
                source="hybrid",
            )

    results = list(merged.values())
    results.sort(key=lambda r: r.score, reverse=True)
    return results


# ── MMR (Maximal Marginal Relevance) ──


def _jaccard_similarity(a: str, b: str) -> float:
    """Word-level Jaccard similarity for MMR diversity."""
    words_a = set(a.lower().split())
    words_b = set(b.lower().split())
    if not words_a or not words_b:
        return 0.0
    intersection = words_a & words_b
    union = words_a | words_b
    return len(intersection) / len(union)


def _mmr_rerank(
    results: list[SearchResult],
    lambda_param: float = 0.7,
    max_results: int = 6,
) -> list[SearchResult]:
    """Maximal Marginal Relevance: balance relevance and diversity.

    lambda=1.0 → pure relevance (no diversity)
    lambda=0.0 → pure diversity (no relevance)
    """
    if len(results) <= 1:
        return results

    selected: list[SearchResult] = [results[0]]
    remaining = list(results[1:])

    while remaining and len(selected) < max_results:
        best_score = -float("inf")
        best_idx = 0

        for i, candidate in enumerate(remaining):
            # Relevance component
            relevance = candidate.score

            # Diversity component: max similarity to any already-selected result
            max_sim = max(
                _jaccard_similarity(candidate.content, s.content)
                for s in selected
            )

            # MMR score
            mmr_score = lambda_param * relevance - (1 - lambda_param) * max_sim

            if mmr_score > best_score:
                best_score = mmr_score
                best_idx = i

        selected.append(remaining.pop(best_idx))

    return selected


# ── Temporal Decay ──


_DATE_PATTERN = re.compile(r"(\d{4}-\d{2}-\d{2})")


def _extract_file_date(path: str) -> datetime | None:
    """Extract date from file path like memory/2026-03-14.md."""
    match = _DATE_PATTERN.search(path)
    if match:
        try:
            return datetime.strptime(match.group(1), "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return None


def _is_evergreen(path: str) -> bool:
    """MEMORY.md, SOUL.md, and non-dated files don't decay."""
    basename = Path(path).name.upper()
    if basename in ("MEMORY.MD", "SOUL.MD", "HISTORY.MD"):
        return True
    # If the filename doesn't contain a date pattern, it's evergreen
    return _extract_file_date(path) is None


def _apply_temporal_decay(
    results: list[SearchResult],
    half_life_days: int = 30,
) -> list[SearchResult]:
    """Apply exponential decay to dated memory files."""
    now = datetime.now(timezone.utc)

    for r in results:
        if _is_evergreen(r.path):
            continue
        file_date = _extract_file_date(r.path)
        if file_date:
            days_old = (now - file_date).days
            if days_old > 0:
                decay = 0.5 ** (days_old / half_life_days)
                r.score *= decay

    return results


# ── Singleton ──

_index: HybridMemoryIndex | None = None


def get_hybrid_index() -> HybridMemoryIndex | None:
    return _index


async def init_hybrid_index(
    db_path: str = "data/memory_index.db",
    embedding_provider: EmbeddingProvider | None = None,
) -> HybridMemoryIndex:
    global _index
    _index = HybridMemoryIndex(db_path, embedding_provider)
    await _index.init()
    return _index
