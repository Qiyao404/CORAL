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
import type { Tool } from '../tools/types.js';
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
  budget?: RunBudgetInput;
  workspaceDir?: string;
  extraSystem?: string;
}

export interface RunEngineDeps {
  llm: {
    chat(req: ChatRequest): Promise<ChatResponse>;
    complete(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, options?: any): Promise<{ content: string }>;
  };
  skillRegistry: FilesystemSkillRegistry;
  skillExecutor: SkillExecutor;
  runStore: RunStore;
  eventStore: RunEventStore;
  checkpointStore: CheckpointStore;
}

const GOAL_LIMIT = 10_000;
const MAX_STEPS_CAP = 200;
const MAX_TOKENS_CAP = 2_000_000;

export class RunEngine {
  private deps: RunEngineDeps;

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

  /** 创建并异步执行一个 Free 模式 run */
  startRun(input: StartRunInput): { runId: string; sessionId?: string } {
    const goal = String(input.goal ?? '').trim();
    if (!goal) throw new Error('缺少 goal');
    if (goal.length > GOAL_LIMIT) {
      throw new Error(`goal 过长（${goal.length} 字符，上限 ${GOAL_LIMIT}）`);
    }
    const sessionId = input.sessionId ? String(input.sessionId).slice(0, 64) : undefined;

    const budget = {
      maxSteps: Math.min(Math.max(input.budget?.maxSteps ?? platformConfig.runMaxSteps, 1), MAX_STEPS_CAP),
      maxTokens: Math.min(Math.max(input.budget?.maxTokens ?? platformConfig.runMaxTokens, 1000), MAX_TOKENS_CAP),
      ...(input.budget?.maxCostUsd !== undefined ? { maxCostUsd: input.budget.maxCostUsd } : {}),
    };

    const runId = newRunId();
    this.deps.runStore.insert({ id: runId, goal, mode: 'free', sessionId, budget });
    this.emitRunEvent(runId, 'run.created', { goal, sessionId, budget });

    const controller = createAbortController(runId);
    // 异步执行（与 v1 executeTask 同风格：调用方立即拿到 runId）
    void this.executeRun(runId, input, controller.signal).catch(err => {
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
    this.deps.runStore.update(runId, { status: 'cancelled', endReason: 'cancelled' });
    this.emitRunEvent(runId, 'run.cancelled', { reason: 'user_cancelled' });
    return { ok: true, message: 'run 已取消' };
  }

  getRunDetail(runId: string): { run: Run; events: any[]; checkpoints: any[] } | null {
    const run = this.deps.runStore.get(runId);
    if (!run) return null;
    return {
      run,
      events: this.deps.eventStore.listByRun(runId, 0, 2000),
      checkpoints: this.deps.checkpointStore.listByRun(runId),
    };
  }

  // ─── 内部 ────────────────────────────────────────────────

  private async executeRun(runId: string, input: StartRunInput, signal: AbortSignal): Promise<void> {
    try {
      this.deps.runStore.update(runId, { status: 'running' });
      this.emitRunEvent(runId, 'run.started', {});

      const run = this.deps.runStore.get(runId)!;
      const budget = (run.budget ?? {}) as { maxSteps?: number; maxTokens?: number };

      const tools = this.buildTools(runId);
      const loop = new AgentLoop(this.deps.llm, {
        runId,
        agentId: 'main',
        goal: input.goal,
        tools,
        budget: {
          maxSteps: budget.maxSteps ?? platformConfig.runMaxSteps,
          maxTokens: budget.maxTokens ?? platformConfig.runMaxTokens,
        },
        signal,
        workspaceDir: input.workspaceDir,
        extraSystem: input.extraSystem,
        onEvent: e => this.onLoopEvent(runId, e),
        saveCheckpoint: cp => this.saveCheckpoint(runId, cp),
        summarize: async transcript => {
          const { content } = await this.deps.llm.complete(
            [
              { role: 'system', content: 'You compress an agent conversation transcript into a dense factual summary. Keep: facts learned, decisions made, file paths, tool outcomes, open questions. Drop: pleasantries and repetition. Output plain text.' },
              { role: 'user', content: transcript },
            ],
            { temperature: 0.2, maxTokens: 1500 }
          );
          return content;
        },
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
      this.emitRunEvent(
        runId,
        result.status === 'failed' ? 'run.failed' : 'run.completed',
        result.status === 'failed'
          ? { error: result.error }
          : { finalContentPreview: result.finalContent.slice(0, 500), steps: result.steps, toolCalls: result.toolCalls, tokensIn: result.tokensIn, tokensOut: result.tokensOut }
      );
    } catch (err: any) {
      if (signal.aborted) {
        this.markCancelled(runId);
        return;
      }
      this.deps.runStore.update(runId, { status: 'failed', error: { message: err?.message ?? String(err) }, endReason: 'failed' });
      this.emitRunEvent(runId, 'run.failed', { error: err?.message ?? String(err) });
    } finally {
      this.releaseSeq(runId);
      releaseAbortController(runId);
    }
  }

  private markCancelled(runId: string): void {
    const run = this.deps.runStore.get(runId);
    if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) return;
    this.deps.runStore.update(runId, { status: 'cancelled', endReason: 'cancelled' });
    // 事件由 cancelRun API 统一发出；此处不重复
  }

  /** loop 事件 → events 表 + eventBus（双写） */
  private onLoopEvent(runId: string, e: LoopEvent): void {
    const payload = { runId, ...(e.payload ?? {}) };
    const toolName = typeof (payload as any).tool === 'string' ? (payload as any).tool : undefined;
    const stored = this.deps.eventStore.insert({
      runId,
      seq: this.nextSeq(runId),
      type: e.type,
      agentId: 'main',
      toolName,
      payload,
    });
    this.bridgeToBus(stored);
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
    const next = (this.seqCounters.get(runId) ?? 0) + 1;
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

  /** 工具集：默认 registry（内置+技能）+ D19 两工具；每次 run 现建（技能热重载天然生效）。
   *  注意：todo_write 的 emit 是构造时注入的闭包（不走 ctx.emit），必须显式路由到本 run 的事件流 */
  private buildTools(runId: string): Tool[] {
    const registry = createDefaultToolRegistry({
      skillRegistry: this.deps.skillRegistry,
      skillExecutor: this.deps.skillExecutor,
      enableShell: platformConfig.shellToolEnabled,
    });
    const tools = registry.list();
    tools.push(makeTodoTool(ev => this.onLoopEvent(runId, { type: ev.type, payload: ev.payload })));
    tools.push(makePastRunsTool(taskStore as any));
    return tools;
  }
}
