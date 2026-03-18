"""Embedding providers for vector-based memory search.

Supports multiple backends with a common interface. OpenAI is the primary
provider; others can be added by subclassing EmbeddingProvider.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Sequence

import aiosqlite

from src.utils.logger import create_logger

log = create_logger("evolution:embeddings")

# ── Abstract base ──


class EmbeddingProvider(ABC):
    """Base class for embedding providers."""

    @property
    @abstractmethod
    def name(self) -> str: ...

    @property
    @abstractmethod
    def dimensions(self) -> int: ...

    @abstractmethod
    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch of texts. Returns list of float vectors."""
        ...

    async def embed_single(self, text: str) -> list[float]:
        results = await self.embed([text])
        return results[0]


# ── OpenAI provider ──


class OpenAIEmbeddingProvider(EmbeddingProvider):
    """OpenAI-compatible embedding provider (works with any OpenAI-compatible API)."""

    def __init__(
        self,
        api_key: str = "",
        model: str = "text-embedding-3-small",
        base_url: str | None = None,
        query_params: dict[str, str] | None = None,
        max_batch_size: int = 100,
        max_tokens_per_batch: int = 8000,
    ) -> None:
        import openai

        kwargs: dict = {"api_key": api_key or "unused"}
        if base_url:
            kwargs["base_url"] = base_url
        if query_params:
            kwargs["default_query"] = query_params
        self._client = openai.AsyncOpenAI(**kwargs)
        self._model = model
        self._max_batch = max_batch_size
        self._max_tokens = max_tokens_per_batch
        self._dims = 1536 if "small" in model else 3072 if "large" in model else 1536
        log.info("OpenAI embedding provider initialized", {"model": model})

    @property
    def name(self) -> str:
        return f"openai:{self._model}"

    @property
    def dimensions(self) -> int:
        return self._dims

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        all_embeddings: list[list[float]] = []
        batches = self._make_batches(texts)

        for batch in batches:
            try:
                response = await self._client.embeddings.create(
                    model=self._model,
                    input=batch,
                )
                all_embeddings.extend([d.embedding for d in response.data])
            except Exception as e:
                log.error("Embedding API call failed", {"error": str(e), "batch_size": len(batch)})
                # Return zero vectors for failed batch
                all_embeddings.extend([[0.0] * self._dims] * len(batch))

        return all_embeddings

    def _make_batches(self, texts: list[str]) -> list[list[str]]:
        """Split texts into batches respecting size and token limits."""
        batches: list[list[str]] = []
        current_batch: list[str] = []
        current_tokens = 0

        for text in texts:
            est_tokens = len(text) // 4 + 1
            if (
                current_batch
                and (
                    len(current_batch) >= self._max_batch
                    or current_tokens + est_tokens > self._max_tokens
                )
            ):
                batches.append(current_batch)
                current_batch = []
                current_tokens = 0
            current_batch.append(text)
            current_tokens += est_tokens

        if current_batch:
            batches.append(current_batch)
        return batches


# ── Embedding cache (SQLite-backed) ──


class EmbeddingCache:
    """Caches embeddings by content hash + provider name to avoid recomputation."""

    def __init__(self, db_path: str = "data/memory_index.db") -> None:
        self._db_path = db_path

    async def init(self, db: aiosqlite.Connection) -> None:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS embedding_cache (
                content_hash TEXT NOT NULL,
                provider TEXT NOT NULL,
                embedding BLOB NOT NULL,
                PRIMARY KEY (content_hash, provider)
            )
        """)
        await db.commit()

    @staticmethod
    def hash_content(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]

    async def get_many(
        self, db: aiosqlite.Connection, hashes: list[str], provider: str
    ) -> dict[str, list[float]]:
        if not hashes:
            return {}
        placeholders = ",".join("?" * len(hashes))
        cursor = await db.execute(
            f"SELECT content_hash, embedding FROM embedding_cache "
            f"WHERE content_hash IN ({placeholders}) AND provider = ?",
            [*hashes, provider],
        )
        rows = await cursor.fetchall()
        return {row[0]: _blob_to_vec(row[1]) for row in rows}

    async def put_many(
        self,
        db: aiosqlite.Connection,
        items: list[tuple[str, list[float]]],
        provider: str,
    ) -> None:
        if not items:
            return
        await db.executemany(
            "INSERT OR REPLACE INTO embedding_cache (content_hash, provider, embedding) "
            "VALUES (?, ?, ?)",
            [(h, provider, _vec_to_blob(vec)) for h, vec in items],
        )
        await db.commit()


def _vec_to_blob(vec: list[float]) -> bytes:
    """Serialize a float vector to bytes (compact binary format)."""
    import struct

    return struct.pack(f"{len(vec)}f", *vec)


def _blob_to_vec(blob: bytes) -> list[float]:
    """Deserialize bytes back to a float vector."""
    import struct

    n = len(blob) // 4
    return list(struct.unpack(f"{n}f", blob))


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


# ── Singleton ──

_provider: EmbeddingProvider | None = None


def get_embedding_provider() -> EmbeddingProvider | None:
    return _provider


def init_embedding_provider(provider: EmbeddingProvider) -> None:
    global _provider
    _provider = provider
    log.info("Embedding provider set", {"name": provider.name, "dims": provider.dimensions})
