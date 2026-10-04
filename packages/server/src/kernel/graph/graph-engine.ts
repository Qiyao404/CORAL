import {
  type GraphDefinition,
  type GraphNodeDefinition,
  validateGraph,
  expandTemplates,
} from './dsl.js';
export type { GraphNodeDefinition } from './dsl.js';

/**
 * M2-1：GraphEngine — 确定性 DAG 执行内核（durable execution）。
 *
 * 与 AgentLoop 同套纯内核哲学：技能执行/事件/checkpoint 全部注入，不直接触库。
 * 修复 v1 调度器全部正确性缺陷（附录 A）：
 *  · A10 事件驱动：节点完成回调直接驱动调度，零轮询
 *  · A2  超时强制：节点级 AbortController + timeout_ms（执行器契约必须尊重 signal）
 *  · A5  重试语义：仅 retryable 错误重试、节点粒度、上限 retries
 *  · A6  失败级联：failed 节点的后代级联 skipped
 *  · A4  多父语义：子节点当且仅当「全部父节点 completed」才执行；
 *       父节点混合 completed+skipped 仍执行（另一条正常路径不被误跳）；
 *       全部 skipped（无失败）→ skipped；任一 failed → skipped
 *  · 节点级 checkpoint：每次节点终态迁移后快照全图状态（resume 用，M2-5）
 */

export type GraphNodeStatus =
  | 'pending'      // 未到达（含 resume 恢复出的未跑节点）
  | 'waiting_human' // 节点级审批挂起（M2-4）
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';     // 上游空产出级联 / 失败级联 / on_empty 自身跳过

export interface GraphNodeState {
  status: GraphNodeStatus;
  /** 模板展开后的实际输入（审批改参数时以此为准） */
  input?: Record<string, any>;
  outputs?: Record<string, any>;
  error?: string;
  /** 已重试次数（A5：节点粒度） */
  attempts: number;
  startedAt?: string;
  endedAt?: string;
}

/** 可序列化全图状态（checkpoint 载荷；resume 从此重建） */
export interface GraphRunState {
  nodes: Record<string, GraphNodeState>;
  /** 产出为空的节点（on_empty 判定过的事实，resume 不重复判） */
  emptyOutputs: string[];
}

export interface GraphEngineEvent {
  type: string;
  payload?: Record<string, any>;
}

/** 执行器契约（真实实现走 SkillExecutor；测试注入脚本桩） */
export interface GraphNodeExecutor {
  execute(
    def: GraphNodeDefinition,
    input: Record<string, any>,
    ctx: { signal: AbortSignal; runId: string }
  ): Promise<{
    ok: boolean;
    outputs?: Record<string, any>;
    /** 空=true 触发该节点 on_empty 策略（如采集无结果） */
    empty?: boolean;
    error?: { message: string; retryable: boolean };
  }>;
}

export interface GraphEngineOptions {
  runId: string;
  graph: GraphDefinition;
  /** 运行时输入（覆盖 graph.input 默认值） */
  input?: Record<string, any>;
  signal: AbortSignal;
  executor: GraphNodeExecutor;
  onEvent: (e: GraphEngineEvent) => void;
  /** 节点终态迁移后的全图快照（M2-5 resume 依据） */
  onCheckpoint?: (seq: number, state: GraphRunState) => void;
  /** 节点级审批（M2-4）：返回 { approved, input? } — 拒绝则节点 failed */
  approveNode?: (
    def: GraphNodeDefinition,
    input: Record<string, any>
  ) => Promise<{ approved: boolean; input?: Record<string, any> }>;
  /** resume：从快照恢复（未完成节点重跑，已完成节点产出直接复用） */
  resumeFrom?: GraphRunState;
}

export interface GraphRunResult {
  status: 'completed' | 'failed' | 'cancelled';
  /** completed：至少一个节点完成且无失败；failed：任一节点失败（未被 on_empty 吸收） */
  state: GraphRunState;
  checkpointSeq: number;
  error?: string;
}

const DEFAULT_MAX_PARALLEL = 3;

export class GraphEngine {
  private nodeDefs: Map<string, GraphNodeDefinition>;
  private parents: Map<string, string[]>;
  private children: Map<string, string[]>;
  private state: GraphRunState;
  private opts: GraphEngineOptions;
  private checkpointSeq = 0;
  private runningCount = 0;
  private settled = false;
  private resolveDone?: (r: GraphRunResult) => void;
  private nodeControllers = new Map<string, AbortController>();

  constructor(opts: GraphEngineOptions) {
    const v = validateGraph(opts.graph);
    if (!v.ok) {
      throw new Error(`graph 校验失败: ${v.issues.map(i => `${i.path}: ${i.message}`).join('; ')}`);
    }
    this.opts = opts;
    this.nodeDefs = new Map(opts.graph.nodes.map(n => [n.id, n]));
    this.parents = new Map(opts.graph.nodes.map(n => [n.id, [] as string[]]));
    this.children = new Map(opts.graph.nodes.map(n => [n.id, [] as string[]]));
    for (const e of opts.graph.edges ?? []) {
      this.parents.get(e.to)!.push(e.from);
      this.children.get(e.from)!.push(e.to);
    }
    // resume：恢复节点终态与产出；非终态节点一律回 pending（重跑）
    this.state = opts.resumeFrom
      ? {
          nodes: Object.fromEntries(
            opts.graph.nodes.map(n => {
              const prev = opts.resumeFrom?.nodes[n.id];
              const terminal = prev && ['completed', 'failed', 'skipped'].includes(prev.status);
              return [n.id, terminal ? prev : { status: 'pending' as const, attempts: 0 }];
            })
          ),
          emptyOutputs: new Set(opts.resumeFrom?.emptyOutputs ?? []).size
            ? [...new Set(opts.resumeFrom?.emptyOutputs ?? [])]
            : [],
        }
      : {
          nodes: Object.fromEntries(
            opts.graph.nodes.map(n => [n.id, { status: 'pending' as const, attempts: 0 }])
          ),
          emptyOutputs: [],
        };
  }

  /** 执行到全图终态（事件驱动；并发受 max_parallel 约束） */
  async run(): Promise<GraphRunResult> {
    this.emit('graph.started', {
      nodes: this.nodeDefs.size,
      resumed: Boolean(this.opts.resumeFrom),
    });
    // 取消传播：signal 中止时强杀运行中节点并收口（waiting_human 由外部审批桥拒绝）
    this.opts.signal.addEventListener('abort', () => this.abortRunningNodes(), { once: true });
    this.pump();
    return await new Promise<GraphRunResult>(resolve => {
      this.resolveDone = resolve;
    });
  }

  // ─── 调度核心（A10：完成回调驱动，无轮询）──────────────────────

  /** 尽量填满并发槽；级联跳过可能解锁新的级联，循环扫描直到一轮无进展 */
  private pump(): void {
    if (this.settled) return;
    const cap = this.opts.graph.max_parallel ?? DEFAULT_MAX_PARALLEL;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const id of this.nodeDefs.keys()) {
        if (this.runningCount >= cap) break;
        const st = this.state.nodes[id];
        if (st.status !== 'pending') continue;

        // A4/A6 级联语义：
        //  · 任一父 failed → skipped（失败级联，A6）
        //  · 全部父 skipped（无失败）→ skipped（空产出级联，v1 语义）
        //  · 父全终态且至少一个 completed → 执行（含 completed+skipped 混合，A4 修复）
        //  · 其余（父未全终态）→ 等待
        const ps = this.parents.get(id)!;
        const statuses = ps.map(p => this.state.nodes[p].status);
        const anyFailed = statuses.includes('failed');
        const allSkipped = statuses.length > 0 && statuses.every(s => s === 'skipped');
        const allTerminal = statuses.every(x => x === 'completed' || x === 'failed' || x === 'skipped');
        const anyCompleted = statuses.includes('completed');

        if (anyFailed || allSkipped) {
          this.transition(id, { status: 'skipped', endedAt: nowIso() });
          progressed = true; // 级联解锁可能新的级联/执行
          continue;
        }
        if (ps.length === 0 || (allTerminal && anyCompleted)) {
          void this.executeNode(id);
          progressed = true;
          if (this.runningCount >= cap) break;
        }
      }
    }
    this.checkAllSettled();
  }

  private async executeNode(id: string): Promise<void> {
    const def = this.nodeDefs.get(id)!;
    this.runningCount++;
    this.transition(id, { status: 'running', startedAt: nowIso(), attempts: (this.state.nodes[id].attempts ?? 0) });

    try {
      // 模板展开（失败节点的产出缺失 → 视为空引用，走 on_empty）
      const mergedInput = { ...(this.opts.graph.input ?? {}), ...(this.opts.input ?? {}) };
      const { value, missing } = expandTemplates(def.input ?? {}, {
        input: mergedInput,
        nodes: this.outputsOf(),
      });
      const expanded = value as Record<string, any>;
      this.state.nodes[id].input = expanded;
      if (missing.length > 0) {
        // 上游输出键名对不上（如引用了不存在的 markdown 字段）— 保留执行但留痕，
        // 空串/undefined 传入技能通常表现为"空输入"类错误，此事件帮助定位真因
        this.emit('graph.node_input_missing', { node: id, missing });
      }

      // M1-10/M2-4：节点级审批（可改参数后继续）
      if (def.permission === 'approval' && this.opts.approveNode) {
        this.transition(id, { status: 'waiting_human' });
        const decision = await this.opts.approveNode(def, expanded);
        if (this.opts.signal.aborted) return; // 等待期间被取消
        if (!decision.approved) {
          this.transition(id, {
            status: 'failed',
            endedAt: nowIso(),
            error: '节点审批被拒绝',
          });
          return;
        }
        if (decision.input) {
          this.state.nodes[id].input = decision.input;
        }
        this.transition(id, { status: 'running' });
      }

      await this.withRetries(id, def);
    } catch (err: any) {
      if (this.opts.signal.aborted) {
        // 取消：保持现场，由 checkAllSettled 强制收口
      } else {
        this.transition(id, { status: 'failed', endedAt: nowIso(), error: err?.message ?? String(err) });
      }
    } finally {
      this.runningCount--;
      this.nodeControllers.delete(id);
      this.pump();
    }
  }

  /** A5 修复：仅 retryable 错误、节点粒度、上限 def.retries */
  private async withRetries(id: string, def: GraphNodeDefinition): Promise<void> {
    const maxAttempts = 1 + (def.retries ?? 0);
    // 节点级超时（A2）：每次尝试独立起算，覆盖全部重试
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.opts.signal.aborted) return;
      this.state.nodes[id].attempts = attempt;
      const controller = new AbortController();
      this.nodeControllers.set(id, controller);
      const timeout = def.timeout_ms
        ? setTimeout(() => controller.abort(new Error(`节点 ${id} 超时（${def.timeout_ms}ms）`)), def.timeout_ms)
        : undefined;
      const onParentAbort = () => controller.abort(new Error('run 已取消'));
      this.opts.signal.addEventListener('abort', onParentAbort, { once: true });
      try {
        const r = await this.opts.executor.execute(
          def,
          this.state.nodes[id].input ?? {},
          { signal: controller.signal, runId: this.opts.runId }
        );
        if (this.opts.signal.aborted) return;

        if (r.ok) {
          const isEmpty = r.empty === true;
          if (isEmpty) {
            this.state.emptyOutputs.push(id);
            const policy = def.on_empty ?? 'skip';
            if (policy === 'fail') {
              this.transition(id, {
                status: 'failed',
                endedAt: nowIso(),
                error: '空产出（on_empty: fail）',
              });
              return;
            }
            if (policy === 'skip') {
              this.transition(id, { status: 'skipped', endedAt: nowIso() });
              return;
            }
            // continue：按完成处理（产出可能为空对象）
          }
          this.transition(id, {
            status: 'completed',
            endedAt: nowIso(),
            outputs: r.outputs ?? {},
          });
          return;
        }

        // 失败：不可重试 / 重试次数耗尽 → failed；否则继续循环。
        // 超时强制中断时优先取 abort reason（executor 只知道"被中止"，不知道为什么）
        const abortReason = controller.signal.aborted
          ? ((controller.signal.reason as Error)?.message ?? undefined)
          : undefined;
        const message = abortReason ?? r.error?.message ?? '节点执行失败';
        const retryable = r.error?.retryable === true && attempt < maxAttempts && !abortReason;
        if (!retryable) {
          this.transition(id, { status: 'failed', endedAt: nowIso(), error: message });
          return;
        }
        this.emit('graph.node_retrying', { node: id, attempt, error: message });
      } finally {
        if (timeout) clearTimeout(timeout);
        this.opts.signal.removeEventListener('abort', onParentAbort);
      }
    }
  }

  // ─── 状态与持久化 ─────────────────────────────────────────

  /** 节点终态/运行态迁移：发事件 + 全图快照（节点级 checkpoint） */
  private transition(id: string, patch: Partial<GraphNodeState> & { status: GraphNodeStatus }): void {
    if (this.settled) return; // 已收口（如取消后审批桥才返回）
    const prev = this.state.nodes[id].status;
    Object.assign(this.state.nodes[id], patch);
    // 审查 P1：事件/checkpoint 落库抛错（磁盘满/DB 锁）不能外溢 —
    // 否则 executeNode 的 void promise 变 unhandled rejection，引擎永久悬挂
    try {
      this.emitAndCheckpoint(id, patch, prev);
    } catch (err: any) {
      try {
        this.opts.onEvent({ type: 'graph.checkpoint_error', payload: { runId: this.opts.runId, node: id, error: String(err?.message ?? err) } });
      } catch { /* 双保险 */ }
    }
  }

  private emitAndCheckpoint(id: string, patch: Partial<GraphNodeState> & { status: GraphNodeStatus }, prev: GraphNodeStatus): void {
    this.emit(`graph.node_${patch.status}`, {
      node: id,
      skill: this.nodeDefs.get(id)!.skill,
      prev,
      ...(patch.outputs !== undefined ? { outputs: preview(patch.outputs) } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.status === 'running' && patch.attempts !== undefined ? { attempt: patch.attempts } : {}),
    });
    // 每次节点状态迁移都落快照（waiting_human 也落 — resume 需要知道挂起点）
    this.checkpointSeq++;
    this.opts.onCheckpoint?.(this.checkpointSeq, JSON.parse(JSON.stringify(this.state)));
  }

  /** 模板上下文：${{ nodes.<id>.outputs.<path> }} — 带 outputs 层（与 DSL 契约一致） */
  private outputsOf(): Record<string, Record<string, any>> {
    const out: Record<string, Record<string, any>> = {};
    for (const [id, st] of Object.entries(this.state.nodes)) {
      if (st.status === 'completed') out[id] = { outputs: st.outputs ?? {} };
    }
    return out;
  }

  private checkAllSettled(): void {
    if (this.settled || !this.resolveDone) return;
    if (this.runningCount > 0) return;
    if (this.opts.signal.aborted) {
      // 取消：运行槽已空即收口（waiting_human 的审批桥由外部拒绝，不阻塞终态）
      this.settled = true;
      this.emit('graph.cancelled', {});
      this.resolveDone({ status: 'cancelled', state: this.state, checkpointSeq: this.checkpointSeq });
      return;
    }
    const statuses = Object.values(this.state.nodes).map(s => s.status);
    if (statuses.some(s => s === 'pending' || s === 'running' || s === 'waiting_human')) {
      // 等待审批（waiting_human）或父未终态（运行中的兄弟会再触发 pump）
      return;
    }
    this.settled = true;

    const failed = Object.entries(this.state.nodes).filter(([, s]) => s.status === 'failed');
    if (failed.length > 0) {
      this.emit('graph.failed', { failed: failed.map(([id]) => id) });
      this.resolveDone({
        status: 'failed',
        state: this.state,
        checkpointSeq: this.checkpointSeq,
        error: failed.map(([id, s]) => `${id}: ${s.error ?? 'failed'}`).join('; '),
      });
      return;
    }
    this.emit('graph.completed', {});
    this.resolveDone({ status: 'completed', state: this.state, checkpointSeq: this.checkpointSeq });
  }

  /** 取消传播：中止全部运行中节点（waiting_human 由 approveNode Promise 感知 signal） */
  abortRunningNodes(): void {
    for (const [, c] of this.nodeControllers) c.abort(new Error('run 已取消'));
    this.checkAllSettled();
  }

  private emit(type: string, payload: Record<string, any>): void {
    try {
      this.opts.onEvent({ type, payload: { runId: this.opts.runId, ...payload } });
    } catch { /* 消费者异常不中断 */ }
  }

  /** 当前快照（外部随时取 — 审批中心展示用） */
  snapshot(): GraphRunState {
    return JSON.parse(JSON.stringify(this.state));
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function preview(v: unknown): unknown {
  const s = JSON.stringify(v ?? {});
  return s.length > 2000 ? s.slice(0, 2000) + '…' : v;
}
