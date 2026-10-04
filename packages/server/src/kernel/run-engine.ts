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
import { MemoryService, distillMemory } from '../services/memory-service.js';
import { WorkspaceService, type Workspace } from '../services/workspace-service.js';
import { fsSearchTool } from '../tools/builtin/fs-search.js';
import { docxTools } from '../tools/builtin/docx.js';
import { unifiedDiff } from '../tools/diff.js';
import { resolveWorkspacePath } from '../tools/workspace-path.js';
import { readFileSync, existsSync } from 'fs';
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

    // M1-10：解析工作区（不传 = 无 fs/shell 工具；传了不存在 = 报错）
    let workspace: Workspace | null = null;
    if (input.workspaceId) {
      workspace = new WorkspaceService().get(input.workspaceId);
      if (!workspace) throw new Error(`工作区不存在: ${input.workspaceId}`);
    }

    const budget = {
      maxSteps: Math.min(Math.max(input.budget?.maxSteps ?? platformConfig.runMaxSteps, 1), MAX_STEPS_CAP),
      maxTokens: Math.min(Math.max(input.budget?.maxTokens ?? platformConfig.runMaxTokens, 1000), MAX_TOKENS_CAP),
      ...(input.budget?.maxCostUsd !== undefined ? { maxCostUsd: input.budget.maxCostUsd } : {}),
    };

    const runId = newRunId();
    this.deps.runStore.insert({ id: runId, goal, mode: 'free', sessionId, budget });
    this.emitRunEvent(runId, 'run.created', {
      goal,
      sessionId,
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

  /** 删除 run（运行中先取消；事件/检查点级联清除） */
  deleteRun(runId: string): { ok: boolean; message: string } {
    const run = this.deps.runStore.get(runId);
    if (!run) return { ok: false, message: 'run 不存在' };
    if (['running', 'waiting_human'].includes(run.status)) {
      this.cancelRun(runId); // 先中止，避免悬挂的 loop 往已删除的 run 写事件
    }
    this.rejectAllApprovals(runId);
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
      events: this.deps.eventStore.listByRun(runId, 0, 2000),
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
    const out = [...messages];
    const last = out[out.length - 1];
    if (last?.role === 'tool') {
      // 孤儿 tool 结果（前一条不是带其 toolCallId 的 assistant）→ 连同前面的组一起修剪
      const prev = out[out.length - 2];
      if (!(prev?.role === 'assistant' && (prev.toolCalls ?? []).some(c => c.id === (last as any).toolCallId))) {
        out.pop();
        return this.sanitizeSessionHistory(out);
      }
      return out;
    }
    if (last?.role === 'assistant' && last.toolCalls?.length) {
      // 悬空 assistant(toolCalls)（无任何对应 tool 结果）→ 移除
      return this.sanitizeSessionHistory(out.slice(0, -1));
    }
    return out;
  }

  private async executeRun(runId: string, input: StartRunInput, workspace: Workspace | null, signal: AbortSignal): Promise<void> {
    try {
      // 多轮续接：同会话上一轮的完整对话（checkpoint 事件溯源回放）
      let initialHistory: import('../providers/types.js').ChatMessage[] | undefined;
      let continuedFrom: string | undefined;
      if (input.continueSession && input.sessionId) {
        const prev = this.loadSessionHistory(input.sessionId);
        if (prev) {
          initialHistory = prev.history;
          continuedFrom = prev.fromRunId;
        }
      }

      this.deps.runStore.update(runId, { status: 'running' });
      this.emitRunEvent(runId, 'run.started', continuedFrom ? { continuedFrom } : {});

      const run = this.deps.runStore.get(runId)!;
      const budget = (run.budget ?? {}) as { maxSteps?: number; maxTokens?: number };

      const tools = this.buildTools(runId, workspace);
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
        workspaceDir: workspace?.dir,
        initialHistory,
        // D18：记忆使用指引常驻系统提示；调用方的 extraSystem 追加在后
        extraSystem: input.extraSystem ? `${MEMORY_GUIDE}\n\n${input.extraSystem}` : MEMORY_GUIDE,
        onEvent: e => this.onLoopEvent(runId, e),
        saveCheckpoint: cp => this.saveCheckpoint(runId, cp),
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
      this.emitRunEvent(
        runId,
        result.status === 'failed' ? 'run.failed' : 'run.completed',
        result.status === 'failed'
          ? { error: result.error }
          : { finalContentPreview: result.finalContent.slice(0, 500), steps: result.steps, toolCalls: result.toolCalls, tokensIn: result.tokensIn, tokensOut: result.tokensOut }
      );

      // M1-11（D18）：会话结束记忆整理 — 仅正常完成时；demo 模式与开关关闭时跳过
      if (result.status === 'completed' && platformConfig.memoryDistillEnabled && !(this.deps.llm as any).isDemoMode?.()) {
        await this.distillAfterRun(runId, result.messages);
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

  /** loop 事件 → events 表 + eventBus（双写）；agentId 区分主循环/sub-agent（M1-4） */
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

    // M1-4：spawn 工具 — 子预算上限为平台默认的 1/2 量级，spawn 限额 run 级共享
    const spawn = makeSpawnTool({
      llm: this.deps.llm,
      summarize: async transcript => this.summarizeTranscript(transcript),
      baseTools: tools,
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
        const after = input?.replace_all
          ? before.split(oldText).join(newText)
          : before.replace(oldText, newText);
        return unifiedDiff(before, after, String(input?.path ?? ''));
      }
    } catch {
      return null;
    }
    return null;
  }

  /** 审批请求：emit tool.approval_required（带 diff 预览）→ 挂起等待 → 状态机 waiting_human */
  private async requestApproval(
    runId: string,
    tool: Tool,
    input: any,
    callId: string | undefined,
    workspace: Workspace
  ): Promise<boolean> {
    const approvalId = nanoid(10);
    const diff = this.previewDiff(tool.name, input, workspace.dir);

    this.deps.runStore.update(runId, { status: 'waiting_human' });
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

  /** API 调用：解决一个待审批（approved=true 放行 / false 拒绝） */
  resolveApproval(runId: string, approvalId: string, approved: boolean): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.runId !== runId) return false;
    this.pendingApprovals.delete(approvalId);
    pending.resolve(approved);
    return true;
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
  private async distillAfterRun(runId: string, messages: Array<{ role: string; content: string }>): Promise<void> {
    try {
      const transcript = messages
        .map(m => `[${m.role}] ${m.content}`)
        .join('\n');
      const service = new MemoryService(platformConfig.memoryDir);
      const written = await distillMemory(this.deps.llm, service, transcript);
      if (written.length > 0) {
        this.emitRunEvent(runId, 'memory.distilled', {
          files: written,
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
