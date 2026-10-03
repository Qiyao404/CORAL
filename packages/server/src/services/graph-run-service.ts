import { GraphEngine, type GraphRunState, type GraphNodeDefinition } from '../kernel/graph/graph-engine.js';
import { validateGraph, type GraphDefinition } from '../kernel/graph/dsl.js';
import { RunStore, newRunId, type Run } from '../store/run-store.js';
import { RunEventStore } from '../store/run-event-store.js';
import { CheckpointStore } from '../store/checkpoint-store.js';
import { eventBus } from '../event/event-bus.js';
import { createAbortController, abortTask, releaseAbortController } from './task-abort-registry.js';
import type { SkillExecutor } from '../skill-runtime/skill-executor.js';
import type { FilesystemSkillRegistry } from '../skill-runtime/filesystem-registry.js';
import { WorkspaceService, type Workspace } from './workspace-service.js';
import { nanoid } from 'nanoid';

/**
 * M2-4/M2-5：GraphRunService — GraphEngine 与真实世界的接线（对位 RunEngine 的 Free 模式）：
 *  · runs 表（mode=graph，graph_json 存 DSL）/ events 双写 / 节点级 checkpoint（vars.graphState）
 *  · 节点级审批（waiting_human）：审批中心可跨 run 列出、通过/拒绝/**改参数后继续**
 *  · resume：服务重启后 running/interrupted 的 graph run 从最近 checkpoint 续跑
 *    （已完成节点产出直接复用，未完成节点重跑 — DoD：kill 进程 → 重启 → 一键 resume 跑完）
 */

export interface StartGraphRunInput {
  goal: string;
  graph: GraphDefinition;
  input?: Record<string, any>;
  sessionId?: string;
  /** M2 实测：绑定工作区 — 技能产物落工作区目录（CORAL_OUTPUT_DIR），resume 重新解析 */
  workspaceId?: string;
}

export interface GraphRunServiceDeps {
  skillExecutor: SkillExecutor;
  /** M2 实测补：节点执行前按 manifest input_schema 做类型守卫（快失败 + 可读错误） */
  skillRegistry?: FilesystemSkillRegistry;
  runStore: RunStore;
  eventStore: RunEventStore;
  checkpointStore: CheckpointStore;
}

const SCALAR_TYPES: Record<string, string> = {
  string: 'string',
  number: 'number',
  integer: 'number',
  boolean: 'boolean',
};

/** 轻量类型守卫：节点输入 vs 技能 input_schema 的顶层字段类型（不引 ajv，报错可操作） */
function checkInputTypes(
  skillName: string,
  input: Record<string, any>,
  schema?: Record<string, any>
): string | null {
  const props = schema?.properties;
  if (!props || typeof props !== 'object') return null;
  for (const [field, def] of Object.entries(props) as Array<[string, any]>) {
    const expected = SCALAR_TYPES[typeof def?.type === 'string' ? def.type : ''];
    const value = input?.[field];
    if (!expected || value === undefined || value === null) continue;
    if (def.nullable === true && value === null) continue;
    if (typeof value !== expected) {
      const hint = expected === 'string' && Array.isArray(value)
        ? '（引用数组请取具体元素，如 ${{ nodes.x.outputs.list.0 }}）'
        : expected === 'string' && typeof value === 'object'
          ? '（input 默认值写成了 JSON Schema？input 应是具体值）'
          : '';
      return `节点输入字段 "${field}" 类型不匹配：技能 ${skillName} 要求 ${def.type}，实际收到 ${Array.isArray(value) ? 'array' : typeof value} ${hint}`;
    }
  }
  return null;
}

interface PendingNodeApproval {
  runId: string;
  nodeId: string;
  skill: string;
  /** 挂起时的节点输入（审批中心展示/改参数基准） */
  input: Record<string, any>;
  /** run 目标（审批中心上下文） */
  goal: string;
  resolve: (v: { approved: boolean; input?: Record<string, any> }) => void;
}

const GRAPH_RUN_ACTIVE = new Set(['created', 'running', 'waiting_human']);

export class GraphRunService {
  private deps: GraphRunServiceDeps;
  /** runId → 活跃引擎（resume/取消路由用） */
  private engines = new Map<string, GraphEngine>();
  private pendingApprovals = new Map<string, PendingNodeApproval>();
  private seqCounters = new Map<string, number>();

  constructor(deps: GraphRunServiceDeps) {
    this.deps = deps;
  }

  // ─── 启动 / 恢复 ─────────────────────────────────────────

  startGraphRun(input: StartGraphRunInput): { runId: string; sessionId?: string } {
    const goal = String(input.goal ?? '').trim();
    if (!goal) throw new Error('缺少 goal');
    const v = validateGraph(input.graph);
    if (!v.ok) throw new Error(`graph 校验失败: ${v.issues.map(i => i.message).join('; ')}`);

    const runId = newRunId();
    const sessionId = input.sessionId ? String(input.sessionId).slice(0, 64) : undefined;
    let workspace: Workspace | null = null;
    if (input.workspaceId) {
      workspace = new WorkspaceService().get(input.workspaceId);
      if (!workspace) throw new Error(`工作区不存在: ${input.workspaceId}`);
    }
    this.deps.runStore.insert({
      id: runId,
      goal,
      mode: 'graph',
      sessionId,
      graph: input.graph,
      ...(workspace ? { workspaceId: workspace.id } : {}),
    });
    this.emitRunEvent(runId, 'run.created', {
      goal,
      sessionId,
      mode: 'graph',
      graph: { name: input.graph.name, nodes: input.graph.nodes.length },
      ...(workspace ? { workspace: { id: workspace.id, name: workspace.name } } : {}),
    });
    void this.executeGraphRun(runId, input, workspace).catch(err => {
      console.error(`[GraphRunService] run ${runId} 执行异常:`, err);
    });
    return { runId, sessionId };
  }

  /** 服务重启后恢复入口：校验 run 可恢复 → 从最近 checkpoint 续跑 */
  resumeGraphRun(runId: string): { ok: boolean; message: string } {
    const run = this.deps.runStore.get(runId);
    if (!run) return { ok: false, message: 'run 不存在' };
    if (run.mode !== 'graph') return { ok: false, message: '仅 graph 模式 run 支持 resume' };
    if (this.engines.has(runId)) return { ok: false, message: 'run 正在执行中' };
    if (run.status === 'running' && run.end_reason === 'process_restarted') {
      // 重启后标记的中断 run → 允许恢复
    } else if (!GRAPH_RUN_ACTIVE.has(run.status)) {
      return { ok: false, message: `run 已处于终态（${run.status}）` };
    }

    const graph = (run.graph ?? null) as GraphDefinition | null;
    if (!graph) return { ok: false, message: 'run 缺少 graph 定义（无法恢复）' };

    // 最近一次 graph_state checkpoint → 恢复快照
    const cps = this.deps.checkpointStore.listByRun(runId);
    let resumeFrom: GraphRunState | undefined;
    for (let i = cps.length - 1; i >= 0; i--) {
      const st = this.deps.checkpointStore.get(runId, cps[i].seq);
      const gs = (st?.vars as any)?.graphState as GraphRunState | undefined;
      if (gs && gs.nodes) {
        resumeFrom = gs;
        break;
      }
    }

    // M2：resume 时重新解析工作区（产物目录随绑定走）
    const resumeWs = run.workspace_id ? new WorkspaceService().get(run.workspace_id) : null;
    this.deps.runStore.update(runId, { status: 'running', endReason: null });
    this.emitRunEvent(runId, 'run.resumed', {
      fromCheckpoint: Boolean(resumeFrom),
      completedNodes: resumeFrom
        ? Object.values(resumeFrom.nodes).filter(n => n.status === 'completed').length
        : 0,
    });
    void this.executeGraphRun(runId, { goal: run.goal, graph, resumeFrom }, resumeWs).catch(err => {
      console.error(`[GraphRunService] run ${runId} 恢复执行异常:`, err);
    });
    return { ok: true, message: resumeFrom ? '已从最近 checkpoint 恢复' : '已重新开始执行' };
  }

  /** 启动期扫描：把"看起来还在跑"的 graph run 标记为 interrupted（进程重启的诚实化） */
  markInterruptedGraphRuns(): number {
    const { items } = this.deps.runStore.list({ mode: 'graph', limit: 200 });
    let n = 0;
    for (const run of items) {
      if (GRAPH_RUN_ACTIVE.has(run.status)) {
        // 002 惯例：超出 status CHECK 词表的状态用 end_reason 表达（同 budget_exceeded）
        this.deps.runStore.update(run.id, { endReason: 'process_restarted' });
        this.emitRunEvent(run.id, 'run.interrupted', { reason: 'process_restarted' });
        n++;
      }
    }
    return n;
  }

  /** 可恢复列表（Workflow 页提示） */
  listResumable(): Array<{ runId: string; goal: string; status: string; createdAt: string }> {
    const { items } = this.deps.runStore.list({ mode: 'graph', limit: 50 });
    return items
      .filter(r => GRAPH_RUN_ACTIVE.has(r.status) && r.end_reason === 'process_restarted')
      .map(r => ({ runId: r.id, goal: r.goal, status: r.status, createdAt: r.created_at }));
  }

  cancelGraphRun(runId: string): { ok: boolean; message: string } {
    const run = this.deps.runStore.get(runId);
    if (!run) return { ok: false, message: 'run 不存在' };
    if (!GRAPH_RUN_ACTIVE.has(run.status) && run.end_reason !== 'process_restarted') {
      return { ok: true, message: `run 已处于终态（${run.status}）` };
    }
    abortTask(runId);
    this.rejectAllApprovals(runId, 'run 已取消');
    this.engines.get(runId)?.abortRunningNodes();
    this.deps.runStore.update(runId, { status: 'cancelled', endReason: 'cancelled' });
    this.emitRunEvent(runId, 'run.cancelled', { reason: 'user_cancelled' });
    return { ok: true, message: 'run 已取消' };
  }

  // ─── 审批中心（M2-4：跨 run 待审批列表 + 改参数续跑）─────────────

  listAllPendingApprovals(): Array<{
    runId: string;
    approvalId: string;
    node: string;
    skill: string;
    input: Record<string, any>;
    goal: string;
  }> {
    return [...this.pendingApprovals.entries()].map(([approvalId, p]) => ({
      runId: p.runId,
      approvalId,
      node: p.nodeId,
      skill: p.skill,
      input: p.input,
      goal: p.goal,
    }));
  }

  /** 通过/拒绝；通过时可携带修改后的 input（改参数后继续） */
  resolveApproval(
    runId: string,
    approvalId: string,
    approved: boolean,
    input?: Record<string, any>
  ): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.runId !== runId) return false;
    this.pendingApprovals.delete(approvalId);
    pending.resolve(approved ? { approved: true, input } : { approved: false });
    return true;
  }

  // ─── 内部：引擎生命周期 ──────────────────────────────────

  private async executeGraphRun(
    runId: string,
    input: StartGraphRunInput & { resumeFrom?: GraphRunState },
    workspace: Workspace | null = null
  ): Promise<void> {
    const controller = createAbortController(runId);
    try {
      this.deps.runStore.update(runId, { status: 'running' });
      this.emitRunEvent(runId, 'run.started', input.resumeFrom ? { resumed: true } : {});

      const engine = new GraphEngine({
        runId,
        graph: input.graph,
        input: input.input,
        signal: controller.signal,
        resumeFrom: input.resumeFrom,
        executor: {
          execute: async (def, nodeInput, ctx) => {
            // 类型守卫：模板展开后的输入 vs 技能 schema（快失败，替代脚本里 "[object Object]"）
            if (this.deps.skillRegistry) {
              const manifest = this.deps.skillRegistry.getByName(def.skill);
              const typeError = manifest ? checkInputTypes(def.skill, nodeInput, manifest.inputSchema as any) : null;
              if (typeError) {
                return { ok: false, error: { message: typeError, retryable: false } };
              }
            }
            const r = await this.deps.skillExecutor.execute({
              skillName: def.skill,
              input: nodeInput,
              context: {
                taskId: runId,
                agentId: `graph:${def.id}`,
                abortSignal: ctx.signal,
                // 绑定工作区 → 文件型技能产物落这里（CORAL_OUTPUT_DIR）
                ...(workspace ? { outputDir: workspace.dir } : {}),
              },
            });
            return {
              ok: r.success,
              outputs: r.data,
              empty: r.data?.empty === true,
              error: r.error ? { message: r.error.message, retryable: r.error.retryable } : undefined,
            };
          },
        },
        onEvent: e => this.onGraphEvent(runId, e.type, e.payload ?? {}),
        onCheckpoint: (seq, state) => {
          this.deps.checkpointStore.insert({
            runId,
            seq,
            kind: 'graph_node', // 001 迁移预留的 kind（全图状态快照，按节点迁移逐次写入）
            label: `graph-${seq}`,
            state: { vars: { graphState: state } } as any,
          });
        },
        approveNode: (def, nodeInput) => this.requestNodeApproval(runId, def, nodeInput, controller.signal),
      });
      this.engines.set(runId, engine);

      const result = await engine.run();
      const status = result.status; // completed | failed | cancelled
      this.deps.runStore.update(runId, {
        status,
        endReason: status,
        finalContent:
          status === 'completed'
            ? this.summarizeCompletion(result.state)
            : status === 'failed'
              ? `graph 执行失败: ${result.error ?? ''}`
              : undefined,
      });
      this.emitRunEvent(runId, `run.${status}`, {
        ...(status === 'failed' ? { error: result.error } : {}),
        nodeSummary: this.nodeSummary(result.state),
      });
    } catch (err: any) {
      this.deps.runStore.update(runId, { status: 'failed', error: { message: err?.message ?? String(err) }, endReason: 'failed' });
      this.emitRunEvent(runId, 'run.failed', { error: err?.message ?? String(err) });
    } finally {
      this.engines.delete(runId);
      this.rejectAllApprovals(runId, 'run 已结束');
      this.releaseSeq(runId);
      releaseAbortController(runId);
    }
  }

  /** 节点级审批：waiting_human + 事件（含 input 供改参数）→ 挂起等待 */
  private async requestNodeApproval(
    runId: string,
    def: GraphNodeDefinition,
    input: Record<string, any>,
    signal: AbortSignal
  ): Promise<{ approved: boolean; input?: Record<string, any> }> {
    const approvalId = nanoid(10);
    const run = this.deps.runStore.get(runId);
    this.deps.runStore.update(runId, { status: 'waiting_human' });
    this.emitRunEvent(runId, 'node.approval_required', {
      approvalId,
      node: def.id,
      skill: def.skill,
      input,
    });

    return await new Promise(resolve => {
      this.pendingApprovals.set(approvalId, {
        runId,
        nodeId: def.id,
        skill: def.skill,
        input,
        goal: run?.goal ?? '',
        resolve: v => {
          const run = this.deps.runStore.get(runId);
          if (run?.status === 'waiting_human') {
            this.deps.runStore.update(runId, { status: 'running' });
          }
          this.emitRunEvent(runId, 'node.approval_resolved', {
            approvalId,
            node: def.id,
            approved: v.approved,
            ...(v.input ? { modifiedInput: true } : {}),
          });
          resolve(v);
        },
      });
      // 取消时未决的审批直接拒绝（防悬挂）
      signal.addEventListener('abort', () => {
        if (this.pendingApprovals.has(approvalId)) {
          this.pendingApprovals.delete(approvalId);
          resolve({ approved: false });
        }
      }, { once: true });
    });
  }

  private rejectAllApprovals(runId: string, reason: string): void {
    for (const [approvalId, p] of [...this.pendingApprovals.entries()]) {
      if (p.runId === runId) {
        this.pendingApprovals.delete(approvalId);
        this.emitRunEvent(runId, 'node.approval_resolved', {
          approvalId,
          node: p.nodeId,
          approved: false,
          reason,
        });
        p.resolve({ approved: false });
      }
    }
  }

  // ─── 事件/序列化辅助（与 RunEngine 同款双写）─────────────────

  private onGraphEvent(runId: string, type: string, payload: Record<string, any>): void {
    const stored = this.deps.eventStore.insert({
      runId,
      seq: this.nextSeq(runId),
      type,
      agentId: typeof payload.agentId === 'string' ? payload.agentId : 'graph',
      toolName: typeof payload.skill === 'string' ? payload.skill : undefined,
      payload: { runId, ...payload },
    });
    try {
      eventBus.emit(type as any, { taskId: runId, runId, ...payload });
    } catch { /* 总线异常不影响执行 */ }
  }

  private emitRunEvent(runId: string, type: string, payload: Record<string, any>): void {
    this.onGraphEvent(runId, type, payload);
  }

  private nextSeq(runId: string): number {
    // 惰性种子：本进程首次触达该 run 时从已持久化的最大 seq 续接
    //（重启后计数器归零 — 覆盖 interrupted 扫描/resume 等全部发射路径，防 seq 撞车）
    if (!this.seqCounters.has(runId)) {
      this.seqCounters.set(runId, this.deps.eventStore.maxSeq(runId));
    }
    const next = this.seqCounters.get(runId)! + 1;
    this.seqCounters.set(runId, next);
    return next;
  }

  private releaseSeq(runId: string): void {
    this.seqCounters.delete(runId);
  }

  private nodeSummary(state: GraphRunState): Record<string, string> {
    return Object.fromEntries(
      Object.entries(state.nodes).map(([id, n]) => [id, n.status])
    );
  }

  /** 完成摘要（run.finalContent — 列表页/通知用） */
  private summarizeCompletion(state: GraphRunState): string {
    const lines = Object.entries(state.nodes).map(([id, n]) => {
      if (n.status === 'completed') return `✅ ${id}`;
      if (n.status === 'skipped') return `⏭️ ${id}（跳过）`;
      return `⚠️ ${id}（${n.status}）`;
    });
    return `Graph 执行完成：\n${lines.join('\n')}`;
  }
}
