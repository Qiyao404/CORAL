import { AgentLoop, type LoopEvent, type LoopCheckpoint } from './agent-loop.js';
import type { ChatRequest, ChatResponse } from '../providers/types.js';
import { RunStore, newRunId, type Run } from '../store/run-store.js';
import { RunEventStore } from '../store/run-event-store.js';
import { CheckpointStore } from '../store/checkpoint-store.js';
import { eventBus } from '../event/event-bus.js';
import { createAbortController, abortTask, releaseAbortController } from '../services/task-abort-registry.js';
import { platformConfig } from '../services/config.js';
import { createDefaultToolRegistry } from '../tools/registry.js';
import { makeTodoTool } from '../tools/builtin/todo.js';
import { makePastRunsTool } from '../tools/builtin/past-runs.js';
import { makeSpawnTool } from '../tools/builtin/spawn.js';
import { makeMemoryTools, MEMORY_GUIDE } from '../tools/builtin/memory.js';
import { makeEvidenceReadTool } from '../tools/builtin/evidence.js';
import { makeDualReviewTool } from '../tools/builtin/dual-review.js';
import { EvidenceStore } from './evidence.js';
import { MemoryService, distillMemory } from '../services/memory-service.js';
import { HabitService } from '../services/habit-service.js';
import { AgentPresetService } from '../services/agent-presets.js';
import { SlashCommandService } from '../services/slash-commands.js';
import { isEstopped, estopReason } from '../services/estop.js';
import { HookService, type HookEvent } from '../hooks/hook-service.js';
import { RunBudgetSettingsService } from '../services/run-budget-settings.js';
import { evaluateDeterministic } from './self-eval.js';
import { WorkspaceService, type Workspace } from '../services/workspace-service.js';
import { fsSearchTool } from '../tools/builtin/fs-search.js';
import { docxTools } from '../tools/builtin/docx.js';
import { unifiedDiff } from '../tools/diff.js';
import { resolveWorkspacePath } from '../tools/workspace-path.js';
import { readFileSync, existsSync } from 'fs';
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
  const n = v ?? fallback;
  return n <= 0 ? Infinity : n;
}

export class RunEngine {
  private deps: RunEngineDeps;
  /** 证据记录层：超预算工具结果的不可变存档（data/evidence/{runId}/） */
  private evidence = new EvidenceStore(pathDirname(platformConfig.databasePath));
  /** 习惯学习管线：观察 → 蒸馏 → 置信度 → 晋升技能（data/habits/） */
  private habits = new HabitService(pathDirname(platformConfig.databasePath));
  /** 具名子代理预设（data/agents/*.md — description 注入主提示，正文按名加载） */
  private agentPresets = new AgentPresetService(pathDirname(platformConfig.databasePath));
  /** 斜杠命令（data/commands/*.md — 用户快捷指令，goal 以 "/" 开头时展开） */
  private slashCommands = new SlashCommandService(pathDirname(platformConfig.databasePath));
  /** 外部命令守卫（data/hooks.json — 8 生命周期事件，可拒/可改/可补） */
  private hookSvc = new HookService(pathDirname(platformConfig.databasePath));
  /** 运行预算用户设置（data/run-budget.json — 设置页可改，优先于平台默认） */
  private budgetSettings = new RunBudgetSettingsService(pathDirname(platformConfig.databasePath));

  /** hooks 的 loop 注入形态（结构化包装 — kernel 不 import 具体服务） */
  private loopHooks = {
    run: (event: string, payload: Record<string, any>) => this.hookSvc.run(event as HookEvent, payload),
  };
  /** runId → 会话/目标（习惯观察的上下文标注） */
  private runMeta = new Map<string, { sessionId: string; goal: string }>();
  /** callId → 工具输入预览（观察在 call_completed 时落笔，需要 started 的输入） */
  private pendingObs = new Map<string, { tool: string; inputPreview: string; agentId: string }>();

  constructor(deps: RunEngineDeps) {
    this.deps = deps;
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

  /** 习惯学习管线（API 路由用：列表/蒸馏/晋升/纠偏） */
  get habitService(): HabitService {
    return this.habits;
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
    });

    const controller = createAbortController(runId);
    // 异步执行（与 v1 executeTask 同风格：调用方立即拿到 runId）
    void this.executeRun(runId, input, workspace, controller.signal).catch(err => {
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
    const deleted = this.deps.runStore.delete(runId);
    return { ok: deleted, message: deleted ? '已删除' : '删除失败' };
  }

  /** 删除整个会话（含全部 run） */
  deleteSession(sessionId: string): number {
    const { items } = this.deps.runStore.list({ sessionId, limit: 200 });
    for (const run of items) {
      if (['running', 'waiting_human'].includes(run.status)) {
        this.cancelRun(run.id);
      }
      this.rejectAllApprovals(run.id); // 挂起审批一并落定（防悬挂）
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

      const run = this.deps.runStore.get(runId)!;
      const budget = (run.budget ?? {}) as { maxSteps?: number; maxTokens?: number };

      const tools = this.buildTools(runId, workspace);
      const loop = new AgentLoop(this.deps.llm, {
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
        // D18：记忆使用指引常驻系统提示；调用方的 extraSystem 追加在后
        // D18 记忆指引 + 个人画像（越聊越懂用户）+ 协作习惯 + 具名子代理目录 + 调用方 extraSystem
        extraSystem: [
          MEMORY_GUIDE,
          (await import('../services/user-profile-service.js')).userProfileToPrompt(
            (await import('../services/user-profile-service.js')).getUserProfile()
          ),
          this.habits.toPromptText(),
          this.agentPresets.toPromptText(),
          input.extraSystem,
        ].filter(Boolean).join('\n\n'),
        onEvent: e => this.onLoopEvent(runId, e),
        saveCheckpoint: cp => this.saveCheckpoint(runId, cp),
        evidenceStore: this.evidence,
        hooks: this.loopHooks,
        // M1-10：工作区存在时启用审批流（ask/auto 的 approval 工具 + shell）
        approveTool: workspace
          ? (tool, inp, callId) => this.requestApproval(runId, tool, inp, callId, workspace)
          : undefined,
        summarize: async transcript => this.summarizeTranscript(transcript),
      });

      const result = await loop.run();
      if (signal.aborted) {
        this.markCancelled(runId);
        return;
      }

      const status = result.status === 'completed' || result.status === 'budget_exceeded' ? 'completed' : result.status;
      this.deps.runStore.update(runId, {
        status,
        endReason: result.status === 'budget_exceeded' ? 'budget_exceeded'
          : result.status === 'completed' ? 'final_answer'
          : result.status,
        finalContent: result.finalContent,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        ...(result.status === 'failed' ? { error: { message: result.error } } : {}),
      });

      if (result.status === 'budget_exceeded') {
        this.emitRunEvent(runId, 'run.budget_exceeded', { steps: result.steps, tokensIn: result.tokensIn, tokensOut: result.tokensOut });
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
        result.status === 'failed' ? 'run.failed' : 'run.completed',
        result.status === 'failed'
          ? { error: result.error }
          : { finalContentPreview: result.finalContent.slice(0, 500), steps: result.steps, toolCalls: result.toolCalls, tokensIn: result.tokensIn, tokensOut: result.tokensOut }
      );

      // M1-11（D18）：会话结束记忆整理 — 仅正常完成时；demo 模式与开关关闭时跳过
      if (result.status === 'completed' && platformConfig.memoryDistillEnabled && !(this.deps.llm as any).isDemoMode?.()) {
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
      this.deps.runStore.update(runId, { status: 'failed', error: { message: err?.message ?? String(err) }, endReason: 'failed' });
      this.emitRunEvent(runId, 'run.failed', { error: err?.message ?? String(err) });
    } finally {
      this.releaseSeq(runId);
      this.runMeta.delete(runId);
      this.pendingObs.clear();
      this.rejectAllApprovals(runId); // 挂起的审批随 run 结束一并落定（防泄漏/悬挂）
      releaseAbortController(runId);
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
    this.bridgeToHooks(runId, e.type, payload as any);
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
  private buildTools(runId: string, workspace: Workspace | null): Tool[] {
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
    tools.push(...makeMemoryTools(new MemoryService(platformConfig.memoryDir)));
    tools.push(makeEvidenceReadTool(this.evidence));
    tools.push(makeDualReviewTool({ llm: this.deps.llm }));

    // M1-4：spawn 工具 — 子预算上限为平台默认的 1/2 量级，spawn 限额 run 级共享
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
        defaultSteps: Math.max(3, Math.floor(platformConfig.runMaxSteps / 3)),
        defaultTokens: Math.max(5000, Math.floor(platformConfig.runMaxTokens / 3)),
        maxSteps: Math.max(5, Math.floor(platformConfig.runMaxSteps / 2)),
        maxTokens: Math.max(10000, Math.floor(platformConfig.runMaxTokens / 2)),
      },
    });
    tools.push(spawn);
    return tools;
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
