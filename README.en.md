# CORAL — A Lightweight Personal Agent Runtime

[简体中文](./README.md) | **English**

[![CI](https://github.com/Qiyao404/CORAL/actions/workflows/ci.yml/badge.svg)](https://github.com/Qiyao404/CORAL/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **Version: v2.4.0** · [Guided tour (DEMO.en.md)](DEMO.en.md) · [CHANGELOG](CHANGELOG.md)
> **Positioning: a local-first, single-command, single-file-storage personal agent runtime**

---

## Overview

CORAL is an LLM-powered personal agent runtime: it takes a natural-language goal, and the agent plans autonomously, calls tools, and reads/writes local files — fully observable, approvable, and interruptible, and it **gets better with use**.

- **Autonomous planning**: a checklist before work starts, updated live; long tasks get periodic nudges to persist reusable knowledge
- **Tool calling**: 24 built-in tools (files / Word / web / long-term memory / sub-agents / multi-agent teams / full-text search, …) + a 40-skill ecosystem
- **Deterministic discipline**: Fact Gate (read-before-write), Wrap-up Gate (rhetoric audit), tool effects contract (approval tiers derived from effects), external command guards (8 lifecycle points, pluggable)
- **Self-evolution loop**: post-run distillation drafts skill revisions / new-skill proposals / profile additions from real experience — all human-reviewed before landing; version history + diff + one-click rollback
- **Memory governance**: admission gate (environment snapshots / conversation recaps rejected) → auto-filing → full-preserve consolidation → automation isolation — four defense layers keeping the library small and valuable
- **Experience recall**: `session_search` full-text search across ALL past conversations (FTS5, CN/EN) — "that plan we discussed" hits the original trail
- **Multi-agent teams**: background named teammates running in parallel, step-boundary messaging, acyclic task board (CAS + optimistic locking), team-token watchdog
- **Exact replay**: every checkpoint carries the system prompt + model config; Time-Travel forks reproduce historical context verbatim
- **Observability**: streaming + event sourcing (fully persisted, replayable, exportable as Markdown or training-ready JSONL trajectories)
- **Local-first**: single-file SQLite, listens on 127.0.0.1 by default, keys never leave the machine, zero cloud dependency; bilingual UI (CN/EN one-click)

Without an API key, the full pipeline runs in demo mode (`npm run dev:server -- --demo`). `@coral/sdk` lets you `import` the kernel loop directly into your own program without running a server.

---

## Key Designs

Every mechanism below corresponds to a concrete implementation in this repository (modules, event names, and data paths can be located directly in the source); the names of the mechanisms (Fact Gate, Wrap-up Gate, evidence records, habit learning, …) are this project's own.

**1. Degraded tool-call normalization (provider layer)**
Some models intermittently print tool calls as non-standard marker text inside `content` instead of using the standard `tool_calls` channel. The provider layer performs split-based parsing over both full-width and ASCII marker forms; degraded calls execute as usual and are flagged `degraded`. On the streaming path, suspected marker prefixes are held in a buffer until confirmed non-markers, preventing garbled output and premature stream termination.

**2. Tool-name hallucination auto-correction (alias layer)**
Models may call tool names that do not exist. An alias table plus edit-distance (≤2) fuzzy matching auto-corrects to a real tool and tells the model which name actually ran; when correction is impossible, `TOOL_NOT_FOUND` is returned with the full list of available tools so the model can self-heal next turn.

**3. Triple safeguard for the task checklist**
Autonomous planning does not depend on model discipline: (1) the system prompt requires a checklist before work starts; (2) if the model skips it, the engine injects a one-time reminder (logged as a `loop.todo_reminder` event); (3) at terminal state the engine closes out stale checklist items itself — the UI never shows "work done but status stale".

**4. Event sourcing and run export**
Dual writes to the `events` table and the EventBus: every LLM call, tool execution, approval, and checklist change is a replayable event; a whole run can be exported as a Markdown timeline report in one click (`GET /api/runs/:id/export.md`).

**5. Multi-turn checkpoint continuation**
A checkpoint is persisted every step; the next turn of the same session automatically reloads the previous full context; after budget exhaustion, work resumes from the breakpoint.

**6. Context management**
Oversized single tool results are clipped automatically, history beyond the limit is summarized automatically, the original goal is always retained — long tasks never fail from context overflow.

**7. Cancellation and timeout semantics**
An AbortSignal runs through the entire chain (LLM calls, script process-tree termination); errors are classified as transient/permanent/cancelled with exponential backoff, and streaming calls that already delivered content are never retried (preventing duplicated output).

**8. File-based long-term memory with auto-distillation**
The `memory/` directory is plain Markdown exposed through four read/write tools; after a session ends, memories are distilled and archived automatically. Memory is text — edit it directly.

**9. Tool effects contract**
Every tool declares effect bits in `ToolEffects` (writes filesystem / launches process / accesses network / idempotent); the approval tier is derived from the effect combination by `derivePermission` rather than hand-annotated. Registration validates consistency between declaration and derivation — a declaration can only make approval stricter; annotations looser than the derived floor are automatically tightened at registration. Standard annotations of external MCP tools (readOnly / destructive / idempotent) map into the same contract.

**10. Evidence layer**
Output exceeding the per-tool result budget (`maxResultSizeChars`) is written whole into `data/evidence/{runId}/` (write-once, cleaned up when the run is deleted) and replaced in context by a "summary preview + record ID" object; when the model needs detail, `evidence_read` fetches it back with offset/limit pagination. The shelving layer archives old results into the evidence layer the same way.

**11. Three-tier context compression with usage warning**
Single-result clipping (always on) → shelving old tool results (soft watermark, archived to the evidence layer and recoverable) → full LLM summary (hard watermark); a four-level usage warning (normal / warning / critical / blocked).

**12. Fact Gate**
Before modifying or overwriting an existing file, that file must have been read in this task. `FactGate` scans message history for a successful read of the same path; if absent it returns `FACTS_REQUIRED` (retryable) with investigation instructions. After the same target is blocked three times in a row, it auto-releases and emits a warning event (`tool.fact_gate`) to prevent deadlock. New files are not gated — the permission tier governs them.

**13. Wrap-up Gate**
Final answers of complex tasks (≥3 write operations or ≥5 tool calls) are audited against a pattern library of rationalization phrasing (bilingual regex set): on hits like "legacy issue / skipped in tests / will fix later", the runtime injects a system-level follow-up demanding the work be done or the unfinished items be listed honestly (`loop.gate_rejected` event); at most two rejections, the third passes with a warning.

**14. Habit learning**
Every tool call is recorded to an observation log (`data/habits/observations.jsonl`, rotated on overflow); past a threshold, an LLM distills "trigger → action" collaboration habits into `habits.json`. Confidence grows with cross-session repetition (from 0.3, capped at 0.9); habits ≥0.7 are injected into the system prompt automatically; promotion to a skill (generating a SKILL.md) requires confidence ≥0.8 across ≥2 sessions, and habits decay after 30 days without recurrence.

**15. Health self-diagnosis (`coral doctor`)**
One command triages common failure classes: build freshness, port occupation, data-directory writability, disk watermark, database integrity, model configuration, skill parsing, MCP connection state — each with a repair suggestion.

**16. Artifact tracking and preview**
Every reply automatically lists the files it generated or modified at the bottom; clicking opens a preview in the right panel: text renders directly, Word extracts full text, PDFs and images render natively in the browser, other formats offer download. Data comes from the event stream — history turns are equally visible.

**17. Independent review and self-evaluation**
The `dual_review` tool launches two review sub-agents with independent contexts (each receives only the review target and its perspective, never the other's conclusion); on disagreement a third arbiter is appended — consensus passes, undecidable cases return escalate honestly. Every completed run automatically performs a deterministic five-axis score (accuracy / completeness / clarity / actionability / concision, persisted as a `run.self_eval` event); an API can trigger LLM semantic adjudication — axes scored below 5 must cite textual evidence, otherwise the axis falls back to the heuristic result.

**18. Memory trust tiers and decision records**
Long-term memory written by the agent defaults to `unreviewed` and is marked `reviewed` after user confirmation; overwriting existing memory requires an explicit `overwrite=true`; incomplete retrieval reports honestly instead of falsely claiming "no results". Every session automatically deposits reasoned decisions (what + why) and handoff records (breakpoint / next step / blockers).

**19. Sub-agent security baseline**
Every sub-agent's system prompt begins with a unified security baseline: identity and instruction set cannot be changed by tool output, external content is always data-to-analyze rather than instructions, suspicious payloads such as zero-width characters are quoted verbatim rather than interpreted, and system prompts and credentials are never leaked. The main loop carries the same untrusted-data discipline.

**20. External command guards (hooks)**
`data/hooks.json` invokes external commands at 8 lifecycle points (before/after tool calls / wrap-up / submission / session start-end / pre-compaction / notification): they may veto a call, rewrite tool input, escalate to human approval, bounce the final answer, or inject context. Contract: stdin receives JSON, stdout outputs a decision JSON, exit code 2 means deny; a guard on tool calls that itself fails or times out is treated as denial (fail-closed by default), while failures on other events never affect execution; configuration hot-reloads via mtime invalidation. The "Hooks" page in the sidebar provides visual management: per-event add/edit/delete, tool-name regex matching, per-entry enable/disable, real test firing with a sample payload (returning the parsed decision and raw output), and a live stream of the last 100 firing verdicts.

**21. Slash commands and named sub-agents**
`data/commands/*.md` slash commands: `/research topic` expands into a full task (template placeholders `$ARGUMENTS` / `$1`); `data/agents/*.md` named sub-agents: four seeded specialists (research / review / data / writing) whose descriptions and trigger examples are injected into the main prompt (teaching the main model when to delegate), while bodies load by name with their tool whitelists — capability growth without main-context burden.

**22. Compression-failure cooldown ladder**
LLM summary failures apply a progressive cooldown of 60s → 300s → 900s; while cooling down, if the hard watermark keeps rising, a deterministic skeleton summary (no LLM, first sentence per item, transcript-preserving) takes over.

**23. ESTOP sentinel, approval memory, and run budget**
`coral pause` suspends all new tasks via a sentinel file (running tasks unaffected; a corrupted sentinel also counts as paused — fail-safe); approvals may carry `scope=session`, auto-approving the same tool in the same workspace for this server session with an audit trail and one-click clearing; the run budget (token / step caps) is user-adjustable — default 1M tokens, maximum 10M.

**24. Dual-channel tool results**
A tool's return value used to be one JSON fed to both sides: the model needs it structured, parseable, lean; the UI tool card needs it human-readable — two demands pulling at the same data. `ToolResult` now splits into `data` and `display` channels: `data` goes into model context (structured data), `display` goes only to the UI event stream (a one-line human summary). Take `docx_write`:

- what the model sees: `{ "path": "report.docx", "paragraphs": 42, "note": "…" }`
- what the UI tool card shows: `Word document report.docx generated (42 paragraphs)`

Display wording no longer eats context budget, and the data channel is no longer polluted by display needs; tools without `display` fall back to a JSON preview of `data` (backward compatible). Eight high-frequency built-in tools (file read/write / list / edit / HTTP / shell / Word read-write) already carry summaries.

**25. Multi-agent team collaboration**
The `team_*` tool group upgrades one-shot delegation into a collaborating team: `team_spawn` spawns a **background named teammate** (returns immediately, runs in parallel, sharing every safety invariant of `agent_spawn`: tool subsets never exceed the parent set, budget clamping, depth limits, cancellation cascade); `team_send` is direct inter-agent messaging with **step-boundary delivery** — a running agent receives the message before its next LLM request (never lost, never interrupting the current step), drained by the loop after compression and before request assembly; `team_tasks` is a shared task board (`blockedBy` enforced acyclic, `revision` optimistic locking against clobbering, readiness derived from blocker completion); `team_wait` harvests teammates' final answers. Anti-runaway bounds: ≤16 members, ≤256 tasks, ≤16KB per message, names permanently occupied (failed members included, never reused); a team-token watchdog accumulates every teammate’s consumption — one-time warning at 80%, new spawns rejected at 100%. Suited to parallelizable independent subtasks (multi-path retrieval, cross-checking) — the Router watches the board, not the details; each Worker holds its own context window.

**26. Checkpoint exact replay**
"Model-visible is recorded": besides the message snapshot, every step's checkpoint carries the **system prompt** actually assembled at that moment and a **model configuration snapshot** (routing info), plus a context-operation audit trail (how many characters shelve/compress each reclaimed). When Time-Travel forks from a historical node, if the source checkpoint carries a system prompt it is **reproduced verbatim** — later changes to profile, habits, or personalization never affect the fork; "what did the model see at any step" can be retrieved as-is (`GET /api/runs/:id/checkpoints` returns a system-prompt preview and model config), and what compression dropped can be reconciled step by step. Old-format checkpoints naturally fall back to on-the-fly reassembly (backward compatible).

**27. Self-evolution loop (post-run distillation + memory governance)**
Two loops turn every run into fuel for improvement:

**Evolution pipeline**: after a run completes, at most one LLM call produces at most one evolution proposal by priority — (1) skill revision (skills used × negative signals ≥2 → LLM drafts a revision against the failure evidence); (2) new-skill draft (complex tasks distilled into reusable skills, deduplicated); (3) profile additions (≥24h throttle). Proposals never touch anything directly — the Skills and Settings pages review them; accepting applies (old version backed up to `.history/` + hot-reload). Paired with a **version safety net**: every skill's "History" button shows all versions with unified diff vs current, one-click rollback (the current version is auto-backed up before rollback — rollback itself is rollback-able).

**Memory governance system** (four defense layers keeping the library small and valuable):
- **Admission gate**: before creating a new memory file, an LLM checks admission rules — environment snapshots (rebuildable via fs_list) / conversation recaps (already covered by session_search) / volatile state → rejected with reason; user preferences, corrections, conventions, problem→solution lessons → accepted; user-instructed "remember this" bypasses the gate
- **Auto-filing**: accepted content is routed by LLM to the closest matching existing file (original preserved + dated section appended), genuinely new topics get new files — no fragmentation
- **Auto-consolidation**: >15 files triggers LLM topic grouping (target 5-12) + in-group full-preserve merge (every fact kept), originals backed up to `.history/` — verified live: 68 fragmented files → 9 topic files, zero fact loss
- **Automation isolation**: automated runs (sessionId prefix match: gaia-eval / pawbench / eval- / benchmark-) have memory_write denied by default — evaluation experience never pollutes the personal memory library

Paired with **memory nudges** (every 12 steps during long tasks, max 2) and **manual multi-select merge** (Settings page → LLM full-preserve merge with length-safety check).

**28. Full-text session search (experience recall)**
FTS5 trigram index (Chinese/English substring matching): at terminal state a run's goal, final answer, and message trail are rebuilt as its search documents; the `session_search` tool searches across ALL past runs and returns highlighted snippets with run locator — "that plan we discussed", "how we fixed that error last time" now hit the original trail instead of relying on distilled memories. Paired trajectory export: `GET /api/runs/:id/export.trajectory.jsonl` emits a training-ready trajectory (metadata with model config and system prompt + per-message lines, the same source as exact replay) for tool-calling model trajectory production.

---

## Feature Scope

Open the Chat page, describe a goal in one sentence, and the agent works autonomously:

- **Word documents**: upload `.docx`, read content, summarize key points, generate new documents (built-in OOXML read/write)
- **Local file I/O**: bind a workspace folder, then list/read/write files — writes show a diff approval card first (three permission tiers: read-only / ask / auto)
- **Command execution**: optional shell tool (every execution requires approval)
- **Web access**: fetch any URL and read its main content; blocked pages automatically walk a recovery ladder (archived copies → same-site API → alternate sources)
- **Multi-agent teams**: `team_spawn` background named teammates in parallel, step-boundary messaging, shared task board (acyclic DAG + optimistic locking), `team_wait` harvesting — team-token watchdog prevents runaway
- **Experience recall**: `session_search` full-text search across all past conversations — "that plan we discussed" hits the original trail and final answer
- **Self-evolution**: post-run distillation drafts skill revisions from failures, new skills from complex tasks, profile additions from conversations — all human-reviewed; version history + diff + one-click rollback
- **Long-term memory**: four-layer governance (admission gate → auto-filing → consolidation → automation isolation) keeps the library small and valuable; memory is plain editable Markdown
- **Scheduled tasks**: cron / interval / webhook triggers; with a session ID, recurring tasks land on the same conversation line forming a continuous record
- **Skill ecosystem**: 40 built-in skills + conversational creation + `coral install` npm/git packages + evolution proposals for continuous improvement
- **SDK embedding**: `@coral/sdk` `runAgent()` runs the kernel loop without a server; `createRuntime()` brings full persistence
- **Interface language**: one-click Chinese/English switching (sidebar and settings; preference persisted)

See [USE.md](./USE.md) for the full usage guide and task examples.

---

## Quick Start

**Option 1: single command (recommended)** — integrated build artifacts, self-check, then start:

```bash
npm install && npm run build && npm start   # coral CLI: self-check (port/db/model) → http://127.0.0.1:3001
```

**Option 2: development mode** (split front/back with hot reload):

```bash
npm install
cp .env.example .env   # fill in an API key (any OpenAI-compatible endpoint)
npm run dev            # backend 3001 + frontend 5173
```

| Service | Address |
|------|------|
| Web UI (Chat / Skills / Tasks / Settings) | http://localhost:5173 |
| Backend API | http://localhost:3001/api/health |

Verified against DeepSeek and DashScope; any OpenAI-compatible endpoint (OpenRouter / Ollama / …) works out of the box.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  Web UI                                                               │
│  Chat (agent sessions: todo list / tool cards / diff approvals /      │
│  artifact preview) Skills (list/edit/import/conversational creation) │
│  Tasks (v1 DAG orchestration) Settings (model/workspace/memory/budget)│
└──────────────────────────────┬───────────────────────────────────────┘
                               │ REST + WS + SSE
┌──────────────────────────────▼───────────────────────────────────────┐
│  RunEngine (free-mode entry: budget / cancellation / event sourcing)  │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  Agent Loop (ReAct main loop)                                   │ │
│  │  compression check → LLM → tool exec (Fact Gate→guards→approval)│ │
│  │  → budget → checkpoint                                          │ │
│  │  ├─ todo safeguards (mandatory start / skip reminder / closeout)│ │
│  │  ├─ fake-final guards (empty answer / pending todos / rhetoric) │ │
│  │  ├─ sub-agents + team (background mates / step-boundary msg /   │ │
│  │  │  task board / watchdog)                                       │ │
│  │  ├─ context management (clip + shelve + summarize + cooldown)   │ │
│  │  └─ post-run distillation (skill revision / new skill / profile  │ │
│  │     proposals → human review → hot reload)                       │ │
│  └───────────────────────────┬─────────────────────────────────────┘ │
│                              │ unified Tool interface                 │
│  ┌───────────────────────────▼─────────────────────────────────────┐ │
│  │  Tool Registry: 24 built-in tools (fs / docx / http / shell /   │ │
│  │  memory / team / session_search / evidence …)│ Skills (40)│ MCP  │ │
│  └───────────────────────────┬─────────────────────────────────────┘ │
│  providers: OpenAI-compatible (DashScope/DeepSeek/OpenRouter/Ollama…)│
│            + degraded-call normalization + name correction + stream  │
│              withholding                                              │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
   SQLite (single file, WAL): runs / events / checkpoints / llm_profiles / …
   Event sourcing: per-step checkpoints + full event log, streamed over
   WS/SSE, replayable and exportable
```

---

## Tech Stack

| Layer | Technology |
|---|------|
| Frontend | React 19 + Vite 6 + Tailwind 3 + React-Flow + Lucide + Web Speech API (voice input) |
| Backend | Node.js ≥ 20 + Fastify 5 + TypeScript 5 (strict) + ESM |
| LLM | openai SDK (any compatible endpoint: DashScope / DeepSeek / OpenRouter / Ollama…), retry-classified transport |
| Persistence | SQLite (better-sqlite3, WAL mode, versioned schema migrations) |
| Skills | YAML frontmatter (gray-matter) + chokidar hot reload |
| Progress protocol | in-house `[CORAL_PROGRESS]` single-line stderr JSON protocol (Python + Node SDKs, see [docs/AUTHORING_PROGRESS.md](./docs/AUTHORING_PROGRESS.md)) |
| Quality | Vitest (446 cases) + GitHub Actions (ubuntu/windows/macos × Node 20/22) |

---

## Tests & Benchmarks

- **Tests**: 446 cases (Vitest) covering the kernel loop / gates / context management / persistence / MCP / skill runtime / external guards / team collaboration; CI passes on three platforms (ubuntu / windows / macos × Node 20/22).
- **GAIA benchmark**: [docs/GAIA.md](./docs/GAIA.md) — official GAIA benchmark validation split, **84.8%** (66 questions, deterministic exact match). L1 85.7% / L2 95.5% / L3 68.8%.
- **Performance**: [docs/BENCHMARK.md](./docs/BENCHMARK.md) — context-compression gains (1.2MB history → 169KB, −86%), SQLite WAL and JSONL persistence throughput. Script: `npx tsx scripts/benchmark.mts`.

---

## Model Routing

`POST /api/runs` accepts a `modelProfileId` — each run can independently select an LLM profile, for scenarios like "light model for simple tasks, strong model for hard ones". Routing applies at run level and never touches the global active configuration.

---

## Personalization

Six "learns as you use it" dimensions, **all OFF by default**, toggled individually in Settings:

| Dimension | Capability |
|---|---|
| Dynamic interest tags | Extracts interest areas from your questions; answers relate to them where apt |
| Adaptive interaction style | Learns preferences (length/format/tone) from your corrections; adjusts next time |
| Work-rhythm awareness | Records active hours; adapts response strategy by time of day |
| Cross-session knowledge graph | Links concepts discussed across different conversations |
| Proactive suggestions | Suggests next steps based on current context and historical interests |
| Implicit preference inference | Infers preferences from rejections/corrections — no manual setup |

Data stays local (`data/personalization/`); one-click wipe.

---

## Built-in Tools (24)

| Tool | Description | Permission |
|------|------|------|
| `todo_write` | Visible task checklist (full-replace, live UI updates) | auto |
| `fs_list` / `fs_read` / `fs_search` | List dir / read text / keyword search (binaries skipped with a note) | auto (read-only) |
| `fs_write` / `fs_edit` | Write file / exact-snippet edit (unified diff output, approval-gated; editing an existing file requires a prior read — Fact Gate enforced) | per workspace tier |
| `docx_read` / `docx_write` | Word .docx read/write (pure standard-library OOXML) | read auto / write per tier |
| `http_fetch` | Fetch any URL and read it | auto |
| `shell_run` | Run commands (sandboxed env whitelist + process-tree termination) | always approval |
| `memory_list` / `memory_read` / `memory_write` / `memory_search` / `memory_review` | Long-term memory I/O (Markdown files; writes default create-only, overwrites need explicit `overwrite`; review marks user confirmation) | auto |
| `agent_spawn` | Spawn a sub-agent (own context / tool subset / depth ≤ 2 / unified security baseline) | auto |
| `team_spawn` / `team_send` / `team_tasks` / `team_wait` | Multi-agent team: background named teammates / step-boundary direct messages / shared task board (CAS + acyclic DAG) / final-answer harvesting | auto |
| `session_search` | Full-text search across all past runs (FTS5, CN/EN; experience recall) | auto |
| `past_runs` | Retrieve past runs | auto |
| `evidence_read` | Fetch evidence records (immutable archive of oversized tool results, paginated) | auto |
| `dual_review` | Dual independent review with disagreement arbitration | auto |

---

## Skill Ecosystem

### Built-in Skills (40)

#### Documents & Writing
| Skill | Mode | Description |
|-------|:--:|------|
| `summarize-document` | llm_only | Document summarization |
| `official-doc-writer` | llm_only | Official document text generation (notices, minutes, …) |
| `official-doc-expander` | hybrid | Expands outlines into GB/T 9704-2012-compliant official documents |
| `official-document-generator` | hybrid | Outline → AI-assisted expansion → official document .docx |
| `email-draft` | llm_only | Email drafting (formal/informal/business/thank-you/follow-up, subject lines included) |
| `meeting-notes` | llm_only | Meeting minutes (attendees / topics / decisions / action items) |

#### Data & Computation
| Skill | Mode | Description |
|-------|:--:|------|
| `data-transform` | llm_only | Data format conversion and structuring |
| `csv-insight` | llm_only | CSV data analysis |
| `code-exec` | script | Sandboxed Python execution (computation / conversion / data analysis) |
| `chart-maker` | llm_only | Data visualization (SVG bar/line/pie) |
| `excel-writer` | llm_only | Excel generation (openpyxl or CSV) |

#### Search & Research
| Skill | Mode | Description |
|-------|:--:|------|
| `deep-research` | llm_only | Deep research: sub-question decomposition → multi-source retrieval → cross-verification → cited report |
| `web-reader` | script | Web main-content extraction (zero-dependency readability) |
| `web-search` | script | Web search (three-tier backends: Tavily / SearXNG / keyless fallback) |
| `web-digest` | script | Web summary archiving |
| `api-finder` | llm_only | API-first strategy (quick-reference for PubChem/Wikipedia/GitHub APIs) |
| `archive-search` | llm_only | Archive retrieval (government documents / historical databases) |
| `blocked-page-recovery` | llm_only | Blocked-page recovery ladder (archived copies → same-site API → alternate sources; 403/paywall/WAF fallbacks) |
| `grounded-citations` | llm_only | Grounded citations: URL + verbatim snippet + confidence tier per key claim |
| `legal-search` | llm_only | Legal research (Chinese statutes / case law / judicial interpretations) |
| `pdf-reader` | llm_only | PDF text extraction |
| `intel-collector` | llm_only | Intelligence collection: gather → distill → incremental archive |
| `arxiv-daily` | script | arXiv paper digest |
| `github-repo-report` | script | GitHub repository report |
| `information-filter` | script | Multi-source information filtering |
| `policy-scraper` | script | Policy collection (streaming + MD/CSV dual artifacts) |
| `policy-to-post` | script | Policy-to-post rewriting |

#### Decision & Quality
| Skill | Mode | Description |
|-------|:--:|------|
| `goal-blueprint` | llm_only | Blueprint planning: goal → self-contained execution plan (dependencies / parallel groups / adversarial review) |
| `council-review` | llm_only | Council review: four independent perspectives + disagreement arbitration + dissent archive |
| `decision-ledger` | llm_only | Decision ledger: append-only multi-round comparison + consistency checks + promotion threshold |
| `answer-check` | llm_only | Answer self-check (units / magnitude / format / common sense) |
| `systematic-debugging` | llm_only | Four-phase root-cause debugging (reproduce → hypothesize → minimal verify → fix with regression) |
| `prompt-doctor` | llm_only | Prompt review: five-dimension check and revision |

#### Domain & Efficiency
| Skill | Mode | Description |
|-------|:--:|------|
| `geo-calc` | llm_only | Geo computation (capital coordinates + Haversine distance) |
| `chem-db` | llm_only | Chemistry database lookup (PubChem API + EC/CAS distinction) |
| `site-sentinel` | llm_only | Site health check (eight-signal post-release smoke test) |
| `story-board` | llm_only | File-based project management: epic → story → sprint |
| `schedule-plan` | llm_only | Schedule planning (priority matrix + time-block allocation) |
| `weekly-review-planning` | llm_only | Weekly review and next-week planning (evidence from sessions/runs/memory; trigger-friendly) |
| `document-action-items` | llm_only | Document to action items (obligations/deadlines/tasks, each with verbatim citation) |
| `price-watch` | llm_only | Price watch (one-shot check or trigger-driven patrols with a running price log) |
| `skill-authoring` | llm_only | Skill authoring standard: dedup / naming / quality self-check |

### Creating Custom Skills

**Option 1: conversational UI** — describe the need on the "Skill Builder" page; the AI asks clarifying questions, then generates (with Node script templates and a submission quality gate); saved to disk, hot-loaded instantly.

**Option 2: hand-write a SKILL.md**:

```markdown
---
name: my-skill
version: "1.0.0"
description: "My custom skill description"
domain: custom
capabilities: [my_capability]
input_schema:
  type: object
  required: [input_text]
  properties:
    input_text: { type: string }
output_schema:
  type: object
  properties:
    result: { type: string }
execution_mode: llm_only
status: stable
tags: [custom]
source: user
---

# My custom skill

You are a professional assistant. Complete the following task from user input...
```

Save to `skills/my-skill/SKILL.md` and it loads automatically. Full specification: [docs/SKILLS-STANDARD.md](./docs/SKILLS-STANDARD.md).

**Option 3: skill-package installation (`coral install`)** — use skills made by others directly.

The first two options both require the skill to be "at hand": describe it for the AI to generate, or write the SKILL.md yourself. Package distribution solves **reuse** — one skill or a group of skills is packaged as a standard npm package or hosted in a git repository, and anyone installs it into their skill library with one command:

```bash
coral install npm:some-skill-pack        # npm source: resolve exact version → isolated install → locate skills
coral install https://github.com/u/repo  # git source (GitHub tree subpaths supported)
coral install ./path/to/skill-dir        # local directory
```

- **Package convention**: multi-skill packages put each skill in a first-level `skills/` subdirectory; single-skill packages put `SKILL.md` at the package root; frontmatter is compatible with the common Agent Skills format (defaults map to `llm_only`).
- **Supply-chain safety**: npm sources install into a temporary directory with `--ignore-scripts` — install/preinstall scripts of external packages **never execute**; only SKILL.md and auxiliary files are migrated, never touching the host `node_modules`.
- **Conflict policy**: same-name skills are skipped by default; `--overwrite` replaces with the old version backed up into `skills/.history/`.
- Saved to disk means hot-loaded; equivalent API: `POST /api/skills/import` (source accepts the `npm:` prefix).

---

## SDK Embedding (`@coral/sdk`)

CORAL has two usage shapes. The **service shape**: run the HTTP service + Web UI, for human interaction. The **library shape**: `import` the kernel directly into your own Node program — for embedding the agent loop into scripts, CI pipelines, bots, or another application, without starting a service and speaking REST just to run one agent task, and without losing types.

Previously only the service shape existed; `packages/sdk` adds the library shape with two entry tiers by embedding depth:

**`runAgent(input)` — stateless single task**. You provide three things: a goal, model access (an OpenAI-compatible `chat` function, req → resp — hence not bound to any provider: gateway, local model, or test stub all work), and optionally tools. It executes the kernel ReAct loop directly with every discipline layer active — Fact Gate, Wrap-up Gate, context compression, evidence records — but writes no database; when the task ends, it ends. Suited to "run an agent on demand inside my code":

```ts
import { runAgent, toolOk } from '@coral/sdk';

const result = await runAgent({
  goal: 'Summarize the changes under ./docs',
  chat: async req => myOpenAiCompatCall(req),   // your own model access
  tools: [myCustomTool],                          // toolOk({ data }, 'UI summary')
  onEvent: e => console.log(e.type),              // tool calls / gate rejections / todos …
});
// result.status === 'completed'; result.finalContent is the final answer
```

**`createRuntime(opts)` — stateful runtime**. When a task needs continuity across executions, use this tier: it assembles the full engine (SQLite three-table persistence + filesystem skill registry) — equivalent to embedding the server-side engine. Run records, event streams, checkpoints, and Time-Travel are all available; sharing the data directory with the Web UI, SDK-initiated runs can even be reviewed in the interface.

Design intent of the tiering: lightweight scenarios carry no persistence dependency (`runAgent` never touches SQLite); upgrade to `createRuntime` when continuity is needed — both tiers share the same tool protocol and gate semantics.

---

## Core Capabilities in Depth

### Agentic Workspace (local file I/O)
- Multiple workspaces: named bindings to local folders, switch anytime, selection persisted
- Three permission tiers: `readonly` / `ask` (default; writes need approval) / `auto`
- Triple path guard: out-of-bounds / sibling-prefix / symlink escapes all intercepted
- File upload: upload files into the workspace from the Chat page; attachments shown with messages

### Long-term Memory (file-based)
- `memory/` directory + Markdown; the agent records autonomously (user preferences, project conventions, lessons learned)
- Auto-distillation and archiving after sessions (disableable); visual editing in Settings
- Trust tiers: agent writes default to `unreviewed`; marked `reviewed` after user confirmation
- Four-layer governance: admission gate (environment snapshots / conversation recaps rejected) → auto-filing (topic-matched merge) → auto-consolidation (>15 triggers full-preserve merge down to 5-12) → automation isolation (automated runs denied by default); manual multi-select merge in Settings

### Dual execution semantics (v1 DAG orchestration retained)
- DAG scheduling: goal → planning engine → concurrent multi-skill execution with short-circuiting
- Retry semantics: skill-granular retries; completed nodes never re-run
- Budget guardrails: step/token dual caps with graceful wrap-up on exhaustion; resumable from breakpoints

---

## Key API Endpoints

| Method | Path | Description |
|------|------|------|
| GET | `/api/health` · `/api/stats` · `/api/config` | Health / stats / config (keys masked) |
| POST | `/api/runs` | Start a run (goal + sessionId + workspaceId + budget) |
| GET | `/api/runs/:id` · `/events` · `/stream` | Detail / event delta / SSE live stream |
| GET | `/api/runs/:id/export.md` · `/export.trajectory.jsonl` · `/artifacts` | Export run report / training trajectory (metadata + messages) / artifact list |
| POST | `/api/runs/:id/cancel` · `/approvals/:aid` | Cancel / approval decision (scope=session supported) |
| GET/POST/PATCH/DELETE | `/api/workspaces` | Workspace CRUD + file upload / preview |
| GET/PUT/DELETE | `/api/skills/:name` | Skill query / edit / delete (built-ins need double confirmation) |
| POST | `/api/skills/import` | Import Agent Skills (directory / git URL / npm:) |
| POST | `/api/skill-builder/sessions…` | Conversational skill creation |
| GET/PUT/DELETE | `/api/memory…` | Memory management (same source as Settings UI) |
| GET/PUT | `/api/settings/run-budget` | Run budget (token / step caps) |
| GET | `/api/habits` · POST `/api/habits/distill` | Habit learning (list / manual distill / promotion) |
| GET | `/api/system/gc` · POST `/api/system/gc` | Config self-cleanup (scan / itemized confirm-and-clean) |
| POST | `/api/prompt-optimize` | Prompt optimization |
| GET/POST | `/api/evolution/proposals…` | Evolution proposals (list / human decision: skill revisions · new skills · profile) |
| POST | `/api/tasks` (v1 DAG mode) | Plan → DAG → skill orchestration |
| WS | `/ws/events` | WebSocket global event stream |

---

## Project Structure

```
CORAL/
├── LICENSE · .env.example · README.md · README.en.md · USE.md · DEMO.md · DEMO.en.md
├── docs/                       ← public docs (skill standard / progress protocol / benchmarks / architecture history)
├── .github/workflows/ci.yml    ← CI: three platforms × Node 20/22
├── scripts/                    ← dev / start / benchmark scripts
├── packages/
│   ├── server/                 ← Fastify backend
│   │   └── src/
│   │       ├── kernel/         ← Agent Loop / RunEngine / context management / gates / evidence layer
│   │       ├── tools/          ← unified Tool abstraction + built-ins + effects contract
│   │       ├── hooks/          ← external command guards (8 lifecycle events)
│   │       ├── providers/      ← LLM access (retry classification / degraded-call normalization)
│   │       ├── skill-runtime/  ← SKILL.md registry / parsing / importing / hot reload / progress protocol
│   │       ├── scheduler/      ← v1 DAG scheduler (cancel/timeout/retry semantics)
│   │       ├── planning/       ← v1 planning engine (goal → DAG)
│   │       ├── store/          ← SQLite + versioned migrations + repositories
│   │       ├── api/            ← REST routes
│   │       ├── event/          ← event bus (WS/SSE dual channel)
│   │       └── services/       ← LLM facade / config / memory / workspaces / habits / budget
│   ├── web/                    ← React frontend (chat sessions / DAG visualization / memory UI)
│   └── progress/               ← @coral/progress progress-protocol SDK (Node)
└── skills/                     ← skill directory (filesystem as registry, hot reload)
    └── _lib/                   ← progress-protocol helpers (Python + Node) + readability
```

---

## Limitations

- **Single-user, single-process**: designed for personal local use; no multi-tenancy or concurrent task pools. ESTOP and approval memory are process-level semantics.
- **Compression is lossy**: context shelving and summarization drop the body of old tool results (recoverable via evidence records); the deterministic fallback summary is lower quality than the LLM summary.
- **Review and adjudication share one LLM**: the semantic layer of independent review and self-evaluation runs on the same model — weaker independence than human review; the deterministic heuristic layer is unaffected.
- **Gates are heuristic**: the Wrap-up Gate pattern library and Fact Gate rules cannot cover every phrasing; both have forced-release plus warning to avoid blocking delivery.
- **MCP stdio execution boundary**: external MCP servers run as local subprocesses; their capability boundary is determined by their own implementations; the platform constrains via annotation mapping and approval tiers.

---

## Authors

**[Qiyao404](https://github.com/Qiyao404)** · **[alstar501](https://github.com/alstar501)** — joint development

## License

[MIT](./LICENSE) © 2026 Qiyao404 & alstar501
