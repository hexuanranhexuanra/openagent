# OpenAgent Memory System Design

## Overview

OpenAgent's memory system is a **two-tier, LLM-driven** architecture inspired by
Nanobot (simplicity, LLM consolidation) and OpenClaw (hybrid search, daily logs).

Design principles:
1. **Markdown-first** — human-readable, Git-friendly, no external dependencies
2. **LLM-driven consolidation** — semantic understanding replaces rule-based extraction
3. **Tiered storage** — hot data always in context, cold data searchable on demand
4. **Progressive enhancement** — grep → FTS5 → hybrid (future)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Agent Layer                            │
│  memory_read / memory_save / memory_search (tool calls)     │
├─────────────────────────────────────────────────────────────┤
│                   Search & Retrieval                        │
│  Level 1: keyword grep (default, zero dependency)           │
│  Level 2: SQLite FTS5 + BM25 (config: search_backend=fts)  │
│  Level 3: Hybrid Vector+FTS (future, not implemented)       │
├─────────────────────────────────────────────────────────────┤
│              Consolidation Engine                           │
│  LLM call + save_memory tool → structured extraction        │
│  Triggered: message threshold / /new command / context pressure │
├─────────────────────────────────────────────────────────────┤
│                   Storage Layer                             │
│  SOUL.md │ MEMORY.md │ HISTORY.md │ memory/YYYY-MM-DD.md   │
└─────────────────────────────────────────────────────────────┘
```

## Storage Layer

### Files

| File | Purpose | Loaded to Context | Write Method |
|------|---------|-------------------|--------------|
| `SOUL.md` | Agent identity/personality | Always | Human edit |
| `MEMORY.md` | Curated long-term memory (facts, preferences, decisions) | Always (main agent) | Agent via `memory_save` + consolidation engine |
| `HISTORY.md` | Append-only event summary log | Never (search on demand) | Consolidation engine only |
| `memory/YYYY-MM-DD.md` | Daily detail logs | Never (search on demand) | Consolidation engine |

### Migration from Legacy

The original system used three files (SOUL/USER/WORLD) all loaded into context.
On first startup, `USER.md` and `WORLD.md` are automatically merged into `MEMORY.md`.
Legacy files are preserved for backward compatibility but no longer loaded.

### MEMORY.md Format

Agent-editable Markdown, organized by topic:

```markdown
## User Preferences
- Prefers dark mode
- Communication: Chinese for discussion, English for code

## Project Context
- API uses OAuth2 with PKCE
- Database: PostgreSQL 15

## Technical Decisions
- Chose FastAPI over Flask for async support
```

### HISTORY.md Format

Append-only, each entry timestamped:

```
[2026-03-14 10:30] Discussed deployment strategy. User wants blue-green
deployment with Kubernetes. Decided to use ArgoCD for GitOps.

[2026-03-14 14:20] Debugged OAuth token refresh issue. Root cause: clock skew.
```

## Consolidation Engine

### How It Works

Consolidation is a **separate LLM call** (independent of the user conversation) that:
1. Takes old conversation messages + current MEMORY.md as input
2. Provides a `save_memory` tool as the only available tool
3. Forces the LLM to call `save_memory` with structured output
4. Persists the results to HISTORY.md and optionally updates MEMORY.md

This is the Nanobot pattern: using tool calls as a **structured output mechanism**
rather than parsing free-form LLM text (which is fragile).

### save_memory Tool

```python
save_memory(
    history_entry: str,    # Required: 2-5 sentence summary → HISTORY.md
    memory_update: str,    # Optional: updated MEMORY.md content (full replace)
)
```

The LLM is instructed to only provide `memory_update` when there is genuinely new
information worth remembering. Routine conversations produce only a `history_entry`.

### Trigger Conditions

| Trigger | Condition | Behavior |
|---------|-----------|----------|
| **Threshold** | `unconsolidated_messages >= consolidation_window` (default 50) | Background async task |
| **Session archive** | User runs `/new` command | Forced, synchronous, archives all messages |
| **Context pressure** | `prompt_tokens / context_window >= 0.65` | Auto-flush, once per session |

### Message Selection

```
Session messages: [0 ──── last_consolidated ──── (total - keep) ──── total]
                          ↑                      ↑                    ↑
                    already done           to_consolidate          keep in history
```

- Normal: consolidate `messages[last_consolidated : -keep_count]`, keep recent half
- Archive all (`/new`): consolidate everything, keep nothing

### Consolidation Pointer

Messages are **append-only** (not deleted). The session table has a
`last_consolidated` integer column that tracks how far consolidation has progressed.
`get_unconsolidated_messages()` returns only messages after this pointer, which is
what the agent sees as conversation history.

This design (from Nanobot):
- Preserves LLM cache efficiency (no message mutation)
- Ensures data safety (consolidation failure doesn't lose messages)
- Enables logical "forgetting" without physical deletion

### Concurrency Safety

```python
class ConsolidationManager:
    _active: set[str]                           # Sessions currently consolidating
    _locks: WeakValueDictionary[str, Lock]      # Per-session asyncio.Lock
    _tasks: set[asyncio.Task]                   # Strong refs prevent GC
```

- Same session cannot consolidate twice concurrently
- Lock is per-session, different sessions consolidate in parallel
- Background tasks are reference-held to prevent garbage collection

### LLM Provider Tolerance

Different LLM providers return tool call arguments in different formats:

```python
# OpenAI: dict
# Some providers: JSON string
# Others: list
def _parse_tool_call_args(raw_args) -> dict:
    if isinstance(raw_args, dict): return raw_args
    if isinstance(raw_args, str): return json.loads(raw_args)
    if isinstance(raw_args, list): return raw_args[0]
```

Fallback: if the LLM doesn't support tool calls, parse text as JSON.
Last resort: treat raw text as a history entry.

### Failure Handling

- Consolidation failure **does not move the pointer** — next trigger will retry
- Consolidation failure **does not clear session** — data safety first
- Errors are logged but non-fatal to the agent loop

## Search

### Level 1: Grep (Default)

Simple keyword matching across HISTORY.md and memory/*.md:

```python
async def search_grep(query, max_results=10):
    keywords = extract_keywords(query)  # tokenize + stop-word filter
    for file in searchable_files:
        for line in file:
            score = count(keyword matches) / len(keywords)
    return sorted(results, by=score)[:max_results]
```

Supports English and CJK. Stop-word filtering for common words.

### Level 2: SQLite FTS5

Enable via `memory.searchBackend: "fts"` in config.

- Uses SQLite's built-in FTS5 extension with BM25 ranking
- `unicode61` tokenizer for multi-language support
- Incremental sync: only re-indexes files whose SHA256 hash changed
- Markdown-aware chunking with line number mapping (~400 chars, 80 char overlap)
- FTS sync triggers keep the virtual table in sync with the chunks table

### Level 3: Hybrid Vector + FTS

Enable via `memory.searchBackend: "hybrid"` + configure `memory.embedding`.

Full OpenClaw-style retrieval pipeline:

```
Query → Embed → [Vector Search (cosine) ∥ FTS Search (BM25)]
                        ↓                         ↓
                   normalize 0-1             normalize 0-1
                        ↓                         ↓
                        └──── Weighted Merge ──────┘
                              (70% vector + 30% FTS)
                                       ↓
                               Temporal Decay
                          (exponential, half-life 30d)
                                       ↓
                                 MMR Reranking
                          (Jaccard-based diversity)
                                       ↓
                                   Results
```

#### Embedding Providers (`src/evolution/embeddings.py`)

Pluggable via `EmbeddingProvider` base class:

| Provider | Model | Config |
|----------|-------|--------|
| OpenAI (default) | text-embedding-3-small (1536d) | `memory.embedding.provider: "openai"` |
| (extensible) | Subclass `EmbeddingProvider` | — |

Features:
- Token-aware batching (max 8000 tokens per batch)
- SQLite-backed embedding cache (keyed by content hash + provider name)
- Binary blob storage (struct.pack float32) for compact vector storage
- Falls back to OpenAI provider config if embedding-specific keys not set

#### Chunking (`src/evolution/search.py`)

Markdown-aware chunking with line number preservation:

```python
@dataclass
class Chunk:
    path: str           # Source file path
    content: str        # Chunk text
    start_line: int     # First line in source file
    end_line: int       # Last line in source file
    content_hash: str   # For embedding cache lookup
```

- Splits at heading boundaries and paragraph breaks
- ~400 char chunks with ~80 char overlap for context continuity
- Line mapping enables `memory_get` tool for precise retrieval

#### Hybrid Merge

Score normalization (min-max to [0,1]) then weighted combination:

```
hybrid_score = vector_score × 0.7 + fts_score × 0.3
```

Results appearing in both vector and FTS get boosted (scores additive).

#### MMR Reranking

Maximal Marginal Relevance prevents redundant results:

```
MMR(d) = λ × relevance(d) − (1−λ) × max_similarity(d, selected)
```

- λ=0.7 (default): favors relevance but penalizes near-duplicates
- Uses word-level Jaccard similarity for diversity measurement
- Iteratively selects the best candidate considering both relevance and novelty

#### Temporal Decay

Exponential decay for dated files (`memory/YYYY-MM-DD.md`):

```
decay = 0.5 ^ (days_old / half_life_days)    # default half_life = 30
score *= decay
```

- MEMORY.md, SOUL.md, HISTORY.md → **evergreen** (no decay)
- Non-dated files → evergreen
- Only dated daily logs decay

#### SQLite Schema

```sql
-- File metadata (for incremental sync)
files (path PRIMARY KEY, hash, modified_at)

-- Chunks with line mapping + vector storage
chunks (id, path, content, content_hash, start_line, end_line, embedding BLOB)

-- FTS5 virtual table (auto-synced via triggers)
chunks_fts USING fts5(content, content='chunks', content_rowid='id')

-- Embedding cache (avoids recomputation across re-indexes)
embedding_cache (content_hash, provider, embedding BLOB)
```

## Agent Tools

Four memory tools replace the previous six:

### memory_read

Read any memory file by name or path:
- `MEMORY` → MEMORY.md (curated facts)
- `HISTORY` → HISTORY.md (event log)
- `SOUL` → SOUL.md (identity)
- `memory/2026-03-14.md` → daily log

### memory_save

Full-replace write to MEMORY.md. Agent reads current content first,
merges new information, writes back complete file. This ensures the agent
has full control over memory organization.

### memory_search

Keyword/semantic search across HISTORY.md and daily logs. Used when
MEMORY.md (already in context) doesn't have the needed information.
Dispatches to grep, FTS, or hybrid backend based on config. Returns
results with file path, line numbers, content snippet, and relevance score.

### memory_get

Read a specific line range from a file. Used after `memory_search` to get
full context around a search result. Takes `path`, `start_line`, `end_line`.

### notebook (formerly "memory" tool)

Per-peer isolated filesystem at `data/notebooks/<peer_id>/`.
Renamed to avoid confusion with the global memory system.
CRUD operations: view, create, edit, delete, ls.

## Context Injection

```python
async def build_system_prompt():
    sections = [
        identity,           # Base system prompt
        safety,             # Safety rules
        tool_call_style,    # Narration guidelines
        workspace,          # File paths and tool hints
        runtime,            # OS, model, time, channel
        skills,             # Available skills catalog
        memory_guide,       # How to use memory tools (always-on skill)
        evolution,          # Self-improvement tool list
        "# Agent Soul",     # SOUL.md content
        "# Memory",         # MEMORY.md content (main agent only)
    ]
```

Key change: MEMORY.md is injected as a dedicated `# Memory` section,
making it immediately visible to the agent without tool calls.
The Memory Guide section instructs the agent on when/how to use
memory_save and memory_search.

## Configuration

```python
class MemoryConfig:
    enabled: bool = True                      # Enable memory system
    consolidation_window: int = 50            # Messages before auto-consolidation
    consolidation_keep: int = 25              # Messages to keep after consolidation
    auto_flush_threshold: float = 0.65        # Context utilization trigger
    search_backend: "grep" | "fts" | "hybrid" # Search implementation
    daily_logs: bool = True                   # Generate memory/YYYY-MM-DD.md
    max_memory_chars: int = 8000              # Max chars to inject into context

class EmbeddingConfig:
    provider: "openai" | "none" = "none"      # Embedding provider
    model: str = "text-embedding-3-small"     # Embedding model
    api_key: str = ""                         # Falls back to providers.openai.apiKey
    base_url: str = ""                        # Falls back to providers.openai.baseUrl

class MemorySearchConfig:
    max_results: int = 6                      # Max search results
    min_score: float = 0.25                   # Minimum relevance score
    vector_weight: float = 0.7                # Hybrid: vector component weight
    text_weight: float = 0.3                  # Hybrid: FTS component weight
    mmr_enabled: bool = True                  # MMR diversity reranking
    mmr_lambda: float = 0.7                   # MMR: 0=diversity, 1=relevance
    temporal_decay_enabled: bool = True       # Exponential decay for dated files
    temporal_decay_half_life_days: int = 30   # Decay half-life in days
```

### Example Config (openagent.json)

```json
{
  "memory": {
    "searchBackend": "hybrid",
    "embedding": {
      "provider": "openai",
      "model": "text-embedding-3-small"
    },
    "search": {
      "maxResults": 6,
      "vectorWeight": 0.7,
      "textWeight": 0.3,
      "mmrEnabled": true,
      "temporalDecayEnabled": true
    }
  }
}
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/memory` | Get SOUL.md + MEMORY.md |
| `GET` | `/api/memory/{file}` | Read any memory file |
| `PUT` | `/api/memory/{file}` | Update a memory file |
| `GET` | `/api/memory/search?q=...` | Search memory (grep) |

## File Layout

```
src/
  evolution/
    memory.py           # MemoryStore (CRUD, grep search, migration)
    embeddings.py       # EmbeddingProvider base + OpenAI impl + EmbeddingCache
    search.py           # HybridMemoryIndex, hybrid merge, MMR, temporal decay
    consolidation.py    # ConsolidationManager (LLM-driven)
    reflection.py       # Deprecated, redirects to consolidation
  tools/builtins/
    evolution_tools.py  # memory_read/save/search/get + skills + self_modify
    notebook_tool.py    # Per-peer isolated filesystem (renamed from memory_tool.py)
  agents/
    context.py          # System prompt builder with MEMORY.md injection
    engine.py           # Post-task consolidation trigger
    init.py             # Tool registration + consolidation/embedding/index init
  sessions/
    manager.py          # Consolidation pointer management
  config/
    schema.py           # MemoryConfig, EmbeddingConfig, MemorySearchConfig
  gateway/routers/
    api.py              # Memory REST endpoints + search API

user-space/memory/
  SOUL.md               # Agent identity
  MEMORY.md             # Long-term curated memory
  HISTORY.md            # Append-only event log
  memory/               # Daily logs (YYYY-MM-DD.md)

data/
  memory_index.db       # SQLite: chunks, chunks_fts, files, embedding_cache
```

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| SOUL + MEMORY.md (not SOUL/USER/WORLD) | Simpler mental model; agents confused by 3-file split |
| LLM consolidation via tool call (not JSON parsing) | Structured output from any provider; type-safe |
| Append-only messages + pointer | LLM cache efficiency; data safety on failure |
| MEMORY.md always in context | Agent always has access to key facts; no retrieval needed |
| HISTORY.md NOT in context | Saves tokens; searchable on demand |
| 3-tier search (grep → FTS → hybrid) | Progressive enhancement; grep needs zero deps, hybrid needs embedding API |
| Hybrid = Vector 70% + FTS 30% | Semantic covers paraphrasing; FTS covers exact matches |
| MMR reranking | Prevents 10 near-identical results; diversity matters for recall |
| Temporal decay on dated files only | Recent events more relevant; evergreen facts don't decay |
| Embedding cache by content hash | Avoids recomputation when files are re-indexed without content change |
| Binary blob vectors (struct.pack) | Compact storage; no numpy dependency for core operation |
| Chunk line number mapping | Enables `memory_get` for precise context retrieval after search |
| Per-peer notebook (not "memory") | Clear separation: "memory" = agent's brain, "notebook" = user's scratchpad |
| Consolidation failure = no-op | Data safety > completeness; retry on next trigger |
