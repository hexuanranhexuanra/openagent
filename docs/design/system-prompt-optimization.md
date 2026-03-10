# System Prompt Optimization — Technical Design

## Current State

```
buildSystemPrompt(base, depth):
  1. base config prompt (static string, ~180 chars)
  2. SOUL.md (raw, no size limit)
  3. USER.md (raw, no size limit)
  4. WORLD.md (raw, no size limit)
  5. MEMORY.md (raw, no size limit)
  6. <skills> catalog (name: description list)
  7. EVOLUTION INSTRUCTIONS (depth=0: full guide / depth>0: tool list)

  return parts.join("")
```

**Problems:**
- No runtime context (OS, model, channel, cwd) — agent makes wrong assumptions
- No memory file budget — unbounded context consumption
- No safety section — only embedded in base prompt string
- No workspace guidance — agent doesn't know project root
- No prompt modes — subagents get nearly everything
- Sections are flat `---` delimited strings, not structured markdown

## Target State

```
buildSystemPrompt(params):
  ┌─ ALWAYS ──────────────────────────────────────────────┐
  │ 1. Identity          "You are OpenAgent..."            │
  │ 2. Safety            Anti-manipulation, human oversight│
  │ 3. Tool Call Style   Narration guidance                │
  │ 4. Workspace         cwd + file operation guidance     │
  │ 5. Runtime           OS, model, channel, shell, time   │
  ├─ FULL MODE ONLY (depth=0) ────────────────────────────┤
  │ 6. Skills            <skills> catalog (budgeted)       │
  │ 7. Memory Recall     How to use memory tools           │
  │ 8. Evolution         Create skills, update memory, etc │
  ├─ CONTEXT FILES (budgeted) ────────────────────────────┤
  │ 9. SOUL.md           Identity & persona (max 8K chars) │
  │10. USER.md           Preferences (max 8K chars)        │
  │11. WORLD.md          Knowledge (max 8K chars)          │
  │12. MEMORY.md         Consolidated facts (max 8K chars) │
  │    Total budget: 40K chars across all files            │
  ├─ MINIMAL MODE (depth>0, subagents) ───────────────────┤
  │ Only: Identity, Safety, Workspace, Runtime, SOUL.md    │
  │ Skip: Skills, Memory Recall, Evolution, USER/WORLD     │
  └────────────────────────────────────────────────────────┘
```

## Section Details

### Section 1: Identity (always)
Source: `config.agent.systemPrompt`. Wrapped in `## Identity`.

### Section 2: Safety (always)
Static section with anti-manipulation, human oversight, safeguard rules.

### Section 3: Tool Call Style (always)
Guidance on when to narrate vs. silently call tools.

### Section 4: Workspace (always)
Built from `process.cwd()`. Includes paths to config, user files, memory, skills.

### Section 5: Runtime (always)
OS, arch, shell, model name, channel, current timestamp + timezone.

### Section 6: Skills (full mode only)
Existing catalog logic with 30K char budget cap.

### Section 7: Memory Recall (full mode only)
Guidance on when/how to use memory_read before answering.

### Section 8: Evolution (full mode only)
Trimmed evolution tool instructions.

### Sections 9-12: Context Files (budgeted)
- Per-file: 8,000 chars max
- Total: 40,000 chars max
- Truncation: 70% head + 20% tail + "[...truncated...]" marker
- Subagents: only SOUL.md

## Prompt Mode Logic

| Section | full (depth=0) | minimal (depth>0) |
|---------|----------------|-------------------|
| Identity | ✓ | ✓ |
| Safety | ✓ | ✓ |
| Tool Call Style | ✓ | ✓ |
| Workspace | ✓ | ✓ |
| Runtime | ✓ | ✓ |
| Skills | ✓ | ✗ |
| Memory Recall | ✓ | ✗ |
| Evolution | ✓ | ✗ |
| SOUL.md | ✓ | ✓ |
| USER.md | ✓ | ✗ |
| WORLD.md | ✓ | ✗ |
| MEMORY.md | ✓ | ✗ |

## Token Budget

| Section | Est. chars | Est. tokens |
|---------|-----------|-------------|
| Identity | ~300 | ~75 |
| Safety | ~400 | ~100 |
| Tool Call Style | ~250 | ~60 |
| Workspace | ~300 | ~75 |
| Runtime | ~200 | ~50 |
| Skills | ~2,000 | ~500 |
| Memory Recall | ~200 | ~50 |
| Evolution | ~500 | ~125 |
| Context files | ~40,000 max | ~10,000 max |
| **Total (full)** | **~44,000** | **~11,000** |
| **Total (minimal)** | **~9,500** | **~2,400** |

## Files to Modify

- `src/agent/context.ts` — Rewrite `buildSystemPrompt()` with sections, budget, modes
- `src/config/schema.ts` — Add `agent.bootstrapMaxChars`, `agent.bootstrapTotalMaxChars`

## Date
2026-03-09
