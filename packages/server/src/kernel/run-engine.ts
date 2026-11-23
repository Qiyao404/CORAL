import { AgentLoop, type LoopEvent, type LoopCheckpoint } from './agent-loop.js';
import type { ChatRequest, ChatResponse } from '../providers/types.js';
import { RunStore, newRunId, type Run } from '../store/run-store.js';
import { RunEventStore } from '../store/run-event-store.js';
import { CheckpointStore } from '../store/checkpoint-store.js';
import { eventBus } from '../event/event-bus.js';
import { createAbortController, abortTask, releaseAbortController } from '../services/task-abort-registry.js';
import { platformConfig, PLATFORM_DEFAULT_BUDGET } from '../services/config.js';
import { createDefaultToolRegistry } from '../tools/registry.js';
import { makeTodoTool } from '../tools/builtin/todo.js';
import { makePastRunsTool } from '../tools/builtin/past-runs.js';
import { makeSpawnTool, makeTeamSpawnTool } from '../tools/builtin/spawn.js';
import { makeTeamSendTool, makeTeamTasksTool, makeTeamWaitTool } from '../tools/builtin/team.js';
import { TeamService } from './team-service.js';
import { SearchStore } from '../store/search-store.js';
import { makeSessionSearchTool } from '../tools/builtin/search.js';
import { makeMemoryTools, MEMORY_GUIDE } from '../tools/builtin/memory.js';
import { makeAskUserTool, type AskUserAnswer, type AskUserPayload } from '../tools/builtin/ask-user.js';
import { generateCriteria, verifyDeliverable, appendCheck, type CriteriaResult, type VerifyVerdict } from '../services/verification-service.js';
import { makeEvidenceReadTool } from '../tools/builtin/evidence.js';
import { makeDualReviewTool } from '../tools/builtin/dual-review.js';
import { EvidenceStore } from './evidence.js';
import { MemoryService, distillMemory } from '../services/memory-service.js';
import { MemoryUsageService } from '../services/memory-usage-service.js';
import { MemoryEntityService } from '../services/memory-entity-service.js';
import { HabitService } from '../services/habit-service.js';
import { EvolutionService } from '../services/evolution-service.js';
import { AgentPresetService } from '../services/agent-presets.js';
import { SlashCommandService } from '../services/slash-commands.js';
import { isEstopped, estopReason } from '../services/estop.js';
import { HookService, type HookEvent } from '../hooks/hook-service.js';
import { RunBudgetSettingsService } from '../services/run-budget-settings.js';
import { evaluateDeterministic } from './self-eval.js';
import { PersonalizationService } from '../services/personalization-service.js';
import { WorkspaceService, type Workspace } from '../services/workspace-service.js';
import { fsSearchTool } from '../tools/builtin/fs-search.js';
import { docxTools } from '../tools/builtin/docx.js';
import { unifiedDiff } from '../tools/diff.js';
import { resolveWorkspacePath } from '../tools/workspace-path.js';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join as pathJoin } from 'path';
import { dirname as pathDirname } from 'path';
import { nanoid } from 'nanoid';
import type { Tool, ToolPermission } from '../tools/types.js';
import type { FilesystemSkillRegistry } from '../skill-runtime/filesystem-registry.js';
import type { SkillExecutor } from '../skill-runtime/skill-executor.js';
import { taskStore } from '../store/index.js';

/**
 * M1-5：RunEngine — Free 模式入口，AgentLoop（M1-3 纯内核）与真实世界的接线：
 *  · runs / events / checkpoints 三表持久化（事件溯源）
 *  · 事件双写：events 表（回放）+ eventBus（WS/SSE 实时；taskId=runId 路由）
 *  · 预算强制（请求级覆盖 → 平台默认），取消经 abort registry 全链路贯穿
 *  · 工具集：内置 + 全部技能 + todo_write（D19）+ past_runs（D19）
 */

export interface RunBudgetInput {
  maxSteps?: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface StartRunInput {
  goal: string;
  /** D17 多会话挂靠 */
  sessionId?: string;
  /** M4-1 Time-Travel：fork 的历史种子（从某 checkpoint 回放） */
  initialHistory?: import('../providers/types.js').ChatMessage[];
  /** M4-1：fork 来源 run（runs.parent_run_id 列，001 迁移预留） */
  parentRunId?: string;
  forkFromSeq?: number;
  budget?: RunBudgetInput;
  /** M1-10：绑定工作区（目录 + 权限档）— 不传则无 fs/shell 工具 */
  workspaceId?: string;
  /** 多轮对话：从本会话最近 run 的末次 checkpoint 续接历史（含上一轮工具结果与最终回答） */
  continueSession?: boolean;
  extraSystem?: string;
  /**
   * 精确重放（Time-Travel fork）：来自源 checkpoint 的历史系统提示。
   * 提供时新 run 完全复现当时的上下文组装（画像/习惯/个性化的后续变化不影响 fork）。
   */
  forkSystem?: string;
  /**
   * 模型路由：指定本 run 使用的 LLM 配置档案 ID（llm_profiles 表）。
   * 未指定 = 使用当前 active 配置。适用于"图像题切视觉模型 / 简单题切便宜模型"场景。
   */
  modelProfileId?: string;
  /**
   * 无人值守（定时/触发任务形态）：现场没有人可以回答问题或点审批。
   * ask_user 不挂起直接返回"用户不可用"；开工歧义不再要求"立即澄清"。
   *（REG-26：此前只有"评测会话"一种识别方式，普通会话标识的定时任务一开工就永远等在反问上）
   */
  unattended?: boolean;
}

export interface RunEngineDeps {
  /** M3-2：外部 MCP server 的工具（懒取 — 连接状态随管理页启停变化） */
  mcpTools?: () => Tool[];
  llm: {
    chat(req: ChatRequest): Promise<ChatResponse>;
    /** 创新①：流式 chat — 存在时 loop 走逐 token 直播 */
    chatStream?(req: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResponse>;
    complete(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, options?: any): Promise<{ content: string }>;
  };
  skillRegistry: FilesystemSkillRegistry;
  skillExecutor: SkillExecutor;
  runStore: RunStore;
  eventStore: RunEventStore;
  checkpointStore: CheckpointStore;
}

const GOAL_LIMIT = 10_000;
const MAX_STEPS_CAP = 100_000;
// 无上限语义：数值 ≤0 视为无上限（存储仍存原值，进入循环前翻译为 Infinity）
const MAX_TOKENS_CAP = 1_000_000_000;

/** 数值预算 → 循环预算：≤0 视为无上限 */
function loopBudgetValue(v: number | undefined, fallback: number): number {
  // NaN 防护：NaN <= 0 为 false → NaN 穿透 → 循环中一切比较失效（预算/守卫全关）
  const n = typeof v === 'number' && Number.isFinite(v) ? v
    : typeof fallback === 'number' && Number.isFinite(fallback) ? fallback
    : 10_000_000;
  return n <= 0 ? Infinity : n;
}

/**
 * 派生预算的名义值（REG-34）：子代理预算按"生效预算 ÷ 3 / ÷ 2"派生 — 预算为 0（无上限）时
 * 不能直接拿来除（只会得到一个几步就用完的废上限），改用平台默认量级。
 */
function nominalBudgetValue(v: number | undefined, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return n > 0 ? n : fallback;
}

export class RunEngine {
  private deps: RunEngineDeps;
  /** 证据记录层：超预算工具结果的不可变存档（data/evidence/{runId}/） */
  private evidence = new EvidenceStore(pathDirname(platformConfig.databasePath));
  /** 会话全文检索（FTS5）：run 终态索引，session_search 工具的数据源 */
  private search = new SearchStore();
  /** 习惯学习管线：观察 → 蒸馏 → 置信度 → 晋升技能（data/habits/） */
  private habits = new HabitService(pathDirname(platformConfig.databasePath));
  /** 运行后蒸馏管线（技能修订/新技能/画像提议 — 至多一次 LLM 调用每 run，fire-and-forget） */
  private evolution = new EvolutionService(
    { llm: null as any, skillsDir: platformConfig.skillsDir, registry: null as any, memoryDir: platformConfig.memoryDir },
    pathDirname(platformConfig.databasePath),
  );
  /** 具名子代理预设（data/agents/*.md — description 注入主提示，正文按名加载） */
  private agentPresets = new AgentPresetService(pathDirname(platformConfig.databasePath));
  /** 斜杠命令（data/commands/*.md — 用户快捷指令，goal 以 "/" 开头时展开） */
  private slashCommands = new SlashCommandService(pathDirname(platformConfig.databasePath));
  /** 外部命令守卫（data/hooks.json — 8 生命周期事件，可拒/可改/可补） */
  private hookSvc = new HookService(pathDirname(platformConfig.databasePath));
  /** 运行预算用户设置（data/run-budget.json — 设置页可改，优先于平台默认） */
  private budgetSettings = new RunBudgetSettingsService(pathDirname(platformConfig.databasePath));
  /** 个性化服务（6 维度"越用越懂你"，全部默认关，设置页开关控制） */
  private personalization = new PersonalizationService(pathDirname(platformConfig.databasePath));
  /** 记忆使用追踪：read/search 命中记账；失败 run 的读取做误导弱归因（只记录不处置） */
  private memoryUsage = new MemoryUsageService(platformConfig.memoryDir);
  /** runId → 本 run 内读过/检索命中的记忆文件（终态时统一记账） */
  private memoryReadsByRun = new Map<string, Set<string>>();

  /** hooks 的 loop 注入形态（结构化包装 — kernel 不 import 具体服务） */
  private loopHooks = {
    run: (event: string, payload: Record<string, any>) => this.hookSvc.run(event as HookEvent, payload),
  };
  /** runId → 会话/目标（习惯观察的上下文标注） */
  private runMeta = new Map<string, { sessionId: string; goal: string }>();
  /** 运行中用户补充的注入邮箱（runId → 有序消息；步边界与团队邮箱合流排空） */
  private userInboxByRun = new Map<string, Array<{ queuedAt: number; content: string }>>();
  /** 平台自身的步边界提示（runId → 有序提示）— 与用户补充分开存放：它不是用户说的话，
   * 不能借用 [user follow-up] 的外壳，也不该发"用户补充已送达"事件（UI 会误显示） */
  private systemInboxByRun = new Map<string, string[]>();
  /** 反问生命周期（与审批同构）：questionId → 挂起的 ask_user 调用 */
  private pendingQuestions = new Map<string, { runId: string; payload: AskUserPayload; resolve: (a: AskUserAnswer) => void; timer?: ReturnType<typeof setTimeout> }>();
  /** 每 run 已问数（上限 3 — 防模型把反问当逃逸口） */
  private questionsAskedByRun = new Map<string, number>();
  /** 验证工程：每 run 的验收清单（memoized promise — 开工即预热，验证门复用） */
  private criteriaByRun = new Map<string, Promise<CriteriaResult | null>>();
  /** 验证工程：每 run 的最后一次判决（终态 run.verified 事件用） */
  private verdictByRun = new Map<string, VerifyVerdict & { rounds: number }>();
  /** callId → 工具输入预览（观察在 call_completed 时落笔，需要 started 的输入） */
  private pendingObs = new Map<string, { tool: string; inputPreview: string; agentId: string; runId: string }>();
  /** 本进程内有执行管线的 run（startRun 登记、finally 注销）— "立即补充"只收进真正在跑的 run */
  private liveRunIds = new Set<string>();
  /** 无人值守的 run（定时/触发任务形态）— 现场没有人点审批：审批按"未获批准"即时落定，不挂起 */
  private unattendedRuns = new Set<string>();
  /** run 级后台作用域：后台 teammate 的取消控制器。主循环结束即整体终止（REG-25 — 没收割的 teammate 不再成为僵尸） */
  private backgroundScopes = new Map<string, Set<AbortController>>();
  /** 等待后台 teammate 落定的回调（主循环返回后等它们收尾，再把消耗计入总账） */
  private backgroundWaiters = new Map<string, Array<() => void>>();
  /** 后台 teammate 的 token 消耗（runId → 累计）— 计入 run 总账（此前只算主循环） */
  private teamTokensByRun = new Map<string, { in: number; out: number }>();

  constructor(deps: RunEngineDeps) {
    this.deps = deps;
    // 演化管线依赖注入（字段初始化时 deps 尚未就绪，此处补齐）
    this.evolution.rebind({ llm: deps.llm as any, skillsDir: platformConfig.skillsDir, registry: deps.skillRegistry, memoryDir: platformConfig.memoryDir });
  }

  get store(): RunStore {
    return this.deps.runStore;
  }

  get events(): RunEventStore {
    return this.deps.eventStore;
  }

  get checkpoints(): CheckpointStore {
    return this.deps.checkpointStore;
  }

  /** 个性化服务（设置页开关控制 — API 路由与 run-engine 注入用） */
  get personalizationService(): PersonalizationService {
    return this.personalization;
  }

  /** 习惯学习管线（API 路由用：列表/蒸馏/晋升/纠偏） */
  get habitService(): HabitService {
    return this.habits;
  }

  /** 评测/演示隔离：已知自动化会话标识（GAIA/PawBench/评测驱动）→ 记忆写入默认拒 */
  private isAutomationSession(sessionId?: string): boolean {
    if (!sessionId) return false;
    return /^(gaia-eval|pawbench|eval-|benchmark-)/.test(sessionId);
  }

  get evolutionService(): EvolutionService {
    return this.evolution;
  }

  /** 会话全文检索库（离线对账等 API 侧复用 — 同一 FTS5 表） */
  get searchStore(): SearchStore {
    return this.search;
  }

  /**
   * 启动收尸（REG-25）：执行管线只存在于进程内存里 — 进程一走，库里留在途状态
   *（running / waiting_human / created）的 run 就永远不会推进，而前端照旧把它们当"正在运行"，
   * 用户发进去的补充石沉大海。服务启动时把上次遗留的 free run 统一落为 failed/interrupted。
   * graph run 有自己的恢复语义（markInterruptedGraphRuns），不在此列。返回收尸数量。
   */
  reconcileInterruptedRuns(): number {
    let n = 0;
    for (const status of ['running', 'waiting_human', 'created'] as const) {
      // 标记会改变状态 → 每轮重新查询，直到该状态下没有 free run（上限防死循环）
      for (let round = 0; round < 1000; round++) {
        const { items } = this.deps.runStore.list({ status, mode: 'free', limit: 200 });
        if (items.length === 0) break;
        for (const run of items) {
          if (!run.id) continue;
          this.deps.runStore.update(run.id, {
            status: 'failed',
            endReason: 'interrupted',
            error: {
              message:
                (status === 'waiting_human'
                  ? '服务停止或重启：任务在等待人工处理（审批/反问）时被中断，未完成。'
                  : '服务停止或重启：任务在执行中被中断，未完成。') + '在原会话发送"继续"可接力。',
            },
          });
          // 先把"发出过但没有下文"的反问与审批落定，再发终态事件 —
          // 界面是从事件流派生问题卡/审批卡的：只改任务状态，卡片会一直挂着等人操作
          this.closeDanglingInteractions(run.id);
          this.emitRunEvent(run.id, 'run.failed', { error: '服务停止或重启，任务被中断', interrupted: true, previousStatus: status });
          n++;
        }
      }
    }
    return n;
  }

  /**
   * 收尸配套：把事件流里悬空的反问（question.asked 无 answered）与审批
   *（tool.approval_required 无 resolved）补上落定事件。挂起项永远在事件流尾部（run 正因它而停），
   * 只扫最后 2000 条。
   */
  private closeDanglingInteractions(runId: string): void {
    try {
      const maxSeq = this.deps.eventStore.maxSeq(runId);
      const evs = this.deps.eventStore.listByRun(runId, Math.max(0, maxSeq - 2000), 2000);
      const asked = new Set<string>();
      const answered = new Set<string>();
      const approvals = new Map<string, string>();
      const resolved = new Set<string>();
      for (const e of evs) {
        const p = (e.payload ?? {}) as any;
        if (e.type === 'question.asked' && p.questionId) asked.add(p.questionId);
        else if (e.type === 'question.answered' && p.questionId) answered.add(p.questionId);
        else if (e.type === 'tool.approval_required' && p.approvalId) approvals.set(p.approvalId, String(p.tool ?? ''));
        else if (e.type === 'tool.approval_resolved' && p.approvalId) resolved.add(p.approvalId);
      }
      for (const questionId of asked) {
        if (!answered.has(questionId)) {
          this.emitRunEvent(runId, 'question.answered', { questionId, source: 'cancelled', answer: null });
        }
      }
      for (const [approvalId, tool] of approvals) {
        if (!resolved.has(approvalId)) {
          this.emitRunEvent(runId, 'tool.approval_resolved', { approvalId, approved: false, tool, interrupted: true });
        }
      }
    } catch { /* 事件读取失败不影响收尸本身（任务状态已落） */ }
  }

  /**
   * 运行中用户补充（立即补充模式）：消息进入该 run 的注入邮箱，
   * 下一**步边界**（本轮 LLM/工具完成后、下轮请求组装前）送达模型 —
   * 与 teammate 消息同门（不丢、不打断正在执行的步骤）。
   * 仅接受 running / waiting_human 状态；终态 run 由前端走"排队→续接下一轮"。
   */
  injectUserInput(runId: string, content: string): { ok: boolean; message: string; queued?: number } {
    const text = String(content ?? '').trim();
    if (!text) return { ok: false, message: '补充内容为空' };
    if (text.length > 8000) return { ok: false, message: '补充内容过长（上限 8000 字符）' };
    const run = this.deps.runStore.get(runId);
    if (!run) return { ok: false, message: 'run 不存在' };
    if (!['running', 'waiting_human'].includes(run.status)) {
      return { ok: false, message: `run 已终态（${run.status}），请直接发送开启下一轮（会话上下文自动续接）` };
    }
    // REG-25：状态是"在途"但本进程里没有它的执行管线（上次进程遗留的僵尸）— 明确拒绝，
    // 让前端回落到"开启新一轮"，而不是收下一条永远不会被读到的消息
    if (!this.liveRunIds.has(runId)) {
      return { ok: false, message: '该任务当前没有在执行（可能已被中断），请直接发送开启下一轮（会话上下文自动续接）' };
    }
    let inbox = this.userInboxByRun.get(runId);
    if (!inbox) { inbox = []; this.userInboxByRun.set(runId, inbox); }
    inbox.push({ queuedAt: Date.now(), content: text });
    this.emitRunEvent(runId, 'run.user_input_received', { chars: text.length, queued: inbox.length });
    return { ok: true, message: '已加入注入队列，将在下一步边界送达当前任务', queued: inbox.length };
  }

  /** 步边界排空用户补充邮箱（pollInbox 合流用 — 与团队邮箱同一注入点） */
  private drainUserInput(runId: string): Array<{ from: string; content: string; kind: 'user' }> {
    const inbox = this.userInboxByRun.get(runId);
    if (!inbox || inbox.length === 0) return [];
    this.userInboxByRun.set(runId, []);
    return inbox.map(m => ({
      from: 'user',
      kind: 'user' as const,
      // 大方向改变的引导：todo 全量替换是模型的既有操作 — 注入即提醒先重排计划
      content: `${m.content}\n\n[system note] If this changes the plan significantly, rewrite your todo list FIRST (todo_write), then continue from the new plan. Keep already-done work that is still useful.`,
    }));
  }

  /** 步边界排空平台提示（pollInbox 合流用 — kind=system，前缀 [system note]） */
  private drainSystemNotes(runId: string): Array<{ from: string; content: string; kind: 'system' }> {
    const notes = this.systemInboxByRun.get(runId);
    if (!notes || notes.length === 0) return [];
    this.systemInboxByRun.set(runId, []);
    return notes.map(content => ({ from: 'runtime', kind: 'system' as const, content }));
  }


  /** 验证工程：memoized 验收清单（开工预热与验证门共用 — 清单只算一次） */
  private ensureCriteria(runId: string, goal: string, workspaceDir: string): Promise<CriteriaResult | null> {
    let p = this.criteriaByRun.get(runId);
    if (!p) {
      p = (async () => {
        try {
          if ((this.deps.llm as any).isDemoMode?.()) return null;
          return await generateCriteria({ llm: this.deps.llm as any, goal, workspaceDir });
        } catch { return null; }
      })();
      this.criteriaByRun.set(runId, p);
    }
    return p;
  }

  /** 验证工程：工作区产物清单（名字+大小+小文本内容 — 检查者打开活产物，而不是听转述） */
  private workspaceArtifacts(workspaceDir: string, cap = 50): Array<{ rel: string; bytes: number; content?: string }> {
    try {
      const out: Array<{ rel: string; bytes: number; content?: string }> = [];
      const walk = (rel: string, depth: number) => {
        if (out.length >= cap || depth > 2) return;
        for (const e of readdirSync(pathJoin(workspaceDir, rel))) {
          if (out.length >= cap) return;
          if (e.startsWith('.') || e === 'node_modules' || e === 'CHECKS.md') continue;
          const r = rel ? `${rel}/${e}` : e;
          const abs = pathJoin(workspaceDir, r);
          try {
            const st = statSync(abs);
            if (st.isDirectory()) walk(r, depth + 1);
            else {
              // 小文本产物带内容进判定（ground truth 而非读代码哲学的落地：打开它）
              const small = /\.(md|txt|json|csv|html|ya?ml)$/i.test(e) && st.size <= 8 * 1024;
              out.push({ rel: r, bytes: st.size, ...(small ? { content: readFileSync(abs, 'utf-8').slice(0, 6000) } : {}) });
            }
          } catch { /* 并发删除跳过 */ }
        }
      };
      walk('', 0);
      return out;
    } catch { return []; }
  }

  /** 一错一规（人工采纳）：把一条检查行追加进该 run 工作区的 CHECKS.md */
  promoteCheck(runId: string, line: string): { ok: boolean; message: string } {
    const run = this.deps.runStore.get(runId);
    const wsId = run?.workspace_id;
    if (!wsId) return { ok: false, message: '该 run 未绑定工作区（CHECKS.md 随工作区累积）' };
    const ws = new WorkspaceService().get(wsId);
    if (!ws) return { ok: false, message: '工作区不存在' };
    return appendCheck(ws.dir, line);
  }

  // ─── 反问（ask_user）生命周期 — 与审批同构：挂起 waiting_human → 人作答 → 恢复 ──
  // 每问独立挂起（多问共存可切换作答）；事件留痕 question.asked / answered 可回放。

  /** ask_user 工具的挂起回调：发事件 → 置 waiting_human → 等待作答（超时可选） */
  private askUser(runId: string, payload: AskUserPayload): Promise<AskUserAnswer> {
    return new Promise<AskUserAnswer>(resolve => {
      const asked = this.questionsAskedByRun.get(runId) ?? 0;
      if (asked >= 3) {
        resolve({ source: 'cap', answer: null, note: '本任务询问额度已用完（上限 3 问）。请自行决策并在最终回答中标注假设。' });
        return;
      }
      this.questionsAskedByRun.set(runId, asked + 1);
      const questionId = `q_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      // 状态机：非终态时置 waiting_human（与审批同一语义 — UI 提示等待用户）
      const runNow = this.deps.runStore.get(runId);
      if (runNow && !['completed', 'failed', 'cancelled'].includes(runNow.status)) {
        this.deps.runStore.update(runId, { status: 'waiting_human' });
      }
      this.emitRunEvent(runId, 'question.asked', {
        questionId,
        question: payload.question,
        options: payload.options,
        allowMultiple: payload.allowMultiple ?? false,
      });
      const entry = { runId, payload, resolve, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      // 超时（用户可配：0 = 无限等待）：到点按推荐/假设继续，不悬挂
      const timeoutMin = this.budgetSettings.effective().askUserTimeoutMin;
      if (timeoutMin > 0) {
        entry.timer = setTimeout(() => {
          const cur = this.pendingQuestions.get(questionId);
          if (!cur) return;
          this.pendingQuestions.delete(questionId);
          this.emitRunEvent(runId, 'question.answered', { questionId, source: 'timeout', answer: null });
          this.restoreAfterQuestion(runId);
          cur.resolve({ source: 'timeout', answer: null, note: `用户 ${timeoutMin} 分钟未响应。请按推荐选项或最合理假设继续，并在最终回答中标注假设。` });
        }, timeoutMin * 60_000);
      }
      this.pendingQuestions.set(questionId, entry);
    });
  }

  /** 用户作答（choice=选项下标数组；free=自由文本） */
  answerQuestion(runId: string, questionId: string, body: { choice?: number[]; free?: string }): { ok: boolean; message: string } {
    const entry = this.pendingQuestions.get(questionId);
    if (!entry || entry.runId !== runId) return { ok: false, message: '问题不存在或已作答' };
    // REG-29：先校验、后落定 — 无效作答（下标越界 / 既无选项也无文本）不改任何状态。
    // 此前先删后验：手滑一次，问题就从待答列表消失，而 run 永远挂在 waiting_human 上。
    let answer: AskUserAnswer;
    const freeText = typeof body.free === 'string' ? body.free.trim() : '';
    if (freeText) {
      answer = { source: 'free', answer: freeText.slice(0, 2000) };
    } else if (Array.isArray(body.choice) && body.choice.length > 0) {
      const indexes = body.choice.map(Number);
      if (indexes.some(i => !Number.isInteger(i) || i < 0 || i >= entry.payload.options.length)) {
        return { ok: false, message: `选项下标无效（有效范围 0–${entry.payload.options.length - 1}）` };
      }
      const labels = [...new Set(indexes)].map(i => entry.payload.options[i].label);
      answer = { source: 'choice', answer: labels.join(', ') };
    } else {
      return { ok: false, message: '需要 choice（下标数组）或 free（自由文本）' };
    }
    this.pendingQuestions.delete(questionId);
    if (entry.timer) clearTimeout(entry.timer);
    this.emitRunEvent(runId, 'question.answered', { questionId, source: answer.source, answer: answer.answer });
    this.restoreAfterQuestion(runId);
    entry.resolve(answer);
    return { ok: true, message: '已作答' };
  }

  /** 问题落定后恢复运行态（无其他挂起审批/问题时）；仍等待审批则保持 waiting_human */
  private restoreAfterQuestion(runId: string): void {
    const stillWaitingQ = [...this.pendingQuestions.values()].some(q => q.runId === runId);
    if (stillWaitingQ) return;
    const stillWaitingA = [...this.pendingApprovals.entries()].some(([, p]) => p.runId === runId);
    if (stillWaitingA) return;
    const run = this.deps.runStore.get(runId);
    if (run?.status === 'waiting_human') this.deps.runStore.update(runId, { status: 'running' });
  }

  /** 某 run 的待答问题（前端刷新恢复用） */
  listPendingQuestions(runId: string): Array<{ questionId: string; question: string; options: AskUserPayload['options']; allowMultiple: boolean }> {
    return [...this.pendingQuestions.entries()]
      .filter(([, e]) => e.runId === runId)
      .map(([questionId, e]) => ({ questionId, question: e.payload.question, options: e.payload.options, allowMultiple: e.payload.allowMultiple ?? false }));
  }

  /** run 结束/取消：未答问题统一以 cancelled 落定（防悬挂） */
  private resolveAllQuestions(runId: string): void {
    for (const [questionId, entry] of [...this.pendingQuestions.entries()]) {
      if (entry.runId !== runId) continue;
      this.pendingQuestions.delete(questionId);
      if (entry.timer) clearTimeout(entry.timer);
      this.emitRunEvent(runId, 'question.answered', { questionId, source: 'cancelled', answer: null });
      entry.resolve({ source: 'cancelled', answer: null, note: '任务已结束，问题作废。' });
    }
  }

  /** 外部命令守卫（hooks — API/启动接线用） */
  get hooks(): HookService {
    return this.hookSvc;
  }

  /** 创建并异步执行一个 Free 模式 run */
  startRun(input: StartRunInput): { runId: string; sessionId?: string } {
    // ESTOP 哨兵：拉闸期间拒绝一切新工作（在跑的不杀）
    if (isEstopped()) {
      throw new Error(`平台已暂停（ESTOP）：${estopReason()}。解除：coral resume 或删除 data/ESTOP 文件。`);
    }
    let goal = String(input.goal ?? '').trim();
    if (!goal) throw new Error('缺少 goal');
    // 斜杠命令展开：/cmd 参数 → 命令模板（用户快捷指令；展开事实记入事件流）
    let expandedFrom: string | undefined;
    const slash = this.slashCommands.expand(goal);
    if (slash) {
      goal = slash.goal.slice(0, GOAL_LIMIT);
      expandedFrom = `/${slash.command.name} ${slash.arguments}`.trim();
    }
    if (goal.length > GOAL_LIMIT) {
      throw new Error(`goal 过长（${goal.length} 字符，上限 ${GOAL_LIMIT}）`);
    }
    const sessionId = input.sessionId ? String(input.sessionId).slice(0, 64) : undefined;

    // M1-10：解析工作区（不传 = 无 fs/shell 工具；传了不存在 = 报错）
    let workspace: Workspace | null = null;
    if (input.workspaceId) {
      workspace = new WorkspaceService().get(input.workspaceId);
      if (!workspace) throw new Error(`工作区不存在: ${input.workspaceId}`);
    }

    // 预算解析优先级：请求级 > 用户设置（设置页）> 平台默认（.env）
    const eff = this.budgetSettings.effective();
    const budget = {
      // 0 = 无上限（clamp 允许 0；>0 时夹在 [1, CAP]）
      maxSteps: Math.min(Math.max(input.budget?.maxSteps ?? eff.maxSteps, 0), MAX_STEPS_CAP),
      maxTokens: Math.min(Math.max(input.budget?.maxTokens ?? eff.maxTokens, 0), MAX_TOKENS_CAP),
      ...(input.budget?.maxCostUsd !== undefined ? { maxCostUsd: input.budget.maxCostUsd } : {}),
    };

    const runId = newRunId();
    this.deps.runStore.insert({
      id: runId, goal, mode: 'free', sessionId, budget,
      ...(input.parentRunId ? { parentRunId: input.parentRunId, forkFromSeq: input.forkFromSeq } : {}),
      ...(workspace ? { workspaceId: workspace.id } : {}), // 终审 P2：fork 继承去单点（事件反查不再是唯一来源）
    });
    this.emitRunEvent(runId, 'run.created', {
      goal,
      sessionId,
      ...(expandedFrom ? { expandedFrom } : {}),
      ...(input.parentRunId ? { forkFrom: input.parentRunId, forkFromSeq: input.forkFromSeq } : {}),
      budget,
      ...(workspace ? { workspace: { id: workspace.id, name: workspace.name, permission: workspace.permission } } : {}),
      ...(input.unattended ? { unattended: true } : {}),
    });

    this.liveRunIds.add(runId); // executeRun 的 finally 注销
    if (input.unattended) this.unattendedRuns.add(runId);
    const controller = createAbortController(runId);
    // 斜杠展开后的 goal 传给 executeRun（此前传的是原始 input.goal — 展开结果从未到达模型）
    const execInput = { ...input, goal };
    // 异步执行（与 v1 executeTask 同风格：调用方立即拿到 runId）
    void this.executeRun(runId, execInput, workspace, controller.signal).catch(err => {
      console.error(`[RunEngine] run ${runId} 执行异常:`, err);
    });

    return { runId, sessionId };
  }

  /** 取消 run（幂等：终态不回退；事件由本方法统一发出） */
  cancelRun(runId: string): { ok: boolean; message: string } {
    const run = this.deps.runStore.get(runId);
    if (!run) return { ok: false, message: 'run 不存在' };
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      return { ok: true, message: `run 已处于终态（${run.status}）` };
    }
    abortTask(runId); // 立即中止 loop / 工具 / LLM
    this.rejectAllApprovals(runId); // 挂起的审批直接拒绝（loop 不悬挂）
    this.resolveAllQuestions(runId); // 挂起的反问一并作废（防悬挂）
    this.deps.runStore.update(runId, { status: 'cancelled', endReason: 'cancelled' });
    this.emitRunEvent(runId, 'run.cancelled', { reason: 'user_cancelled' });
    return { ok: true, message: 'run 已取消' };
  }

  /** 删除 run（运行中先取消；事件/检查点/证据记录级联清除） */
  deleteRun(runId: string): { ok: boolean; message: string } {
    const run = this.deps.runStore.get(runId);
    if (!run) return { ok: false, message: 'run 不存在' };
    if (['running', 'waiting_human'].includes(run.status)) {
      this.cancelRun(runId); // 先中止，避免悬挂的 loop 往已删除的 run 写事件
    }
    this.rejectAllApprovals(runId);
    this.evidence.deleteRun(runId);
    this.search.deleteRun(runId); // FTS 无外键 — 显式清理检索文档
    const deleted = this.deps.runStore.delete(runId);
    return { ok: deleted, message: deleted ? '已删除' : '删除失败' };
  }

  /** 删除整个会话（含全部 run；证据目录与检索文档一并清理） */
  deleteSession(sessionId: string): number {
    // 列表接口单次最多 200 条 — 大会话（评测会话实测 231 个 run）必须翻页：否则排在 200 名之外的
    // run 只从数据库消失，证据目录 / 检索文档 / 挂起审批留在原地（REG-37）。
    // 数据库删除放在最后，翻页期间列表是稳定的
    for (let offset = 0; ; offset += 200) {
      const { items } = this.deps.runStore.list({ sessionId, limit: 200, offset });
      for (const run of items) {
        if (['running', 'waiting_human'].includes(run.status)) {
          this.cancelRun(run.id);
        }
        this.rejectAllApprovals(run.id); // 挂起审批一并落定（防悬挂）
        this.evidence.deleteRun(run.id); // 证据目录不随 DB 级联 — 显式清理
        this.search.deleteRun(run.id);   // 检索文档同理
      }
      if (items.length < 200) break;
    }
    return this.deps.runStore.deleteSession(sessionId);
  }

  getRunDetail(runId: string): { run: Run; events: any[]; checkpoints: any[] } | null {
    const run = this.deps.runStore.get(runId);
    if (!run) return null;
    return {
      run,
      // P2: 取尾部 — listByRun 内部 cap 2000 实际返回头部，必须先查 maxSeq 再从尾部拉
      events: (() => {
        const maxSeq = this.deps.eventStore.maxSeq(runId);
        const from = Math.max(0, maxSeq - 2000);
        return this.deps.eventStore.listByRun(runId, from, 2000);
      })(),
      checkpoints: this.deps.checkpointStore.listByRun(runId),
    };
  }

  // ─── 内部 ────────────────────────────────────────────────

  /** 多轮续接：取会话内最近一个有 checkpoint 的 run，返回其末次快照的消息历史 */
  private loadSessionHistory(sessionId: string): { history: import('../providers/types.js').ChatMessage[]; fromRunId: string } | null {
    const { items } = this.deps.runStore.list({ sessionId, limit: 20 });
    // list 按创建时间倒序 — 找第一个有 checkpoint 的
    for (const run of items) {
      if (run.id === undefined) continue;
      const cps = this.deps.checkpointStore.listByRun(run.id);
      if (cps.length === 0) continue;
      const last = cps[cps.length - 1];
      const state = this.deps.checkpointStore.get(run.id, last.seq);
      if (state?.messages && state.messages.length > 0) {
        return { history: this.sanitizeSessionHistory(state.messages), fromRunId: run.id };
      }
    }
    return null;
  }

  /** 审查 P1：剔除末尾悬空的 assistant(toolCalls)（取消时工具结果缺失会毒化续接请求） */
  private sanitizeSessionHistory(messages: import('../providers/types.js').ChatMessage[]): import('../providers/types.js').ChatMessage[] {
    // 终审 P1：与 agent-loop.sanitizeForCheckpoint 同规则 — 按"组"校验完整性，
    // 部分应答组（多工具块中途取消）也移除（REG-04 补全）
    const out = [...messages];
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i];
      if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
      const ids = new Set(m.toolCalls.map(c => c.id));
      const answeredIds = new Set(
        out.slice(i + 1).filter(x => x.role === 'tool' && ids.has((x as any).toolCallId)).map(x => (x as any).toolCallId)
      );
      if (!m.toolCalls.every(c => answeredIds.has(c.id))) {
        out.splice(i, 1);
        for (let j = out.length - 1; j >= i; j--) {
          if (out[j].role === 'tool' && ids.has((out[j] as any).toolCallId)) out.splice(j, 1);
        }
      }
    }
    return out;
  }

  private async executeRun(runId: string, input: StartRunInput, workspace: Workspace | null, signal: AbortSignal): Promise<void> {
    // 终态登记（finally 的记忆使用记账用 — 异常/取消路径也要有终态）
    let outcomeStatus: string | undefined;
    try {
      // 多轮续接：同会话上一轮的完整对话（checkpoint 事件溯源回放）；
      // M4-1 fork：显式 initialHistory 优先（Time-Travel 从任意 checkpoint 回放）
      let initialHistory: import('../providers/types.js').ChatMessage[] | undefined;
      let continuedFrom: string | undefined;
      if (input.initialHistory && input.initialHistory.length > 0) {
        initialHistory = input.initialHistory;
        continuedFrom = input.parentRunId;
      } else if (input.continueSession && input.sessionId) {
        const prev = this.loadSessionHistory(input.sessionId);
        if (prev) {
          initialHistory = prev.history;
          continuedFrom = prev.fromRunId;
        }
        // 会话级上下文：本会话已分析的文件摘要（不进长期记忆，跨 run 共享）
        try {
          const dataDir = (await import('path')).dirname(platformConfig.databasePath);
          const sessionCtx = new (await import('../services/session-context-service.js')).SessionContextService(dataDir);
          sessionCtx.setGoal(input.sessionId, input.goal); // 接力简报的 goal（已设置则不覆盖）
          const ctxText = sessionCtx.toPromptText(input.sessionId);
          if (ctxText) {
            input.extraSystem = (input.extraSystem ? input.extraSystem + '\n\n' : '') + ctxText;
          }
        } catch { /* 会话上下文加载失败不影响 run */ }
      }

      this.deps.runStore.update(runId, { status: 'running' });
      this.emitRunEvent(runId, 'run.started', continuedFrom ? { continuedFrom } : {});
      this.runMeta.set(runId, { sessionId: input.sessionId ?? '', goal: input.goal });

      // 验证工程（B4 标准前置）：工作区交互 run 开工即预热验收清单（memoized —
      // 验证门复用同一 promise，保证清单只依赖 goal+CHECKS.md，永不含产物）。
      // 生成时发现的歧义经平台提示通道告知模型：实质性的用 ask_user 澄清，其余自行取默认。
      const verifyEligible = Boolean(workspace)
        && !this.isAutomationSession(input.sessionId)
        && this.budgetSettings.effective().verificationEnabled !== false;
      if (verifyEligible) {
        void this.ensureCriteria(runId, input.goal, workspace!.dir).then(cr => {
          if (cr && cr.ambiguities.length > 0 && !input.unattended) {
            // REG-26：无人值守的 run 现场没有人 — 不提示反问（模型按最合理假设继续并注明）
            const notes = this.systemInboxByRun.get(runId) ?? [];
            notes.push(
              `开工检查发现任务有几处没说死：${cr.ambiguities.join('；')}。` +
              `只有当不同理解会明显改变交付物（范围/受众/输出格式）时才用 ask_user 向用户确认；` +
              `其余按常规默认处理，并在最终回答里说明所采用的假设。`
            );
            this.systemInboxByRun.set(runId, notes);
          }
          if (cr) {
            this.emitRunEvent(runId, 'verify.criteria', {
              lines: cr.lines.map(l => ({ line: l.line, source: l.source })),
              ambiguities: cr.ambiguities,
            });
          }
        }).catch(() => { /* 预热失败不伤 run — 验证门会现生成 */ });
      }

      const run = this.deps.runStore.get(runId)!;
      const budget = (run.budget ?? {}) as { maxSteps?: number; maxTokens?: number };

      // 模型路由：指定 modelProfileId 时为本 run 创建独立 LLM 客户端
      //（不影响全局 active 配置 — 评测/自动化场景按题切模型的基础）
      let runLlm = this.deps.llm;
      let routedModel: string | undefined;
      if (input.modelProfileId) {
        try {
          const profile = (await import('../services/llm-config-service.js')).getLlmConfigForRouting(input.modelProfileId);
          if (profile) {
            const { LLMClient } = await import('../services/llm-client.js');
            const tempClient = new LLMClient();
            tempClient.reconfigure({
              baseUrl: profile.baseUrl,
              apiKey: profile.apiKey,
              model: profile.model,
              provider: profile.provider,
            });
            runLlm = tempClient;
            routedModel = profile.model;
            this.emitRunEvent(runId, 'run.model_routed', { model: profile.model, profileId: profile.profileId });
          } else {
            this.emitRunEvent(runId, 'run.model_route_failed', { error: `profile ${input.modelProfileId} 不存在，使用默认模型` });
          }
        } catch (err: any) {
          this.emitRunEvent(runId, 'run.model_route_failed', { error: err?.message ?? String(err) });
        }
      }

      const { tools, team } = this.buildTools(runId, workspace, runLlm, input.sessionId, input.unattended === true);
      // 精确重放：模型配置快照（路由优先；否则取当前 active 配置）
      let modelInfo: { model: string; provider?: string; baseUrl?: string; profileId?: string };
      if (input.modelProfileId && routedModel) {
        modelInfo = { model: routedModel, profileId: input.modelProfileId };
      } else {
        try {
          const active = (await import('../services/llm-config-service.js')).getActiveLlmConfig();
          modelInfo = { model: active.model, provider: active.provider, baseUrl: active.baseUrl };
        } catch {
          modelInfo = { model: routedModel ?? 'unknown' };
        }
      }
      const loop = new AgentLoop(runLlm, {
        runId,
        agentId: 'main',
        goal: input.goal,
        tools,
        budget: {
          maxSteps: loopBudgetValue(budget.maxSteps, platformConfig.runMaxSteps),
          maxTokens: loopBudgetValue(budget.maxTokens, platformConfig.runMaxTokens),
        },
        signal,
        workspaceDir: workspace?.dir,
        initialHistory,
        // 恢复指令（Recovery Note）：带历史恢复执行（fork/会话续接）且可能产生
        // 外部副作用（绑定了工作区）时注入 — 副作用前先核对真实状态，不重复已应用动作
        ...(initialHistory && workspace ? { recoveryNote: true } : {}),
        // 精确重放：fork 携带历史系统提示时一字不差复现（优先于现场组装）
        ...(input.forkSystem ? { exactSystem: input.forkSystem } : {}),
        modelInfo,
        // 团队/用户邮箱合流（主循环）：步边界排空 — teammate 消息、"运行中用户补充"与平台提示
        // 同门注入（不丢、不打断当前步骤）
        pollInbox: () => [...team.drain('main'), ...this.drainUserInput(runId), ...this.drainSystemNotes(runId)],
        // D18：记忆使用指引常驻系统提示；调用方的 extraSystem 追加在后
        // D18 记忆指引 + 个人画像（越聊越懂用户）+ 协作习惯 + 具名子代理目录 + 个性化（6维度，默认关）+ 调用方 extraSystem
        extraSystem: [
          MEMORY_GUIDE,
          (await import('../services/user-profile-service.js')).userProfileToPrompt(
            (await import('../services/user-profile-service.js')).getUserProfile()
          ),
          this.habits.toPromptText(),
          this.agentPresets.toPromptText(),
          this.personalization.buildInjection(input.goal),
          input.extraSystem,
        ].filter(Boolean).join('\n\n'),
        onEvent: e => this.onLoopEvent(runId, e),
        saveCheckpoint: cp => this.saveCheckpoint(runId, cp),
        evidenceStore: this.evidence,
        hooks: this.loopHooks,
        // 验证门（A1）：交付前独立验收 — 清单 memoized（开工已预热），判决留档供终态事件
        ...(verifyEligible && workspace ? {
          verifyGate: async (finalContent: string) => {
            const criteria = await this.ensureCriteria(runId, input.goal, workspace!.dir);
            if (!criteria || criteria.lines.length === 0) return null;
            const verdict = await verifyDeliverable({
              llm: runLlm as any,
              goal: input.goal,
              criteria: criteria.lines,
              finalContent,
              artifacts: this.workspaceArtifacts(workspace!.dir),
            });
            const rounds = (this.verdictByRun.get(runId)?.rounds ?? 0) + 1;
            this.verdictByRun.set(runId, { ...verdict, rounds });
            return {
              passed: verdict.passed,
              failedLines: verdict.results.filter(r => !r.pass && !r.unverifiable).map(r => ({ line: r.line, evidence: r.evidence })),
              passedCount: verdict.passedCount,
              totalCount: verdict.totalCount,
            };
          },
        } : {}),
        // M1-10：工作区存在时启用审批流（ask/auto 的 approval 工具 + shell）
        approveTool: workspace
          ? (tool, inp, callId) => this.requestApproval(runId, tool, inp, callId, workspace)
          : undefined,
        summarize: async transcript => this.summarizeTranscript(transcript),
      });

      const result = await loop.run();
      // 主循环已返回 — 之后再没有人收割 teammate：立即终止 run 级后台作用域（REG-25）
      this.abortBackground(runId);
      outcomeStatus = result.status;
      if (signal.aborted) {
        // 取消也要记账（REG-41）：已经花掉的 token 是真实成本 — 此前直接返回，库里永远记 0。
        // 只写 token 数，状态仍由 cancelRun / markCancelled 决定
        const teamTokens = this.teamTokensByRun.get(runId) ?? { in: 0, out: 0 };
        this.deps.runStore.update(runId, {
          tokensIn: result.tokensIn + (result.childTokensIn ?? 0) + teamTokens.in,
          tokensOut: result.tokensOut + (result.childTokensOut ?? 0) + teamTokens.out,
        });
        this.markCancelled(runId);
        return;
      }
      await this.settleBackground(runId);
      // run 总账 = 主循环 + 同步子代理（agent_spawn）+ 后台 teammate
      const teamTokens = this.teamTokensByRun.get(runId) ?? { in: 0, out: 0 };
      const totalTokensIn = result.tokensIn + (result.childTokensIn ?? 0) + teamTokens.in;
      const totalTokensOut = result.tokensOut + (result.childTokensOut ?? 0) + teamTokens.out;

      // 原地打转（stalled）是平台终止的失败态：库里落 failed + end_reason=stalled（词表不变，同 002 迁移惯例）
      const failed = result.status === 'failed' || result.status === 'stalled';
      const status = result.status === 'completed' || result.status === 'budget_exceeded' ? 'completed' : 'failed';
      this.deps.runStore.update(runId, {
        status,
        endReason: result.status === 'budget_exceeded' ? 'budget_exceeded'
          : result.status === 'completed' ? 'final_answer'
          : result.status,
        finalContent: result.finalContent,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        ...(failed ? { error: { message: result.error } } : {}),
      });

      if (result.status === 'budget_exceeded') {
        this.emitRunEvent(runId, 'run.budget_exceeded', { steps: result.steps, tokensIn: totalTokensIn, tokensOut: totalTokensOut });
      }
      if (result.status === 'stalled') {
        this.emitRunEvent(runId, 'run.stalled', { steps: result.steps, toolCalls: result.toolCalls, tokensIn: totalTokensIn, tokensOut: totalTokensOut, error: result.error });
      }
      // 验证工程（A2）：终态判决事件 — 带级别（4=全过带证据/3=全过部分不可验/2=有失败）、
      // 逐行结果（失败行可被人工采纳进 CHECKS.md）。未验证的 run 不发（UI 显示"未验证"）
      const finalVerdict = this.verdictByRun.get(runId);
      if (result.status === 'completed' && result.finalContent.trim() && finalVerdict && finalVerdict.totalCount > 0) {
        this.emitRunEvent(runId, 'run.verified', {
          level: finalVerdict.level,
          passed: finalVerdict.passed,
          passedCount: finalVerdict.passedCount,
          totalCount: finalVerdict.totalCount,
          rounds: finalVerdict.rounds,
          results: finalVerdict.results,
        });
      }
      // 自评轻闭环：完成态先跑一次确定性五轴评分并落事件（零成本、不阻断 —
      // 外部审查指出自评原先只存在于 API 里，交付链上没有痕迹；置于 completed 之前，
      // 让 completed 仍是事件流的终态事件）
      if (result.status === 'completed' && result.finalContent.trim()) {
        try {
          const evalResult = evaluateDeterministic(input.goal, result.finalContent);
          this.emitRunEvent(runId, 'run.self_eval', {
            overall: Number(evalResult.overall.toFixed(2)),
            axes: evalResult.axes.map(a => ({ axis: a.axis, score: a.score })),
            heuristicNotes: evalResult.heuristicNotes,
          });
        } catch { /* 自评失败不影响 run */ }
      }

      this.emitRunEvent(
        runId,
        failed ? 'run.failed' : 'run.completed',
        failed
          ? { error: result.error }
          : { finalContentPreview: result.finalContent.slice(0, 500), steps: result.steps, toolCalls: result.toolCalls, tokensIn: totalTokensIn, tokensOut: totalTokensOut }
      );
      // （记忆使用记账统一在 finally — 任何收尾路径都且只记一次，REG-29）

      // 会话全文检索：终态时（重）索引本 run 的检索文档（goal + 最终回答 + 消息轨迹）
      if (result.status === 'completed') {
        try {
          this.search.indexRun(runId, input.goal, result.finalContent, result.messages);
        } catch { /* 索引失败不影响 run */ }

        // 运行后蒸馏管线（fire-and-forget）：技能修订/新技能/画像提议，至多一次 LLM 调用
        if (result.steps >= 8 && !(this.deps.llm as any).isDemoMode?.()) {
          try {
            const evs = this.deps.eventStore.listByRun(runId, 0, 10_000);
            const skillsUsed = new Set<string>();
            const skillFailures: Array<{ tool: string; errorPreview: string }> = [];
            let gateRejections = 0;
            let subagentFailures = 0;
            for (const e of evs) {
              const tool = (e.payload as any)?.tool;
              if ((e.type === 'tool.call_completed' || e.type === 'tool.call_failed') && typeof tool === 'string' && tool.startsWith('skill_')) {
                skillsUsed.add(tool.replace(/^skill_/, ''));
                if (e.type === 'tool.call_failed') {
                  skillFailures.push({ tool, errorPreview: JSON.stringify((e.payload as any)?.error ?? '').slice(0, 120) });
                }
              }
              if (e.type === 'loop.gate_rejected') gateRejections++;
              if (e.type === 'subagent.failed' || e.type === 'team.teammate_failed') subagentFailures++;
            }
            void this.evolution.considerRun({
              runId,
              goal: input.goal,
              steps: result.steps,
              toolCalls: result.toolCalls,
              skillsUsed: [...skillsUsed],
              skillFailures,
              gateRejections,
              subagentFailures,
              transcriptTail: result.messages
                .slice(-15)
                .map(m => `${m.role}: ${String(m.content ?? '').slice(0, 300)}`)
                .join('\n'),
            });
          } catch { /* 信号收集失败不影响 run */ }
        }
      }

      // M1-11（D18）：会话结束记忆整理 — 仅正常完成时；demo 模式与开关关闭时跳过。
      // REG-20：评测/自动化会话不整理 — 它的转录只服务评测本身。此前隔离只做在
      // memory_write 一个入口，评测会话跑完照常蒸馏，长期记忆被评测题的碎片灌满。
      if (
        result.status === 'completed'
        && platformConfig.memoryDistillEnabled
        && !(this.deps.llm as any).isDemoMode?.()
        && !this.isAutomationSession(input.sessionId)
      ) {
        await this.distillAfterRun(runId, result.messages, input.sessionId);
        // 习惯蒸馏：观察攒够阈值才跑（个人量级：约每 20 次工具调用一次）
        if (this.habits.observationsSinceLastDistill() >= 20) {
          void this.habits.distill(this.deps.llm, input.sessionId)
            .then(r => {
              if (r.created + r.reinforced > 0 || r.promotedReady.length > 0) {
                this.emitRunEvent(runId, 'habit.distilled', r);
              }
            })
            .catch(() => { /* 学习失败静默 */ });
        }
      }
    } catch (err: any) {
      if (signal.aborted) {
        this.markCancelled(runId);
        return;
      }
      outcomeStatus = 'failed';
      this.deps.runStore.update(runId, { status: 'failed', error: { message: err?.message ?? String(err) }, endReason: 'failed' });
      this.emitRunEvent(runId, 'run.failed', { error: err?.message ?? String(err) });
    } finally {
      this.releaseSeq(runId);
      this.runMeta.delete(runId);
      // 记忆使用记账：本 run 读过/命中过的文件 — 命中计数；failed 收尾的读取做
      // 误导弱归因（只记录：失败未必是记忆的锅，处置权留给人）。
      // 只在 finally 记（任何收尾路径都且只记一次 — REG-29）
      const memReads = this.memoryReadsByRun.get(runId);
      if (memReads && memReads.size > 0) {
        try {
          this.memoryUsage.recordUse([...memReads]);
          if (outcomeStatus === 'failed' || outcomeStatus === 'stalled') this.memoryUsage.recordSuspect([...memReads]);
        } catch { /* 记账失败不影响 run */ }
      }
      this.memoryReadsByRun.delete(runId);
      this.userInboxByRun.delete(runId);
      // run 级内部状态一律随 run 释放（REG-29：清单 promise / 判决 / 已问数 / 平台提示 —
      // 此前只在部分路径清理，长驻进程里只增不减）
      this.systemInboxByRun.delete(runId);
      this.criteriaByRun.delete(runId);
      this.verdictByRun.delete(runId);
      this.questionsAskedByRun.delete(runId);
      // 兜底：仍有挂起的反问 → 以 cancelled 落定（正常路径此时不可能有；异常路径防悬挂）
      this.resolveAllQuestions(runId);
      // 终止 run 的全部后台作用域（幂等；取消 → 主循环结束 → run 收尾 各调用一次）
      this.abortBackground(runId);
      this.backgroundScopes.delete(runId); // 作用域均已 abort；teammate 侧稍后的注销是空操作
      this.teamTokensByRun.delete(runId);
      // 按 runId 精准清理——clear() 会误杀其他并发 run 的观察记录
      for (const [cid, obs] of this.pendingObs) {
        if (obs.runId === runId) this.pendingObs.delete(cid);
      }
      this.rejectAllApprovals(runId); // 挂起的审批随 run 结束一并落定（防泄漏/悬挂）
      releaseAbortController(runId);
      this.liveRunIds.delete(runId);
      this.unattendedRuns.delete(runId);
    }
  }

  /** 后台 teammate 注册（team_spawn 调用 — 主循环结束时统一终止） */
  private registerBackground(runId: string, scope: AbortController): void {
    let set = this.backgroundScopes.get(runId);
    if (!set) { set = new Set(); this.backgroundScopes.set(runId, set); }
    set.add(scope);
  }

  private unregisterBackground(runId: string, scope: AbortController): void {
    const set = this.backgroundScopes.get(runId);
    if (!set) return;
    set.delete(scope);
    if (set.size === 0) {
      // 最后一个 teammate 落定 → 唤醒等待方
      const waiters = this.backgroundWaiters.get(runId);
      if (waiters) {
        this.backgroundWaiters.delete(runId);
        for (const w of [...waiters]) w();
      }
    }
  }

  /** 等待 run 的后台 teammate 全部落定（上限 timeoutMs — 不让收尾被个别 teammate 拖住） */
  private async settleBackground(runId: string, timeoutMs = 2000): Promise<void> {
    const set = this.backgroundScopes.get(runId);
    if (!set || set.size === 0) return;
    this.abortBackground(runId);
    await new Promise<void>(resolve => {
      const waiters = this.backgroundWaiters.get(runId) ?? [];
      const finish = () => {
        clearTimeout(timer);
        const i = waiters.indexOf(finish);
        if (i >= 0) waiters.splice(i, 1);
        if (waiters.length === 0) this.backgroundWaiters.delete(runId);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      waiters.push(finish);
      this.backgroundWaiters.set(runId, waiters);
    });
  }

  /** 终止 run 的全部后台作用域（幂等；取消 → 主循环结束 → run 收尾 各调用一次） */
  private abortBackground(runId: string): void {
    const set = this.backgroundScopes.get(runId);
    if (!set) return;
    for (const scope of set) {
      if (!scope.signal.aborted) scope.abort(new Error('run 已结束，后台 teammate 终止'));
    }
  }

  private markCancelled(runId: string): void {
    const run = this.deps.runStore.get(runId);
    if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) return;
    this.deps.runStore.update(runId, { status: 'cancelled', endReason: 'cancelled' });
    // 事件由 cancelRun API 统一发出；此处不重复
  }

  /** loop 事件 → events 表 + eventBus（双写）+ 习惯观察；agentId 区分主循环/sub-agent（M1-4） */
  private onLoopEvent(runId: string, e: LoopEvent): void {
    const payload = { runId, ...(e.payload ?? {}) };
    const agentId = typeof (payload as any).agentId === 'string' ? (payload as any).agentId : 'main';
    const toolName = typeof (payload as any).tool === 'string' ? (payload as any).tool : undefined;
    const stored = this.deps.eventStore.insert({
      runId,
      seq: this.nextSeq(runId),
      type: e.type,
      agentId,
      toolName,
      payload,
    });
    this.bridgeToBus(stored);
    this.observeForHabits(runId, e.type, payload as any, agentId);
    this.observeMemoryUse(runId, e.type, payload as any);
    this.bridgeToHooks(runId, e.type, payload as any);
  }

  /** 记忆使用观察：read/search 命中收集到 run 级集合（终态统一记账，失败时弱归因） */
  private observeMemoryUse(runId: string, type: string, payload: any): void {
    try {
      if (type === 'memory.read' && typeof payload?.name === 'string' && payload.name) {
        let set = this.memoryReadsByRun.get(runId);
        if (!set) { set = new Set(); this.memoryReadsByRun.set(runId, set); }
        set.add(payload.name);
      } else if (type === 'memory.search_hit' && Array.isArray(payload?.files)) {
        let set = this.memoryReadsByRun.get(runId);
        if (!set) { set = new Set(); this.memoryReadsByRun.set(runId, set); }
        for (const f of payload.files) if (typeof f === 'string' && f) set.add(f);
      }
    } catch { /* 观察失败不影响事件流 */ }
  }

  /** 观察/通知类钩子桥接（fire-and-forget — 绝不拖慢事件流）：终态→session_end，审批→notification */
  private bridgeToHooks(runId: string, type: string, payload: any): void {
    try {
      if (type === 'run.completed' || type === 'run.failed' || type === 'run.cancelled') {
        void this.hookSvc.run('session_end', {
          runId,
          outcome: type.replace('run.', ''),
          status: payload?.error ? 'failed' : 'ok',
          steps: payload?.steps,
        }).catch(() => {});
      } else if (type === 'tool.approval_required') {
        void this.hookSvc.run('notification', {
          runId, kind: 'approval_required', tool: payload?.tool,
        }).catch(() => {});
      }
    } catch { /* 桥接异常不影响事件流 */ }
  }

  /** 习惯观察：call_started 记输入，completed/failed 落笔（确定性事件流，不依赖模型自觉） */
  private observeForHabits(runId: string, type: string, payload: any, agentId: string): void {
    try {
      if (type === 'tool.call_started' && payload.callId) {
        this.pendingObs.set(payload.callId, {
          tool: String(payload.tool ?? ''),
          inputPreview: String(payload.inputPreview ?? ''),
          agentId,
          runId, // 并发 run 隔离：finally 块按 runId 精准清理，不动其他 run 的观察
        });
        return;
      }
      if (type !== 'tool.call_completed' && type !== 'tool.call_failed') return;
      const callId = payload.callId;
      if (!callId) return;
      const pending = this.pendingObs.get(callId);
      this.pendingObs.delete(callId);
      if (!pending || pending.tool.startsWith('skill_')) return; // 技能=提示生成，观察价值低
      const meta = this.runMeta.get(runId);
      this.habits.observe({
        runId,
        sessionId: meta?.sessionId ?? '',
        agentId: pending.agentId,
        tool: pending.tool,
        ok: type === 'tool.call_completed',
        inputPreview: pending.inputPreview,
        goalPreview: meta?.goal.slice(0, 120) ?? '',
      });
    } catch { /* 观察失败不影响事件流 */ }
  }

  /** run 级事件（与 loop 事件同通道） */
  private emitRunEvent(runId: string, type: string, payload: Record<string, any>): void {
    const stored = this.deps.eventStore.insert({
      runId,
      seq: this.nextSeq(runId),
      type,
      agentId: 'main',
      payload: { runId, ...payload },
    });
    this.bridgeToBus(stored);
  }

  private seqCounters = new Map<string, number>();

  private nextSeq(runId: string): number {
    // 终审 P2：REG-09 对齐 graph 侧 — 惰性从持久层播种（重启后 cancel 等事件不再撞号）
    if (!this.seqCounters.has(runId)) {
      this.seqCounters.set(runId, this.deps.eventStore.maxSeq(runId));
    }
    const next = this.seqCounters.get(runId)! + 1;
    this.seqCounters.set(runId, next);
    return next;
  }

  /** 释放已结束 run 的 seq 计数器（防泄漏） */
  private releaseSeq(runId: string): void {
    this.seqCounters.delete(runId);
  }

  private saveCheckpoint(runId: string, cp: LoopCheckpoint): void {
    this.deps.checkpointStore.insert({
      runId,
      seq: cp.seq,
      kind: 'loop_step',
      label: cp.label,
      state: cp.state,
    });
  }

  /** events 表事件 → eventBus（WS/SSE 实时通道；taskId=runId 路由） */
  private bridgeToBus(e: any): void {
    try {
      eventBus.emit(e.type as any, {
        taskId: e.runId,
        runId: e.runId,
        ...e.payload,
      });
    } catch { /* 总线异常不影响执行 */ }
  }

  /** 工具集：默认 registry（内置+技能）+ D19/D18/M1-4 工具，按工作区权限档过滤（M1-10）。
   *  · 无工作区    → 无 fs/shell 工具（模型根本看不到）
   *  · readonly    → 只读 fs（list/read/search）
   *  · ask（默认） → fs 全量（写改 approval）+ shell（如启用，approval）
   *  · auto        → fs 权限位提为 auto；shell 保持 approval（D13）
   *  注意：todo_write 的 emit 是构造时注入的闭包（不走 ctx.emit），必须显式路由到本 run 的事件流 */
  private buildTools(runId: string, workspace: Workspace | null, llmOverride?: any, sessionId?: string, unattended = false): { tools: Tool[]; team: TeamService } {
    const registry = createDefaultToolRegistry({
      skillRegistry: this.deps.skillRegistry,
      skillExecutor: this.deps.skillExecutor,
      includeFs: Boolean(workspace),
      enableShell: Boolean(workspace) && platformConfig.shellToolEnabled,
    });
    let tools = registry.list();

    // M1-10：按权限档过滤/提升
    const perm = workspace?.permission ?? null;
    // auto 档提升范围：工作区内落盘工具（fs 写改 + docx 生成）。
    // shell 不在此列 — D13 独立决策：即使 auto 档也每次审批
    const FS_WRITE = new Set(['fs_write', 'fs_edit', 'docx_write']);
    // D20/D11：fs_search 与 docx 工具仅在绑定工作区时可用
    // （必须先加入再提升 — 否则 docx_write 的 auto 提升扫不到它）
    if (workspace) {
      tools.push(fsSearchTool);
      tools.push(...docxTools);
    }
    tools = tools.filter(t => {
      if (!t.name.startsWith('fs_') && t.name !== 'shell_run' && t.name !== 'docx_write') return true; // 非工作区工具不受影响
      // 审查 P2：readonly 档是"读"档 — docx_write 是写工具，不得只靠审批位放行
      if (perm === 'readonly') return t.name === 'fs_list' || t.name === 'fs_read' || t.name === 'fs_search' || t.name === 'docx_read';
      return true;
    });
    if (perm === 'auto') {
      tools = tools.map(t => (FS_WRITE.has(t.name) ? withPermission(t, 'auto') : t));
    }

    // M3-2：外部 MCP server 工具（失败隔离 — 未连上自然缺席；调用错误按工具结果返回）
    tools.push(...(this.deps.mcpTools?.() ?? []));

    tools.push(makeTodoTool()); // 事件经 ctx.emit → loop 注入 agentId
    tools.push(makePastRunsTool(taskStore as any));
    // 记忆自动归档：注入 LLM（平台自治路由 + 超量整理）+ 实体索引（B5）与整理阈值联动
    const memSvc = new MemoryService(platformConfig.memoryDir);
    const memEntity = new MemoryEntityService(platformConfig.memoryDir);
    tools.push(...makeMemoryTools(memSvc, this.deps.llm as any, this.isAutomationSession(sessionId), {
      entity: {
        active: () => memEntity.active(memSvc, this.budgetSettings.effective()),
        indexFile: (name: string) => memEntity.indexFile(memSvc, this.deps.llm as any, name),
        boostMap: () => memEntity.boostMap(),
      },
      // 实体索引生效时放宽整理阈值（检索变强，库可以大）
      getConsolidateMax: () => {
        const eff = this.budgetSettings.effective();
        return memEntity.active(memSvc, eff) ? Math.max(eff.consolidateMaxFiles, 30) : eff.consolidateMaxFiles;
      },
    }));
    tools.push(makeEvidenceReadTool(this.evidence));
    tools.push(makeDualReviewTool({ llm: llmOverride ?? this.deps.llm }));;

    // M1-4：spawn 工具 — 子预算上限为平台默认的 1/2 量级，spawn 限额 run 级共享
    // Teams：run 级协作内核（任务板 + 邮箱 + 名册）；team_* 工具按代理各配副本
    //（selfName 不同 — teammate 的 team_send 落名是自己，主循环是 'main'）
    // 派生预算的基准 = 用户设置的预算（0 = 无上限）：与主循环同一来源，而不是绕过设置直接读平台默认
    const effectiveBudget = this.budgetSettings.effective();
    const nominalSteps = nominalBudgetValue(effectiveBudget.maxSteps, PLATFORM_DEFAULT_BUDGET.steps);
    const nominalTokens = nominalBudgetValue(effectiveBudget.maxTokens, PLATFORM_DEFAULT_BUDGET.tokens);
    // 团队看门狗：与主循环同一语义（≤0 = 不限）
    const team = new TeamService(
      runId,
      ev => this.emitRunEvent(runId, ev.type, ev.payload ?? {}),
      loopBudgetValue(effectiveBudget.maxTokens, platformConfig.runMaxTokens),
    );
    const spawn = makeSpawnTool({
      llm: this.deps.llm,
      summarize: async transcript => this.summarizeTranscript(transcript),
      baseTools: tools,
      evidenceStore: this.evidence,
      presets: this.agentPresets,
      hooks: this.loopHooks,
      // 审查 P2：审批通道透传（与主循环同一 requestApproval — waiting_human 语义一致）
      ...(workspace ? { approveTool: (tool, inp, callId) => this.requestApproval(runId, tool, inp, callId, workspace) } : {}),
      depth: 0,
      spawnCounter: { count: 0 },
      subBudget: {
        defaultSteps: Math.max(3, Math.floor(nominalSteps / 3)),
        defaultTokens: Math.max(5000, Math.floor(nominalTokens / 3)),
        maxSteps: Math.max(5, Math.floor(nominalSteps / 2)),
        maxTokens: Math.max(10000, Math.floor(nominalTokens / 2)),
      },
    });
    const teamSpawn = makeTeamSpawnTool({
      llm: this.deps.llm,
      summarize: async transcript => this.summarizeTranscript(transcript),
      baseTools: tools,
      evidenceStore: this.evidence,
      presets: this.agentPresets,
      hooks: this.loopHooks,
      ...(workspace ? { approveTool: (tool, inp, callId) => this.requestApproval(runId, tool, inp, callId, workspace) } : {}),
      depth: 0,
      team,
      spawnCounter: { count: 0 },
      // REG-25：后台 teammate 挂进 run 级后台作用域 — 主循环结束即终止
      registerBackground: scope => this.registerBackground(runId, scope),
      unregisterBackground: scope => this.unregisterBackground(runId, scope),
      onTeammateSettled: t => {
        const cur = this.teamTokensByRun.get(runId) ?? { in: 0, out: 0 };
        this.teamTokensByRun.set(runId, { in: cur.in + (t.tokensIn || 0), out: cur.out + (t.tokensOut || 0) });
      },
      subBudget: {
        defaultSteps: Math.max(3, Math.floor(nominalSteps / 3)),
        defaultTokens: Math.max(5000, Math.floor(nominalTokens / 3)),
        maxSteps: Math.max(5, Math.floor(nominalSteps / 2)),
        maxTokens: Math.max(10000, Math.floor(nominalTokens / 2)),
      },
    });
    tools.push(spawn);
    tools.push(teamSpawn);
    tools.push(makeTeamSendTool(team, 'main'));
    tools.push(makeTeamTasksTool(team, 'main'));
    tools.push(makeTeamWaitTool(team));
    // 会话经历回溯：跨全部历史 run 的全文检索（FTS5）
    tools.push(makeSessionSearchTool(this.search, this.deps.runStore as any));
    // 反问（ask_user）：**仅主循环持有** — spawn 在上方已捕获当时的 tools 数组，
    // 此处返回新数组使 teammate 不带此工具（其问题由主循环代问，一期决策）
    const askTool = makeAskUserTool({
      ask: payload => this.askUser(runId, payload),
      // 评测会话与无人值守（定时/触发）run：现场没有人 — 不挂起，直接返回"用户不可用"（REG-26）
      automationSession: this.isAutomationSession(sessionId) || unattended,
    });
    return { tools: [...tools, askTool], team };
  }

  // ─── M1-10：审批流（waiting_human → 人工决定 → 恢复）──────────────────

  private pendingApprovals = new Map<string, { runId: string; tool: string; resolve: (v: boolean) => void }>();
  /** 审批选择记忆（会话级 always）：key = workspaceId:toolName，命中即自动放行 */
  private sessionApprovalRules = new Set<string>();

  /** fs 工具的改动预览（diff 卡片数据）；其他工具返回 null */
  private previewDiff(toolName: string, input: any, workspaceDir: string): string | null {
    try {
      if (toolName === 'fs_write') {
        const r = resolveWorkspacePath(workspaceDir, String(input?.path ?? ''));
        if (!r.ok) return null;
        const before = existsSync(r.absPath) ? readFileSync(r.absPath, 'utf-8') : '';
        return unifiedDiff(before, String(input?.content ?? ''), String(input?.path ?? ''));
      }
      if (toolName === 'docx_write') {
        // docx 是二进制 — 无旧文本可 diff，直接展示将写入的正文
        return String(input?.content ?? '') || null;
      }
      if (toolName === 'fs_edit') {
        const r = resolveWorkspacePath(workspaceDir, String(input?.path ?? ''));
        if (!r.ok) return null;
        if (!existsSync(r.absPath)) return null;
        const before = readFileSync(r.absPath, 'utf-8');
        const oldText = String(input?.old_text ?? '');
        const newText = String(input?.new_text ?? '');
        if (!oldText || !before.includes(oldText)) return null;
        // 终审 P2：函数式替换 — new_text 含 $&/$`/$' 时字符串模式会静默改写内容
        const after = input?.replace_all
          ? before.split(oldText).join(newText)
          : before.replace(oldText, () => newText);
        return unifiedDiff(before, after, String(input?.path ?? ''));
      }
    } catch {
      return null;
    }
    return null;
  }

  /** 审批请求：emit tool.approval_required（带 diff 预览）→ 挂起等待 → 状态机 waiting_human。
   *  会话级 always 规则命中时跳过人工（自动放行 + 留痕事件）。 */
  private async requestApproval(
    runId: string,
    tool: Tool,
    input: any,
    callId: string | undefined,
    workspace: Workspace
  ): Promise<boolean> {
    // 审批选择记忆：本服务会话内用户曾对同工作区同工具选过"总是允许" → 直接放行
    const ruleKey = `${workspace.id}:${tool.name}`;
    if (this.sessionApprovalRules.has(ruleKey)) {
      this.emitRunEvent(runId, 'tool.approval_auto', {
        tool: tool.name,
        ...(callId ? { callId } : {}),
        rule: 'session_always',
        workspace: { id: workspace.id, name: workspace.name },
      });
      return true;
    }

    if (this.unattendedRuns.has(runId)) {
      // REG-26：无人值守时审批请求没有人会来回应 — 挂起就是永久悬挂（与反问同一个病根）。
      // fail-closed：按"未获批准"即时落定并留痕；需要写权限的定时任务应使用 auto 档工作区
      const approvalId = nanoid(10);
      this.emitRunEvent(runId, 'tool.approval_resolved', {
        approvalId, approved: false, tool: tool.name, unattended: true,
        ...(callId ? { callId } : {}),
        reason: '无人值守任务：需要人工审批的操作已跳过',
      });
      return false;
    }

    const approvalId = nanoid(10);
    const diff = this.previewDiff(tool.name, input, workspace.dir);

    // P1: 只在 run 非终态时置 waiting_human（防止取消后的审批把状态复活）
    const runNow = this.deps.runStore.get(runId);
    if (runNow && !['completed', 'failed', 'cancelled'].includes(runNow.status)) {
      this.deps.runStore.update(runId, { status: 'waiting_human' });
    }
    this.emitRunEvent(runId, 'tool.approval_required', {
      approvalId,
      tool: tool.name,
      ...(callId ? { callId } : {}),
      input,
      diff,
      workspace: { id: workspace.id, name: workspace.name },
    });

    const approved = await new Promise<boolean>(resolve => {
      this.pendingApprovals.set(approvalId, { runId, tool: tool.name, resolve });
    });

    // 恢复（若已被取消等改写终态则保持终态）
    const run = this.deps.runStore.get(runId);
    if (run?.status === 'waiting_human') {
      this.deps.runStore.update(runId, { status: 'running' });
    }
    this.emitRunEvent(runId, 'tool.approval_resolved', { approvalId, approved, tool: tool.name });
    return approved;
  }

  /** API 调用：解决一个待审批（approved=true 放行 / false 拒绝；
   *  scope='session' 额外记住"本服务会话内同工作区同工具总是允许"） */
  resolveApproval(runId: string, approvalId: string, approved: boolean, scope?: 'once' | 'session'): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.runId !== runId) return false;
    this.pendingApprovals.delete(approvalId);
    if (approved && scope === 'session') {
      const run = this.deps.runStore.get(runId);
      if (run?.workspace_id) this.sessionApprovalRules.add(`${run.workspace_id}:${pending.tool}`);
    }
    pending.resolve(approved);
    return true;
  }

  /** 清空审批选择记忆（用户反悔通道） */
  clearSessionApprovalRules(): number {
    const n = this.sessionApprovalRules.size;
    this.sessionApprovalRules.clear();
    return n;
  }

  /** 某 run 的待审批列表（刷新页面后重取） */
  listPendingApprovals(runId: string): Array<{ approvalId: string; tool: string }> {
    return [...this.pendingApprovals.entries()]
      .filter(([, p]) => p.runId === runId)
      .map(([approvalId, p]) => ({ approvalId, tool: p.tool }));
  }

  private rejectAllApprovals(runId: string): void {
    for (const [approvalId, pending] of [...this.pendingApprovals.entries()]) {
      if (pending.runId === runId) {
        this.pendingApprovals.delete(approvalId);
        pending.resolve(false);
      }
    }
  }

  /** 权限位提升副本（fs_write/fs_edit 在 auto 档直接执行） */
  private withPermissionLocal(t: Tool, permission: ToolPermission): Tool {
    return { ...t, permission };
  }

  /** M1-11：把本次 run 的对话转录交给 LLM 提炼长期记忆（失败不影响 run 终态） */
  private async distillAfterRun(runId: string, messages: Array<{ role: string; content: string }>, sessionId?: string): Promise<void> {
    try {
      const transcript = messages
        .map(m => `[${m.role}] ${m.content}`)
        .join('\n');
      const service = new MemoryService(platformConfig.memoryDir);
      const dataDir = (await import('path')).dirname(platformConfig.databasePath);
      const sessionCtx = sessionId ? new (await import('../services/session-context-service.js')).SessionContextService(dataDir) : undefined;
      const result = await distillMemory(this.deps.llm, service, transcript, sessionCtx, sessionId);
      if (result.longTermWritten.length > 0 || result.sessionFiles.length > 0) {
        this.emitRunEvent(runId, 'memory.distilled', {
          files: result.longTermWritten,
          sessionFiles: result.sessionFiles.length,
        });
      }
    } catch (err: any) {
      console.warn(`[RunEngine] run ${runId} 记忆整理失败（不影响 run）: ${err?.message ?? err}`);
    }
  }

  /** 上下文压缩摘要器（主循环与 sub-agent 共用） */
  private async summarizeTranscript(transcript: string): Promise<string> {
    const { content } = await this.deps.llm.complete(
      [
        { role: 'system', content: 'You compress an agent conversation transcript into a dense factual summary. Keep: facts learned, decisions made, file paths, tool outcomes, open questions. Drop: pleasantries and repetition. Output plain text.' },
        { role: 'user', content: transcript },
      ],
      { temperature: 0.2, maxTokens: 1500 }
    );
    return content;
  }
}

/** M1-10：权限位提升副本（fs_write/fs_edit 在 auto 档直接执行） */
function withPermission(t: Tool, permission: ToolPermission): Tool {
  return { ...t, permission };
}
