# CORAL Feature Tour (DEMO.en.md)

[简体中文](./DEMO.md) | **English**

> Audience: you (verification) and interviewers/friends (demo). Ordered by "performance impact" — each act takes 1-3 minutes, all doable in a browser + one terminal.
> Prereq: service running (http://127.0.0.1:3001) with a real model in `.env` (demo mode halves the effect).
> Covers: v2.4.0. The sidebar has a one-click EN/中文 switch — the whole UI is bilingual.

---

## Act 1: One-sentence research (slash commands × named sub-agents × evidence records)

**Play**: on the Chat page, create a conversation, bind a workspace, and type:

```
/research the mainstream shapes of personal knowledge management tools in 2026
```

**Why it's impressive** (say these three things when demoing):
1. `/research` is not hardcoded — it's a template in `data/commands/research.md` (open it for the interviewer). Any input starting with `/` expands into a full task; the event stream keeps an `expandedFrom` trace
2. The agent will likely delegate the research subtask to **research-analyst** (one of four seeded specialists in `data/agents/`) — you'll see `agent_spawn` in the execution log; the sub-agent carries the discipline "no claim enters the conclusion without a citation"
3. Long web pages never blow up the context — the tool result says "saved as evidence record ev-xxx", and the agent pages details back via `evidence_read` itself. Notice the **human-readable summary** on the tool card ("GET … → 200 (86.3 KB)") — the model sees structured JSON, you see a summary: two channels, zero interference

**Easter egg**: after it finishes, `GET http://127.0.0.1:3001/api/runs/<runId>/evidence` lists all archived evidence — "summary-first; full results never run naked in the context".

## Act 2: Assemble a team that works in parallel (team_spawn × task board × step-boundary messages × watchdog)

**Play**: type on the Chat page (works even without a bound workspace):

```
Use a team to do three things in parallel: ① find the top-3 global EV sellers by 2024 sales
② find the top-3 global hybrid sellers by 2023 sales ③ cross-check whether any brand appears
on both lists. Track progress on the task board and summarize when all done.
```

**Why it's impressive**:
1. The agent `team_spawn`s **background named teammates** (returns immediately, never blocks) — `team.teammate_spawned` events fire one after another, each retrieving independently in its **own context, in parallel**
2. `team_tasks` builds a shared task board: `blockedBy` dependencies are enforced acyclic; the third cross-check task only becomes *ready* after the first two complete; `revision` optimistic locking prevents two agents clobbering each other
3. To feel **step-boundary messaging**, append: "send a message to the sales teammate: annual 2024 figures only, no quarterly breakdown" — the message lands **before its next LLM request** (never lost, never interrupts the running step)
4. `team_wait` harvests results, then the summary. The **watchdog** is on duty: every teammate's tokens accumulate into a team budget — 80% warns once, 100% rejects new spawns. Anti-runaway is structural

**One-liner**: this isn't "hiring an assistant" — it's an **auditable team** with a task board, messaging discipline, and a budget watchdog. Every `team.*` event is persisted and Time-Travel replayable.

## Act 3: Blind edits blocked (Fact Gate × approval center × effects contract)

**Play**: in the same workspace, have the agent write a `notes.md` first. Then start a new turn and type:

```
Change the headings in notes.md to uppercase. Edit directly — do NOT read it first.
```

**Why it's impressive**:
1. If the agent calls `fs_edit` directly, the **Fact Gate** rejects it on the spot — the tool result shows `FACTS_REQUIRED` plus an investigation instruction ("fs_read first to confirm the current state"). This is **deterministic code**, not model discipline
2. After it reads and retries, the change goes through the **approval center**: a unified diff card you must approve — and the approval tier isn't hand-set, it's derived from the tool's **effects declaration** (writes files / spawns processes)
3. With `scope:"session"`, the same tool in the same workspace auto-passes for the rest of the session (`tool.approval_auto` event on record)

**One-liner** (for interviewers): modifying a file you never read is structurally impossible here — not by prompting the model, by the runtime refusing.

## Act 4: The Wrap-up Gate bounces "rhetoric delivery"

**Play**: give the agent 3+ write tasks in a row, ending with "if you run out of time, just note the rest". Nudge it toward "that's legacy, will fix later".

**Why it's impressive**: when the final answer contains phrases like "fix later / skipped in tests / out of scope" (a bilingual pattern library), the **Wrap-up Gate** bounces it with a system-level follow-up: either actually finish, or honestly list "unfinished items". `loop.gate_rejected` events trace everything. Simple tasks pass without gating (zero friction).

## Act 5: Time travel + exact replay (four-layer checkpoint navigation)

**Play**: run a multi-step task on the Chat page → open Time-Travel → pick conversation → question → run variant → find the "summary done" checkpoint → fork with "turn it into a comparison table".

**Why it's impressive**:
1. The fork is a **new conversation** carrying the full memory up to that checkpoint (files read, conclusions made) — it executes the new direction without re-reading or recomputing
2. **Exact replay**: every step's checkpoint stores the **system prompt + model config** used at that moment (see systemPreview and model in `GET /api/runs/<id>/checkpoints`) — forking a three-month-old node three months later reproduces what the model saw **verbatim**; later profile/habit changes never leak into historical replay
3. A compression audit trail is on file: how many characters each shelve/compress reclaimed, reconciled per step — "when was information dropped" is answerable

**Easter egg (one terminal line)**: `curl http://127.0.0.1:3001/api/runs/<runId>/export.trajectory.jsonl | head -1` — a training-ready trajectory (metadata with model + system prompt, then per-message lines), directly usable for tool-calling model trajectory production.

## Act 6: Experience recall (session_search — "that thing we discussed…")

**Play**: after a few acts, start a new turn and type:

```
Use session_search to find: what topic did we research in the earlier demo? What was the
conclusion of the task we forked into a table?
```

**Why it's impressive**: `session_search` runs full-text search over **all historical runs** (FTS5, CN/EN substring matching) and returns highlighted snippets + run locators — "how did we fix that error last time" now hits the **original trail** instead of distilled memories (memory only covers what was summarized; this covers everything). And this act itself becomes searchable corpus for next time — experience turns into a recallable asset.

## Act 7: Learns you over time (3-layer memory × habit learning × memory nudges)

**Play**:
1. Fill your profile in Settings (name / role / preference — "always use tables")
2. Deliberately correct it two or three times ("Markdown, not Word")
3. Come back over the following days and watch it stop repeating the mistake

**Why it's impressive**: corrections are auto-distilled into **long-term memory** (`data/memory/*.md`, plain editable Markdown); reasoned decisions and "handoff records" settle into **session context** (continuing a session opens with "where we left off"); repeated tool-usage patterns are captured by **habit learning** (`GET /api/habits`; confidence ≥0.7 auto-injects into the prompt, ≥0.8 across 2+ sessions can be promoted into a skill). During long tasks, **memory nudges** fire: every 12 steps (max 2) the agent is reminded to persist freshly learned, reusable knowledge with `memory_write` right away — not at session end, not by self-discipline.

**Four-layer memory governance (platform self-governance)**:
- **Admission gate**: environment snapshots (rebuildable via fs_list) and conversation recaps (covered by session_search) → rejected
- **Auto-filing**: accepted content routes to the closest matching existing file (original preserved + dated section)
- **Auto-consolidation**: >15 files triggers full-preserve merge down to 5-12 topic files (verified: 68 → 9, zero fact loss)
- **Automation isolation**: automated runs have memory_write denied — evaluation never pollutes personal memory
- **Version safety net**: skill "History" button → all-version diff + one-click rollback (auto-backup before rollback)

## Act 8: The self-evolution loop (post-run distillation → evolution proposals → human-approved landing)

**Play**:
1. Run a **complex task** (e.g. the Act-2 team research, or anything ≥12 steps)
2. When it finishes, open the **Skills page** (or the profile card in Settings) — an "Evolution Proposals" card may have appeared on top
3. Click "view full draft", read the LLM-drafted skill revision / new-skill draft / profile additions, then **Accept** or **Reject**

**Why it's impressive**:
1. After a run, the distillation pipeline analyzes automatically: skills used × failure signals ≥2 → drafts a **skill revision**; complex task → drafts a **new skill** (deduplicated against the existing 40); 24h elapsed → extracts **profile additions**
2. **Proposals never take effect by themselves** — accepting applies: the old skill version is backed up to `.history/` and hot-reloaded; profile additions merge in. Rejecting archives. At most one distillation call per run (cost-bounded)
3. This is the full loop: **skills improve through use + complex experience crystallizes into new skills + the profile keeps evolving — with a human gate on every step**. The agent proposes; you decide

**Shortcut**: to induce a skill revision — make some skill fail twice (e.g. give web-search an unreachable proxy), then check the Skills page after the next run.

## Act 9: External guards (hooks — the discipline layer as an open interface × visual management)

**Play**: the repo ships with one guard (denies writes to `.env`/secret-ish paths). Open the **"Hooks"** page in the sidebar: see the grouped cards of 8 lifecycle events → find the `protect-secrets` entry under pre_tool_use → click **Test** (real execution with a sample payload; returns the verdict + raw output) → watch the **recent firing stream**.

Then ask the agent to write an `.env` file — denied, with the reason shown right in the tool result.

**Why it's impressive**: any external script (lint, company policy, sensitive-data scanning) can plug into the 8 lifecycle points — vetoing calls, rewriting tool inputs, escalating to human approval, bouncing final answers. The contract is tiny: JSON on stdin, decision JSON on stdout, exit code 2 = deny; a pre_tool_use guard that itself fails counts as denial (fail-closed). The management page does add/edit/delete, regex matching, per-entry enable/disable, and real test firing — no more hand-edited JSON.

## Act 10: Scheduled tasks that continue the same conversation (triggers × persistent inbox)

**Play**: create a trigger on the Connectors page:
- kind `cron`, spec `0 9 * * 1-5` (weekdays 9am)
- goal: `Use price-watch to check the current price of <some product URL> and append to the price log`
- **Continue session ID**: paste an existing `sess_…` (visible in the Chat sidebar)

**Why it's impressive**: the trigger no longer opens a new conversation each time — it **delivers the task into the existing session**, continuing from its latest checkpoint. Daily price checks land on the same conversation line, forming a running price log (with `price-watch`'s record format); likewise `weekly-review-planning` every Monday on the same weekly-review line. That's the "persistent inbox" semantics: recurring tasks gain **continuous memory**. Webhook triggers work the same way (`POST /api/hooks/<id>` injects body variables into the goal template).

## Act 11: Double-blind review + five-axis self-eval (delivery quality)

**Play**:
1. Have the agent produce an analysis document, then say "run dual_review on what you just wrote"
2. After any run: `POST http://127.0.0.1:3001/api/runs/<runId>/self-eval`

**Why it's impressive**: the review is **two independent reviewers that cannot see each other's conclusions** plus an arbiter on disagreement (consensus or honest escalate); the self-eval scores five axes (accuracy / completeness / clarity / actionability / concision) and **low scores must cite textual evidence** or the axis is voided — "giving myself a 5" doesn't fly here.

## Act 12: Skill factory × skill-package installation

**Play**:
1. On the Skill Builder page: "make me a skill that turns a CSV into a comparison-table Markdown", finish the conversation and submit
2. Or in Chat: "following skill_authoring's standard, solidify a weekly-report skill for me"
3. Install skills made by others: `coral install npm:<skill-pack>` (or a git URL / local directory; `--ignore-scripts` isolated install — package scripts never execute)

**Why it's impressive**: submission passes a **deterministic quality gate** (placeholder names, empty descriptions, near-duplicates get blocked with reasons). The library now holds **40 skills** — newly including blocked-page recovery (the 403/paywall fallback ladder), grounded citations, four-phase root-cause debugging, weekly review & planning, document-to-action-items, and price watch — all rewritten against the platform's own tools.

## Act 13: Embed the SDK in three lines (library shape)

**Play** (inside another Node project):

```ts
import { runAgent } from '@coral/sdk';
const result = await runAgent({ goal: 'Summarize the changes under ./docs', chat: myOpenAiCompatCall });
```

**Why it's impressive**: no server, no REST — the kernel ReAct loop is `import`ed straight into your program with **Fact Gate / Wrap-up Gate / compression / evidence all active**, writing no database; upgrade to `createRuntime()` when you need continuity (three-table persistence + skill registry; SDK-initiated runs are reviewable in the Web UI). Model access is your own chat function — gateway, local model, or test stub; no provider lock-in.

## Act 14: Ops quartet + bilingual UI (30 seconds in the terminal)

```powershell
node packages/server/bin/coral.mjs doctor    # 8-channel self-check: build freshness/port/disk/db/skills/MCP/ESTOP
node packages/server/bin/coral.mjs pause out # trip the break: all new tasks (incl. scheduled) rejected; running ones untouched
node packages/server/bin/coral.mjs resume    # release
curl http://127.0.0.1:3001/api/system/gc     # config self-cleanup scan (soft-delete + revocable log)
```

**Easter egg**: the globe icon in the sidebar toggles **EN/中文** for the entire UI (14 namespaces, preference persisted) — switch it live when your interviewer prefers English.

## Act 15 (closing line)

> "Other agent demos show 'what the model can do'. CORAL shows 'how the runtime makes sure the model does it right — and gets better with use' — blind edits refused, rhetoric bounced, oversized results archived, teams under a budget watchdog. None of it depends on model discipline; all of it is deterministic code, event-logged, and time-replayable. And every task it runs feeds three flywheels: skills revised through use, complex experience crystallizing into new skills, and the entire conversation history becoming full-text searchable — the agent proposes, the human decides."

---

## Appendix: tech highlights cheat sheet (one page for interviews)

| Dimension | Mechanisms |
|---|---|
| Tool contract | Effect bits (writes fs / process / network / idempotent) → approval-tier derivation, fail-closed sealing; MCP annotation mapping |
| Context | clip → shelve → summarize, three tiers + 4-level usage warning + failure cooldown ladder (60/300/900s) + deterministic fallback summary |
| Result management | Oversized results → immutable evidence records (summary-first + paged retrieval); `data`/`display` dual channel (model sees JSON, UI sees human summary) |
| Deterministic discipline | Fact Gate (read-before-write), Wrap-up Gate (rhetoric audit), external command guards (8-event hooks + visual management page) |
| Multi-agent | team_spawn background teammates (shared safety invariants), step-boundary messages (never lost, never interrupting), acyclic task board (CAS), team-token watchdog |
| Self-evolution | Post-run distillation pipeline (skill revision / new-skill draft / profile additions, ≤1 distillation per run) → human-approved landing (.history backup + hot reload); in-task memory nudges |
| Learning | Long-term memory trust tiers, habit learning (confidence → skill promotion), full-text session search session_search (experience recall) |
| Replayability | Every checkpoint carries system prompt + model config (exact replay); trajectory JSONL export (training-data format) |
| Quality | Double-blind review, five-axis self-eval (low scores must cite evidence), skill quality gate, config self-cleanup |
| Ops | coral doctor 8 channels, ESTOP sentinel, approval session memory, triggers continuing existing sessions (persistent inbox) |
| Extensibility | Skill / named-sub-agent / slash-command user directories + hooks open interface + `coral install` packages (npm/git/local) + `@coral/sdk` library embedding — all hot-reloading; bilingual UI |
