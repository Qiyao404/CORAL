# CORAL — A Local-First Personal Agent Runtime

[简体中文](./README.md) | **English**

[![CI](https://github.com/Qiyao404/CORAL/actions/workflows/ci.yml/badge.svg)](https://github.com/Qiyao404/CORAL/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **Version: v2.0.0-M0 (actively developed)**
> **Positioning: a local-first, single-command, single-file-storage personal agent runtime**

---

## What is CORAL?

CORAL is a multi-agent collaboration platform that is **LLM-native, filesystem-driven (skills as files), and auto-orchestrates composite tasks**:

- Describe a goal in natural language (voice supported) — it plans a DAG of cooperating skills and executes them concurrently
- Fully observable in real time: progress, logs, and artifacts stream live; tasks can be cancelled instantly
- Business users can **create / edit / delete skills in the UI** through conversation — no code required
- Local-first: single-file SQLite storage, listens on 127.0.0.1 by default, API keys never leave your machine

> v2 direction (in progress): Agent Loop (autonomous loop + sub-agents), Graph mode (checkpoints / human approval / crash recovery), Agentic Workspace (local file read/write), bidirectional MCP bridge, Time-Travel debugger. See [docs/V2_PLAN.md](./docs/V2_PLAN.md).

---

## Quick Start

```bash
# 1. Install dependencies (Node.js ≥ 20)
npm install

# 2. Configure environment (any OpenAI-compatible endpoint works)
cp .env.example .env

# 3. Start in dev mode (backend :3001 + frontend :5173)
npm run dev
```

```bash
# No API key? Run the explicit demo mode — the full pipeline works offline
# (all simulated results are flagged with `mock: true`, never faked as real)
npm run dev:server -- --demo
```

| Service | URL |
|---------|-----|
| Web UI | http://localhost:5173 |
| Backend API | http://localhost:3001/api/health |

Full usage guide → [USE.md](./USE.md) (Chinese)

---

## Architecture

```
┌──────────────────────── Access Layer (Web Dashboard + REST + WS/SSE) ────────────────────────┐
│  Dashboard │ Chat (voice) │ SkillBuilder │ Skills CRUD │ Tasks realtime (DAG visualization)  │
└──────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼───────────────────────────────────────────────────────┐
│  EventBus (pub/sub + WS/SSE dual channel, all events persisted & replayable)                  │
└──────────┬──────────────────────┬──────────────────────────┬─────────────────────────────────┘
           ▼                      ▼                          ▼
   Planning Engine         DAG Scheduler                 Skill Builder
   (goal → DAG)            (concurrency / graceful       (chat → generates
                            short-circuit)                SKILL.md, hot reload)
           │                      │                          │
           └──────────┬───────────┴──────────────────────────┘
                      ▼
   SkillExecutor (llm_only / script / hybrid)
   · Real cancellation & timeouts: AbortSignal end-to-end, script process trees force-killed
   · Retry semantics: error classification (transient / permanent / abort) + exponential
     backoff with jitter, retry at the skill level
   · [CORAL_PROGRESS] stderr protocol: live progress / logs / artifacts from any script
                      │
                      ▼
   SQLite (WAL, single file): runs / events / checkpoints / llm_profiles / mcp_servers / kv
```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19 + Vite 6 + Tailwind 3 + React-Flow + Lucide + Web Speech API |
| Backend | Node.js ≥ 20 + Fastify 5 + TypeScript 5 (strict) |
| LLM | openai SDK (any compatible endpoint: DashScope / DeepSeek / OpenRouter / Ollama…), transport-level auto-retry |
| Persistence | SQLite (better-sqlite3, WAL mode, versioned schema migrations) |
| Skills | YAML frontmatter (gray-matter) + chokidar hot reload |
| Progress protocol | Home-grown `[CORAL_PROGRESS]` single-line-JSON-over-stderr protocol |
| Quality | Vitest (191 tests) + GitHub Actions (ubuntu/windows/macos × Node 20/22) |

---

## Built-in Skills

| Skill | Mode | Description |
|-------|:----:|-------------|
| `summarize-document` | llm_only | Document summarization |
| `data-transform` | llm_only | Data transformation |
| `policy-scraper` | script | Government policy scraping (streaming, MD/CSV artifacts) |
| `policy-to-post` | script | Policy → social media post |
| `information-filter` | script | Multi-source information filtering (profile-driven) |

---

## Creating Your Own Skill

**Option 1: UI conversation (recommended)** — open "Skill Builder" in the sidebar → describe what you need → the AI asks clarifying questions → commit; the skill is hot-loaded and ready in ~2 seconds.

**Option 2: hand-write SKILL.md (for developers)**:

```markdown
---
name: my-skill
version: "1.0.0"
description: "What this skill does and when to use it"
domain: custom
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
source: user
---

# My Skill

You are an expert assistant...
```

Drop it into `skills/my-skill/SKILL.md` and it hot-loads automatically. Full spec: [docs/SKILLS-STANDARD.md](./docs/SKILLS-STANDARD.md) (Chinese).

---

## Key API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` · `/api/stats` · `/api/config` | Health / stats / config (keys masked) |
| POST | `/api/tasks` | Create a task (natural-language goal) |
| POST | `/api/tasks/:id/cancel` | Cancel a task (aborts LLM calls, kills script processes) |
| GET | `/api/tasks/:id/stream` | SSE task event stream |
| WS | `/ws/events` | WebSocket global event stream |
| GET/PUT/DELETE | `/api/skills/:name` | Skill CRUD (built-ins require confirmation) |
| POST | `/api/skill-builder/sessions…` | Conversational skill creation |
| GET/PUT | `/api/company-profile` | Company business profile |

---

## Project Structure

```
CORAL/
├── LICENSE · .env.example · README.md · USE.md
├── docs/                    ← V2_PLAN (roadmap) / architecture & PRD history / skill spec
├── .github/workflows/ci.yml ← CI: 3 platforms × Node 20/22
├── scripts/                 ← dev / start / e2e smoke scripts
├── packages/
│   ├── server/              ← Fastify backend
│   │   └── src/
│   │       ├── api/         ← HTTP routes
│   │       ├── scheduler/   ← DAG scheduler (cancel / timeout / retry semantics)
│   │       ├── planning/    ← Planning engine (goal → DAG)
│   │       ├── skill-runtime/ ← registry / parser / hot reload / executor / progress protocol / sandbox env
│   │       ├── providers/   ← error classification + retry (first brick of the M1 providers layer)
│   │       ├── store/       ← SQLite + migrations + repositories
│   │       ├── event/       ← event bus
│   │       └── services/    ← LLM client / config / company profile / skill builder
│   └── web/                 ← React frontend (DAG visualization / realtime streams / theming)
└── skills/                  ← skill directory (filesystem is the registry, hot reload)
    └── _lib/coral_progress.py ← progress protocol Python helper
```

---

## Roadmap (v2)

| Milestone | Scope | Status |
|-----------|-------|--------|
| M0 | Foundation: SQLite / real cancellation / real timeouts / retry semantics / de-mock / secure defaults / tests + CI / repo hygiene | ✅ Done |
| M1 | Harness kernel: providers layer · Tool abstraction · Agent Loop + sub-agents · Agentic Workspace | ⏳ |
| M2 | Graph mode: checkpoints / human approval / crash recovery / event-driven scheduler rewrite | ⏳ |
| M3 | Connectors: bidirectional MCP bridge · progress protocol SDKs (npm + PyPI) | ⏳ |
| M4 | Flagship UX: Time-Travel debugger · `npx coral` single-command distribution | ⏳ |

The roadmap advances milestone by milestone; statuses update with each release.

---

## Authors

**[Qiyao404](https://github.com/Qiyao404)** · **[alstar501](https://github.com/alstar501)** — co-developers

## License

[MIT](./LICENSE) © 2026 Qiyao404 & alstar501
