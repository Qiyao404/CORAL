import { describe, it, expect } from 'vitest';
import { GraphEngine, type GraphNodeExecutor, type GraphEngineEvent, type GraphRunState } from '../graph-engine.js';
import type { GraphDefinition } from '../dsl.js';

/** 脚本化执行器：按 skill 名（或 node:id）预设行为 */
class ScriptedExecutor implements GraphNodeExecutor {
  calls: Array<{ node: string; skill: string; input: any }> = [];
  private behaviors = new Map<string, (input: any, call: number) => any>();
  private callCounts = new Map<string, number>();

  on(key: string, behavior: (input: any, call: number) => any): this {
    this.behaviors.set(key, behavior);
    return this;
  }

  async execute(def: any, input: any, _ctx: any): Promise<any> {
    const key = `node:${def.id}`;
    this.callCounts.set(key, (this.callCounts.get(key) ?? 0) + 1);
    this.calls.push({ node: def.id, skill: def.skill, input });
    const b = this.behaviors.get(key) ?? this.behaviors.get(def.skill);
    if (!b) return { ok: true, outputs: { done: def.id } };
    try {
      return b(input, this.callCounts.get(key)!);
    } catch (err: any) {
      return { ok: false, error: { message: err.message, retryable: false } };
    }
  }
}

function harness(over: {
  graph: Partial<GraphDefinition> & { nodes: any[] };
  executor?: ScriptedExecutor;
  input?: Record<string, any>;
  approveNode?: any;
  resumeFrom?: GraphRunState;
  signal?: AbortSignal;
}) {
  const graph: GraphDefinition = {
    name: 't',
    edges: over.graph.edges ?? [],
    ...over.graph,
  } as GraphDefinition;
  const events: GraphEngineEvent[] = [];
  const checkpoints: Array<{ seq: number; state: GraphRunState }> = [];
  const executor = over.executor ?? new ScriptedExecutor();
  const engine = new GraphEngine({
    runId: 'r_t',
    graph,
    input: over.input,
    signal: over.signal ?? new AbortController().signal,
    executor,
    onEvent: e => events.push(e),
    onCheckpoint: (seq, state) => checkpoints.push({ seq, state }),
    approveNode: over.approveNode,
    resumeFrom: over.resumeFrom,
  });
  return { engine, events, checkpoints, executor };
}

describe('GraphEngine — 调度核心（M2-1）', () => {
  it('线性三节点顺序执行，产出经模板传递，节点级 checkpoint', async () => {
    const ex = new ScriptedExecutor()
      .on('node:a', (i, c) => ({ ok: true, outputs: { files: ['f1.md'], call: c } }))
      .on('node:b', i => ({ ok: true, outputs: { got: i.upstream } }))
      .on('node:c', () => ({ ok: true, outputs: { final: true } }));
    const { engine, checkpoints } = harness({
      executor: ex,
      graph: {
        nodes: [
          { id: 'a', type: 'skill', skill: 's1' },
          { id: 'b', type: 'skill', skill: 's2', input: { upstream: '${{ nodes.a.outputs.files }}' } },
          { id: 'c', type: 'skill', skill: 's3', input: { from: '${{ nodes.b.outputs.got }}' } },
        ],
        edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
      },
    });
    const r = await engine.run();

    expect(r.status).toBe('completed');
    // 模板整串引用保留类型
    const bCall = ex.calls.find(c => c.node === 'b')!;
    expect(bCall.input.upstream).toEqual(['f1.md']);
    const cCall = ex.calls.find(c => c.node === 'c')!;
    expect(cCall.input.from).toEqual(['f1.md']);
    // 每个节点终态各留一个 checkpoint（3 节点 ≥ 3 个快照，seq 递增）
    expect(checkpoints.length).toBeGreaterThanOrEqual(3);
    expect(checkpoints[checkpoints.length - 1].state.nodes.c.status).toBe('completed');
  });

  it('并发受 max_parallel 约束（A10 事件驱动，无轮询）', async () => {
    let inFlight = 0;
    let peak = 0;
    const ex = new ScriptedExecutor().on('s', async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(res => setTimeout(res, 30));
      inFlight--;
      return { ok: true, outputs: {} };
    }) as unknown as GraphNodeExecutor;
    const { engine } = harness({
      executor: ex,
      graph: {
        max_parallel: 2,
        nodes: [1, 2, 3, 4].map(i => ({ id: `n${i}`, type: 'skill', skill: 's' })),
        edges: [],
      },
    });
    const r = await engine.run();
    expect(r.status).toBe('completed');
    expect(peak).toBe(2);
  });

  it('A4 修复：多父节点 — 一父 skipped 一父 completed 时子节点仍然执行', async () => {
    const ex = new ScriptedExecutor()
      .on('node:emptySrc', () => ({ ok: true, outputs: {}, empty: true }))   // on_empty 默认 skip
      .on('node:goodSrc', () => ({ ok: true, outputs: { data: 42 } }));
    const { engine } = harness({
      executor: ex,
      graph: {
        nodes: [
          { id: 'emptySrc', type: 'skill', skill: 's' },
          { id: 'goodSrc', type: 'skill', skill: 's' },
          { id: 'join', type: 'skill', skill: 's', input: { d: '${{ nodes.goodSrc.outputs.data }}' } },
        ],
        edges: [
          { from: 'emptySrc', to: 'join' },
          { from: 'goodSrc', to: 'join' },
        ],
      },
    });
    const r = await engine.run();
    expect(r.status).toBe('completed');
    expect(r.state.nodes.emptySrc.status).toBe('skipped');
    expect(r.state.nodes.join.status).toBe('completed'); // v1 在此误跳
  });

  it('空产出级联：全父 skipped → 子 skipped 且整体不算失败（v1 语义保留）', async () => {
    const ex = new ScriptedExecutor().on('node:src', () => ({ ok: true, outputs: {}, empty: true }));
    const { engine } = harness({
      executor: ex,
      graph: {
        nodes: [
          { id: 'src', type: 'skill', skill: 's' },
          { id: 'child', type: 'skill', skill: 's' },
          { id: 'grandchild', type: 'skill', skill: 's' },
        ],
        edges: [{ from: 'src', to: 'child' }, { from: 'child', to: 'grandchild' }],
      },
    });
    const r = await engine.run();
    expect(r.status).toBe('completed');
    expect(r.state.nodes.child.status).toBe('skipped');
    expect(r.state.nodes.grandchild.status).toBe('skipped');
  });

  it('on_empty: fail — 空产出按失败处理（级联 skipped + 整体 failed）', async () => {
    const ex = new ScriptedExecutor().on('node:src', () => ({ ok: true, outputs: {}, empty: true }));
    const { engine } = harness({
      executor: ex,
      graph: {
        nodes: [
          { id: 'src', type: 'skill', skill: 's', on_empty: 'fail' },
          { id: 'child', type: 'skill', skill: 's' },
        ],
        edges: [{ from: 'src', to: 'child' }],
      },
    });
    const r = await engine.run();
    expect(r.status).toBe('failed');
    expect(r.state.nodes.src.status).toBe('failed');
    expect(r.state.nodes.child.status).toBe('skipped');
  });

  it('A6 修复：节点失败 → 后代级联 skipped，run failed；兄弟节点照常完成', async () => {
    const ex = new ScriptedExecutor()
      .on('node:boom', () => ({ ok: false, error: { message: '炸了', retryable: false } }))
      .on('node:ok', () => ({ ok: true, outputs: {} }));
    const { engine, events } = harness({
      executor: ex,
      graph: {
        nodes: [
          { id: 'boom', type: 'skill', skill: 's' },
          { id: 'ok', type: 'skill', skill: 's' },
          { id: 'child', type: 'skill', skill: 's' },
        ],
        edges: [{ from: 'boom', to: 'child' }],
      },
    });
    const r = await engine.run();
    expect(r.status).toBe('failed');
    expect(r.state.nodes.ok.status).toBe('completed');       // 兄弟不受影响
    expect(r.state.nodes.child.status).toBe('skipped');      // 失败级联（v1 缺失）
    expect(events.some(e => e.type === 'graph.node_failed')).toBe(true);
  });

  it('A5 修复：retryable 错误按节点粒度重试，成功后继续；非 retryable 零重试', async () => {
    let boomCalls = 0;
    const ex = new ScriptedExecutor()
      .on('node:flaky', () => {
        boomCalls++;
        return boomCalls < 3
          ? { ok: false, error: { message: '瞬时错误', retryable: true } }
          : { ok: true, outputs: { recovered: true } };
      })
      .on('node:perm', () => ({ ok: false, error: { message: '永久错误', retryable: false } }));
    const r1 = await harness({
      executor: ex,
      graph: {
        nodes: [{ id: 'flaky', type: 'skill', skill: 's', retries: 2 }],
        edges: [],
      },
    }).engine.run();
    expect(r1.status).toBe('completed');
    expect(r1.state.nodes.flaky.attempts).toBe(3);

    const r2 = await harness({
      executor: ex,
      graph: {
        nodes: [{ id: 'perm', type: 'skill', skill: 's', retries: 3 }],
        edges: [],
      },
    }).engine.run();
    expect(r2.status).toBe('failed');
    expect(r2.state.nodes.perm.attempts).toBe(1); // 永久错误一次都不重试
  });

  it('A2 修复：节点超时强制中断（挂起执行器被 abort 后按失败收口）', async () => {
    const ex: GraphNodeExecutor = {
      execute: (_def, _input, ctx) =>
        new Promise(resolve => {
          ctx.signal.addEventListener('abort', () =>
            resolve({ ok: false, error: { message: 'aborted', retryable: false } })
          );
          // 永不主动完成 — 只能被超时 abort
        }),
    };
    const { engine } = harness({
      executor: ex,
      graph: {
        nodes: [{ id: 'hang', type: 'skill', skill: 's', timeout_ms: 1000 }],
        edges: [],
      },
    });
    const r = await engine.run();
    expect(r.status).toBe('failed');
    expect(r.state.nodes.hang.status).toBe('failed');
    expect(r.state.nodes.hang.error).toContain('超时');
  });

  it('取消：运行中节点中止 → run cancelled，节点状态保持现场', async () => {
    const ac = new AbortController();
    const ex: GraphNodeExecutor = {
      execute: (_def, _input, ctx) =>
        new Promise(resolve => {
          ctx.signal.addEventListener('abort', () => resolve({ ok: false, error: { message: 'aborted', retryable: false } }));
          setTimeout(() => ac.abort(), 20);
        }),
    };
    const { engine, events } = harness({
      executor: ex,
      signal: ac.signal,
      graph: {
        nodes: [{ id: 'n1', type: 'skill', skill: 's' }, { id: 'n2', type: 'skill', skill: 's' }],
        edges: [{ from: 'n1', to: 'n2' }],
      },
    });
    const r = await engine.run();
    expect(r.status).toBe('cancelled');
    expect(events.some(e => e.type === 'graph.cancelled')).toBe(true);
  });

  it('M2-4：节点级审批 — 拒绝 → 节点 failed；改参数通过 → 用改后输入执行', async () => {
    const ex = new ScriptedExecutor();
    const approve = async (def: any, input: any) => {
      if (def.id === 'strict') {
        return { approved: false };
      }
      return { approved: true, input: { ...input, patched: true } };
    };
    const { engine } = harness({
      executor: ex,
      approveNode: approve,
      graph: {
        nodes: [
          { id: 'strict', type: 'skill', skill: 's', permission: 'approval' },
          { id: 'patched', type: 'skill', skill: 's', permission: 'approval', input: { x: 1 } },
        ],
        edges: [],
      },
    });
    const r = await engine.run();
    expect(r.status).toBe('failed');
    expect(r.state.nodes.strict.status).toBe('failed');
    expect(r.state.nodes.patched.status).toBe('completed');
    expect(ex.calls.find(c => c.node === 'patched')!.input).toEqual({ x: 1, patched: true });
  });

  it('M2-5 基础：resumeFrom — 已完成节点不重跑、产出直接复用，pending 节点续跑', async () => {
    const ex = new ScriptedExecutor().on('node:b', i => ({ ok: true, outputs: { gotA: i.fromA } }));
    const resumedState: GraphRunState = {
      nodes: {
        a: { status: 'completed', attempts: 1, outputs: { fromA: 'A 的产出' } },
        b: { status: 'pending', attempts: 0 },
      },
      emptyOutputs: [],
    };
    const { engine, executor } = harness({
      executor: ex,
      resumeFrom: resumedState,
      graph: {
        nodes: [
          { id: 'a', type: 'skill', skill: 's' },
          { id: 'b', type: 'skill', skill: 's', input: { fromA: '${{ nodes.a.outputs.fromA }}' } },
        ],
        edges: [{ from: 'a', to: 'b' }],
      },
    });
    const r = await engine.run();
    expect(r.status).toBe('completed');
    expect(executor.calls.map(c => c.node)).toEqual(['b']); // a 未重跑
    expect(r.state.nodes.b.outputs!.gotA).toBe('A 的产出'); // a 的产出经快照复用
  });

  it('非法 graph（环）构造即抛错', () => {
    expect(() =>
      harness({
        graph: {
          nodes: [
            { id: 'a', type: 'skill', skill: 's' },
            { id: 'b', type: 'skill', skill: 's' },
          ],
          edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
        },
      })
    ).toThrow(/环|校验失败/);
  });
});
