# CORAL — A Local-First Personal Agent Runtime

[简体中文](./README.md) | **English**

[![CI](https://github.com/Qiyao404/CORAL/actions/workflows/ci.yml/badge.svg)](https://github.com/Qiyao404/CORAL/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **Positioning: a local-first, single-command, single-file-storage personal agent runtime**
> Autonomous Agent Loop · Local workspace file access · File-based long-term memory · Skill ecosystem

---

## What can it do?

Open the Chat page, describe your goal in one sentence, and the agent **works autonomously**:

- **Autonomous loop**: the model decides which tool to call next; every step is visible in real time, stoppable at any moment
- **Read & write your local files**: bind a workspace folder and the agent can list, read and edit files — every modification pops a **diff approval card** before touching disk (three permission modes: readonly / ask / auto)
- **Run commands**: optional shell tool (every execution requires approval) — real scripts, real installs
- **Web access**: give it any URL and it fetches and reads the content itself
- **Long-term memory**: remembers your preferences and project context across sessions — as plain Markdown files you can open and edit
- **Sub-agents**: long noisy tasks are isolated into fresh-context sub-agents automatically
- **Skill ecosystem**: create skills via conversation, import Anthropic Agent Skills directly, filesystem-as-registry with hot reload

> Local-first throughout: single-file SQLite storage, listens on 127.0.0.1 by default, API keys never leave your machine. No API key? `--demo` mode runs the full pipeline offline (results flagged with `mock: true`, never faked as real).

---

## Quick Start

```bash
# 1. Install dependencies (Node.js ≥ 20)
npm install

# 2. Configure environment (any OpenAI-compatible endpoint works)
cp .env.example .env

# 3. Start (backend :3001 + frontend :5173)
npm run dev
```

| Service | URL |
|---------|-----|
| Web UI (Chat / Skills / Tasks / Settings) | http://localhost:5173 |
| Backend API | http://localhost:3001/api/health |

---

## Architecture (v2)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Web UI                                                               │
│  Chat (live agent session: todo checklist / tool cards / diff        │
│  approvals / final answer)   Skills   Tasks (v1 DAG)   Settings       │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ REST + WS + SSE
┌──────────────────────────────▼───────────────────────────────────────┐
│  RunEngine (Free-mode entry: budget guard / cancel / event sourcing)  │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  Agent Loop (ReAct main loop)                                   │ │
│  │  compress → LLM → tool execution (approval gate) → budget → cp  │ │
│  │  ├─ sub-agents (agent_spawn: fresh context / tool subset / ≤2)  │ │
│  │  └─ context management (result clipping + history compression)  │ │
│  └───────────────────────────┬─────────────────────────────────────┘ │
│                              │ unified Tool interface                │
│  ┌───────────────────────────▼─────────────────────────────────────┐ │
│  │  Tool Registry: built-ins (fs read/write/search, http_fetch,    │ │
│  │  shell, memory, todo, past_runs) │ Skills │ MCP (planned)       │ │
│  └───────────────────────────┬─────────────────────────────────────┘ │
│  providers: OpenAI-compatible (DashScope/DeepSeek/OpenRouter/Ollama…) │
│             + Anthropic native (prompt caching on by default)         │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
   SQLite (WAL, single file): runs / events / checkpoints / llm_profiles…
   Event sourcing: per-step checkpoints + full event log, WS/SSE live
```

---

## Core capabilities

### Agentic Workspace (local file access)
- Multiple named workspaces, switchable at any time
- Three permission modes: `readonly` / `ask` (default — writes pop a diff approval card) / `auto` (direct execution)
- Three-layer path guard: escapes, sibling-prefix traversal and symlink escapes are all blocked
- Agent tools: list, read, write, exact-snippet edit (unified diff output), keyword search, run commands

### Long-term memory (file-based)
- `memory/` directory + Markdown: `memory_list / read / write / search`
- The agent records durable facts autonomously; sessions end with automatic distillation
- Memory is plain text you can open and edit — transparent, trustworthy, zero dependencies

### Dual execution semantics
- Real cancellation: AbortSignal end-to-end (LLM calls / process-tree kills)
- Real timeouts: planning / agent / script three-layer deadlines
- Retry taxonomy: transient errors retried with exponential backoff + jitter, permanent errors fail fast, retry at skill granularity
- Budget guard: step & token caps with graceful wrap-up

### Skills
- `SKILL.md` is the skill: YAML frontmatter + Markdown body + scripts, hot-reloaded on save
- Conversational creation (Skill Builder) generating Node scripts by default (zero Python dependency)
- One-command import of Anthropic Agent Skills: local dir / parent dir batch / GitHub URL, with a compatibility report
- Progress protocol: scripts report progress/logs/artifacts live via single-line JSON on stderr (Python & Node SDKs)

---

## Key API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/runs` | Start an agent run (goal + sessionId + workspaceId + budget) |
| GET | `/api/runs/:id` · `/events` · `/stream` | Detail / incremental events / SSE live |
| POST | `/api/runs/:id/cancel` · `/api/runs/:id/approvals/:aid` | Cancel / approval decision |
| GET/POST/PATCH/DELETE | `/api/workspaces` | Workspace CRUD + activate |
| POST | `/api/skills/import` | Import Agent Skills (dir / git URL) |
| POST | `/api/skill-builder/sessions…` | Conversational skill creation |
| POST | `/api/tasks` (v1 DAG mode) | plan → DAG → skill orchestration |
| GET/PUT/DELETE | `/api/skills/:name` | Skill CRUD |

---

## Project structure

```
CORAL/
├── packages/
│   ├── server/src/
│   │   ├── kernel/        ← Agent Loop / RunEngine / context management
│   │   ├── tools/         ← unified Tool abstraction + built-ins (fs/http/shell/memory…)
│   │   ├── providers/     ← dual-vendor LLM access + retry taxonomy
│   │   ├── skill-runtime/ ← SKILL.md registry / parser / importer / hot reload
│   │   ├── store/         ← SQLite + versioned migrations + repositories
│   │   ├── api/           ← REST routes
│   │   └── services/      ← LLM facade / memory / workspaces / skill builder
│   ├── web/               ← React frontend (live Chat session / DAG visualization / settings)
│   └── progress/          ← @coral/progress protocol SDK (Node)
├── skills/                ← skill directory (with _lib progress helpers: Python + Node)
└── docs/                  ← docs (protocol spec / skill authoring standard)
```

---

## Development progress

| Phase | Scope | Status |
|-------|-------|:------:|
| M0 | Foundation: SQLite / real cancellation / real timeouts / retry semantics / secure defaults / tests+CI | ✅ |
| M1 | Harness kernel: Agent Loop · sub-agents · Agentic Workspace · long-term memory · dual provider · skill import · Chat session | ✅ |
| M2 | Graph mode: deterministic DAG + checkpoints / approval center / crash recovery | 🚧 In progress |
| M3 | MCP bidirectional bridge · scheduled & webhook triggers · progress SDK publishing (npm/PyPI) | ⏳ |
| M4 | Time-Travel debugger (rewind / fork & replay) · `npx coral` distribution | ⏳ |

Quality baseline: Vitest 241 tests · GitHub Actions on 3 platforms (ubuntu/windows/macos × Node 20/22) · TypeScript strict

---

## Authors

**[Qiyao404](https://github.com/Qiyao404)** · **[alstar501](https://github.com/alstar501)** — co-developers

## License

[MIT](./LICENSE) © 2026 Qiyao404 & alstar501
