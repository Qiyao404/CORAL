# CORAL — A Local-First Personal Agent Runtime

[简体中文](./README.md) | **English**

[![CI](https://github.com/Qiyao404/CORAL/actions/workflows/ci.yml/badge.svg)](https://github.com/Qiyao404/CORAL/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **Version: v2.0.0-M1 (actively iterating)**
> **Positioning: a local-first, single-command, single-file-storage personal agent runtime**

---

## In one sentence

CORAL is an **LLM-native personal agent runtime**: give it a natural-language goal (voice input supported) and the agent plans autonomously, calls tools, reads & writes your local files — fully observable, approval-gated, and interruptible:

- **Autonomous planning**: the agent opens with a todo checklist and ticks items off as it works — you watch it live
- **Tool calls**: 16 built-in tools (file I/O / Word documents / web fetch / long-term memory / sub-agents…) plus a skill ecosystem
- **Fully observable**: token-by-token streaming + event sourcing (every event persisted — replayable, exportable as a Markdown report)
- **Live-connected**: SSE / WebSocket dual channels; every step (including approval cards) reaches the browser instantly
- **Local-first**: SQLite single-file storage, listens on 127.0.0.1 by default, keys never leave your machine, zero cloud dependencies

> No API key? `npm run dev:server -- --demo` runs the whole pipeline in demo mode (results carry mock markers — never passed off as real output).

---

## Engineering highlights: battle scars from real models

These are the things that separate CORAL from "yet another agent demo" — each one surfaced and fixed during long-running real-model testing (DeepSeek / Kimi):

**1. DSML degradation normalization (provider layer)**
DeepSeek V3.2 intermittently prints tool calls as `<｜｜DSML｜｜ invoke name="...">` text inside content instead of using the standard tool_calls channel. CORAL normalizes this at the provider layer with **split-based parsing** (immune to full-width/ASCII marker variants); degraded calls still execute and are flagged `degraded`. On the streaming path, a **cursor-withholding algorithm** holds suspected marker prefixes in a buffer until confirmed — no garbage leaks to the user's screen, and the stream is never cut early.

**2. Tool-name hallucination auto-correction (alias layer)**
Models hallucinate nonexistent tool names (`web_fetch`, `fetch_url`…). An alias table plus edit-distance ≤ 2 fuzzy matching auto-corrects to the real tool and tells the model what it was corrected to; uncorrectable calls return `TOOL_NOT_FOUND` with the full available-tool list so the model self-heals next turn.

**3. Triple-guaranteed todo checklist (observability)**
"Autonomous planning" must not depend on model goodwill: ① the system prompt mandates an opening `todo_write`; ② if the model skips it, the engine injects a one-shot reminder (traced as `loop.todo_reminder`); ③ terminal-state auto-close — the model forgot to mark the last item completed? The engine synthesizes a final `todo.updated`, so the UI never shows a spinner on a finished run.

**4. Event sourcing + run export**
Dual-write to the `events` table and EventBus: every LLM call, tool execution, approval, and checklist change is a replayable event; export any run as a Markdown timeline report (`GET /api/runs/:id/export.md`).

**5. Multi-turn checkpoint continuation**
The agent checkpoints every step; the next turn in the same session loads the full previous context (files read, tool calls made), and a budget-exhausted run can be **continued** from where it stopped with one click.

**6. Context management (long tasks don't collapse)**
Oversized tool results are clipped automatically and overflowing history is summarized — the goal is never lost. A 16-step Word-analysis task doesn't amnesia out mid-flight.

**7. Real cancellation / real timeouts / retry taxonomy (M0 foundation)**
AbortSignal threads through everything (LLM calls, script process-tree kills); errors are classified (transient/permanent/cancelled) with exponential backoff, and streams that already delivered content are never retried (no duplicated output).

**8. File-based long-term memory + auto-distillation**
`memory/` is plain Markdown with four tools (`memory_list/read/write/search`); the agent records preferences and lessons per guidance and distills archives after sessions — you can open and edit it anytime. Transparent and trustworthy.

---

## What can it do?

Open the Chat page, describe your goal in one sentence, and the agent **works autonomously**:

- **Read & write Word docs**: upload a `.docx`; the agent reads it, summarizes, generates new documents (built-in OOXML handling, zero Python dependency)
- **Read & write your local files**: bind a workspace folder and the agent lists, reads, and edits files — every modification pops a **diff approval card** before touching disk (three permission modes: readonly / ask / auto)
- **Run commands**: optional shell tool (every execution requires approval) — real scripts, real installs
- **Web access**: give it any URL and it fetches and reads the article body (zero-dependency readability extraction)
- **Spawn sub-agents**: long tasks are isolated into independently-contexted sub-agents (depth ≤ 2), keeping the main thread clean
- **Skill ecosystem**: create skills conversationally, import Anthropic Agent Skills in one click, filesystem-as-registry hot reload

Full usage guide / task examples / troubleshooting → [USE.md](./USE.md)

---

## Quick start

```bash
# 1. Install dependencies (Node.js ≥ 20)
npm install

# 2. Configure environment (any OpenAI-compatible endpoint works)
cp .env.example .env

# 3. Start (backend 3001 + frontend 5173)
npm run dev
```

```bash
# No API key? Demo mode runs the whole pipeline (results carry mock markers)
npm run dev:server -- --demo
```

| Service | Address |
|------|------|
| Web UI (Chat / Skills / Tasks / Settings) | http://localhost:5173 |
| Backend API | http://localhost:3001/api/health |

Tested against DeepSeek and DashScope (Kimi); OpenRouter / Ollama and any OpenAI-compatible endpoint work out of the box.

---

## Architecture (v2)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Web UI                                                               │
│  Chat (live agent session: todo checklist / tool cards / diff         │
│  approvals / final answer)  Skills (list/edit/import/build)          │
│  Tasks (v1 DAG)  Settings (models/workspaces/memory)                 │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ REST + WS + SSE
┌──────────────────────────────▼───────────────────────────────────────┐
│  RunEngine (Free-mode entry: budget guardrails / cancel / dual-write) │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  Agent Loop (ReAct main loop)                                   │ │
│  │  compress check → LLM → tool exec (approval gate) → budget      │ │
│  │  → checkpoint                                                    │ │
│  │  ├─ todo guarantees (forced open / skip reminder / final close)  │ │
│  │  ├─ sub-agents (agent_spawn: own context / tool subset / ≤2)     │ │
│  │  └─ context management (result clipping + history compression,   │ │
│  │     goal never lost)                                             │ │
│  └───────────────────────────┬─────────────────────────────────────┘ │
│                              │ unified Tool interface                 │
│  ┌───────────────────────────▼─────────────────────────────────────┐ │
│  │  Tool Registry: 16 built-ins (fs / docx / http / shell / memory /│ │
│  │  todo / spawn / past_runs) │ Skills (SKILL.md hot reload) │ MCP  │ │
│  └───────────────────────────┬─────────────────────────────────────┘ │
│  providers: OpenAI-compatible (DashScope/DeepSeek/OpenRouter/Ollama)  │
│             + DSML normalization + tool-name correction + stream      │
│               withholding                                             │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
   SQLite (WAL single file): runs / events / checkpoints / llm_profiles
   Event sourcing: per-step checkpoints + full event log, WS/SSE live,
   replayable & exportable
```

---

## Tech stack

| Layer | Technology |
|---|------|
| Frontend | React 19 + Vite 6 + Tailwind 3 + React-Flow + Lucide + Web Speech API (voice input) |
| Backend | Node.js ≥ 20 + Fastify 5 + TypeScript 5 (strict) + ESM |
| LLM | openai SDK (any compatible endpoint: DashScope / DeepSeek / OpenRouter / Ollama…), retry-taxonomy transport |
| Persistence | SQLite (better-sqlite3, WAL, versioned schema migrations) |
| Skills | YAML frontmatter (gray-matter) + chokidar hot reload |
| Progress protocol | Custom `[CORAL_PROGRESS]` single-line JSON on stderr (Python + Node SDKs, see [docs/AUTHORING_PROGRESS.md](./docs/AUTHORING_PROGRESS.md)) |
| Quality | Vitest (299 tests) + GitHub Actions (ubuntu/windows/macos × Node 20/22) |

---

## Built-in tools (16)

| Tool | Description | Permission |
|------|------|------|
| `todo_write` | Visible task checklist (full replace, live ticks in UI) | auto |
| `fs_list` / `fs_read` / `fs_search` | List / read text / keyword search (binaries skipped with a hint) | auto (read-only) |
| `fs_write` / `fs_edit` | Write file / precise fragment edit (unified diff, approval-gated) | follows workspace mode |
| `docx_read` / `docx_write` | Word .docx read/write (pure-stdlib OOXML, zero Python) | read auto / write follows mode |
| `http_fetch` | Fetch and read any URL | auto |
| `shell_run` | Run commands (sandboxed env allowlist + process-tree kill) | **always approval** |
| `memory_list` / `memory_read` / `memory_write` / `memory_search` | Long-term memory quartet (Markdown files) | auto |
| `agent_spawn` | Spawn a sub-agent (own context / tool subset / depth ≤ 2) | auto |
| `past_runs` | Search past runs ("how did we do it last time?") | auto |

---

## Skill ecosystem

### Built-in skills

| Skill | Mode | Description |
|-------|:--:|------|
| `summarize-document` | llm_only | Intelligent document summarization |
| `data-transform` | llm_only | Data format conversion & structuring |
| `policy-scraper` | script | Policy scraping (streaming + MD/CSV dual artifacts) |
| `policy-to-post` | script | Policy → social post (mutually-exclusive inputs) |
| `information-filter` | script | Multi-source filtering (company-profile driven) |
| `web-reader` | script | Web article extraction (zero-dep readability) |
| `official-doc-writer` | llm_only | Official document text generation |
| `official-doc-expander` | hybrid | Expand bullet points into GB/T 9704-2012 official documents |
| `official-document-generator` | hybrid | Points → AI-assisted expansion → official .docx |

### Creating a custom skill

**Option 1: conversational UI** (recommended) — "Skill Builder" in the sidebar → describe the need → AI asks clarifying questions → generates a Node script (zero Python dependency) → hot-loaded on save.

**Option 2: hand-write SKILL.md** (for contributors):

```markdown
---
name: my-skill
version: "1.0.0"
description: "My custom skill"
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

You are a professional assistant. Complete the following task based on user input...
```

Save to `skills/my-skill/SKILL.md` and it loads automatically. Full spec: [docs/SKILLS-STANDARD.md](./docs/SKILLS-STANDARD.md).

---

## Core capabilities in depth

### Agentic Workspace (local file I/O)
- Multiple workspaces: bind and name several local folders, switch anytime, selection persisted
- Three permission modes: `readonly` / `ask` (default — diff approval on writes) / `auto`
- Three-layer path guard: out-of-boundary / sibling-prefix / symlink-escape attempts all blocked
- Upload-and-use: upload files straight into a workspace from Chat (1MB limit, chunked base64); attachments follow the message semantics (consumed on send, visible on the message)

### Long-term memory (file-based)
- `memory/` directory + Markdown; the agent records preferences, conventions, lessons
- Auto-distilled after sessions (optional); editable in the Settings UI
- Memory is text you can open and edit directly — transparent, trustworthy, dependency-free

### Dual execution semantics (v1 DAG orchestration retained)
- DAG scheduling: goal → planning engine → concurrent multi-skill execution with graceful short-circuit
- Retry semantics: skill-granularity retries; successful units never re-run
- Budget guardrails: step/token caps with graceful wrap-up (summary of done vs remaining), one-click continuation

---

## Key API endpoints

| Method | Path | Description |
|------|------|------|
| GET | `/api/health` · `/api/stats` · `/api/config` | Health / stats / config (keys masked) |
| POST | `/api/runs` | Start an agent run (goal + sessionId + workspaceId + budget) |
| GET | `/api/runs/:id` · `/events` · `/stream` | Detail / event delta / SSE live stream |
| GET | `/api/runs/:id/export.md` | Export run report (Markdown timeline) |
| POST | `/api/runs/:id/cancel` · `/approvals/:aid` | Cancel / approval decision |
| GET/POST/PATCH/DELETE | `/api/workspaces` | Workspace CRUD + file upload |
| GET/PUT/DELETE | `/api/skills/:name` | Skill query / edit / delete (built-ins need confirmation) |
| POST | `/api/skills/import` | Import Agent Skills (directory / git URL) |
| POST | `/api/skill-builder/sessions…` | Conversational skill building |
| GET/PUT/DELETE | `/api/memory…` | Memory management (Settings UI source) |
| POST | `/api/tasks` (v1 DAG mode) | Plan → DAG → skill orchestration |
| WS | `/ws/events` | WebSocket global event stream |

---

## Project structure

```
CORAL/
├── LICENSE · .env.example · README.md · README.en.md · USE.md
├── docs/                       ← public docs (skill standard / progress protocol / history)
├── .github/workflows/ci.yml    ← CI: 3 platforms × Node 20/22
├── scripts/                    ← dev / start / e2e smoke scripts
├── packages/
│   ├── server/                 ← Fastify backend
│   │   └── src/
│   │       ├── kernel/         ← Agent Loop / RunEngine / context mgmt (v2 heart)
│   │       ├── tools/          ← unified Tool abstraction + 16 built-ins + aliases
│   │       ├── providers/      ← LLM access (retry taxonomy / DSML normalization)
│   │       ├── skill-runtime/  ← SKILL.md registry / parsing / import / hot reload
│   │       ├── scheduler/      ← v1 DAG scheduler (cancel/timeout/retry semantics)
│   │       ├── planning/       ← v1 planning engine (goal → DAG)
│   │       ├── store/          ← SQLite + versioned migrations + repositories
│   │       ├── api/            ← REST routes
│   │       ├── event/          ← event bus (WS/SSE dual channel)
│   │       └── services/       ← LLM facade / config / memory / workspace / skill builder
│   ├── web/                    ← React frontend (Chat live session / DAG viz / memory UI)
│   └── progress/               ← @coral/progress protocol SDK (Node)
└── skills/                     ← skills directory (filesystem-as-registry, hot reload)
    └── _lib/                   ← progress helpers (Python + Node) + readability
```

---

## Progress (v2)

| Stage | Scope | Status |
|------|------|:---:|
| M0 | Foundation: SQLite / real cancel / real timeout / retry semantics / safe defaults / tests + CI | ✅ |
| M1 | Harness kernel: Agent Loop · sub-agents · Agentic Workspace · long-term memory · dual provider · skill import · Chat sessions · five innovations | ✅ |
| M2 | Graph mode: DSL + event-driven engine + goal→graph AI compiler + node approvals (patch-and-continue) + resume + Workflow page | ✅ |
| M3 | MCP bridge · scheduled & webhook triggers · progress-protocol SDK (npm/PyPI) | ⏳ |
| M4 | Time-Travel debugger (rollback/fork-replay) · `npx coral` distribution | ⏳ |

Quality baseline: Vitest 299 tests green · GitHub Actions three platforms (ubuntu/windows/macos × Node 20/22) · TypeScript strict

---

## Authors

**[Qiyao404](https://github.com/Qiyao404)** · **[alstar501](https://github.com/alstar501)** — joint development

## License

[MIT](./LICENSE) © 2026 Qiyao404 & alstar501
