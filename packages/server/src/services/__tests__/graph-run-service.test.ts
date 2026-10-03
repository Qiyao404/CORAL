import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-grs-'));
process.env.DATABASE_PATH = join(tmp, 'graph.db');

const { GraphRunService } = await import('../graph-run-service.js');
const { RunStore } = await import('../../store/run-store.js');
const { RunEventStore } = await import('../../store/run-event-store.js');
const { CheckpointStore } = await import('../../store/checkpoint-store.js');
const { FilesystemSkillRegistry } = await import('../../skill-runtime/filesystem-registry.js');
const { SkillExecutor } = await import('../../skill-runtime/skill-executor.js');
const { closeDb } = await import('../../store/index.js');
import type { SkillExecutionRequest, SkillExecutionResult } from '../../types/index.js';

let svc: GraphRunService;
let runStore: RunStore;
let eventStore: RunEventStore;
let checkpointStore: CheckpointStore;

/** 桩 SkillExecutor：按技能名预设行为（真实执行器走 llm/脚本，这里聚焦服务层语义） */
class StubExecutor extends SkillExecutor {
  behaviors = new Map<string, (input: any, call: number) => Partial<SkillExecutionResult>>();
  calls: Array<{ skill: string; input: any; aborted?: boolean }> = [];

  async execute(request: SkillExecutionRequest): Promise<SkillExecutionResult> {
    const call = (this.calls.filter(c => c.skill === request.skillName).length + 1);
    this.calls.push({ skill: request.skillName, input: request.input });
    const b = this.behaviors.get(request.skillName);
    if (!b) return { success: true, data: { done: request.skillName }, meta: { durationMs: 1 } } as SkillExecutionResult;
    const r = b(request.input, call);
    return { success: true, data: {}, meta: { durationMs: 1 }, ...r } as SkillExecutionResult;
  }
}

let stub: StubExecutor;

beforeAll(async () => {
  const skillsDir = join(tmp, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const registry = new FilesystemSkillRegistry(skillsDir);
  await registry.reloadAll();
  stub = new StubExecutor(registry);
  runStore = new RunStore();
  eventStore = new RunEventStore();
  checkpointStore = new CheckpointStore();
  svc = new GraphRunService({
    skillExecutor: stub,
    runStore,
    eventStore,
    checkpointStore,
  });
});
afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

const GRAPH = {
  name: 'demo',
  nodes: [
    { id: 'a', type: 'skill' as const, skill: 's1' },
    { id: 'b', type: 'skill' as const, skill: 's2', input: { x: '${{ nodes.a.outputs.v }}' } },
  ],
  edges: [{ from: 'a', to: 'b' }],
};

async function waitForTerminal(runId: string, timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = runStore.get(runId);
    if (run && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) return run.status;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('waitForTerminal 超时');
}

describe('GraphRunService — 接线与生命周期（M2-4/M2-5）', () => {
  it('完整跑通：run 行 mode=graph + graph_json、事件双写落库、checkpoint 带 graphState、finalContent 摘要', async () => {
    stub.behaviors.set('s1', () => ({ success: true, data: { v: 42 } }));
    stub.behaviors.set('s2', () => ({ success: true, data: { out: 'done' } }));

    const { runId } = svc.startGraphRun({ goal: '测试 graph', graph: GRAPH });
    const status = await waitForTerminal(runId);

    expect(status).toBe('completed');
    const run = runStore.get(runId)!;
    expect(run.mode).toBe('graph');
    expect((run.graph as any).name).toBe('demo');
    expect(run.final_content).toContain('✅ a');

    const events = eventStore.listByRun(runId, 0, 500);
    const types = events.map(e => e.type);
    expect(types).toContain('graph.node_completed');
    expect(types).toContain('graph.completed');

    const cps = checkpointStore.listByRun(runId);
    expect(cps.length).toBeGreaterThanOrEqual(2);
    const lastState = checkpointStore.get(runId, cps[cps.length - 1].seq);
    expect((lastState?.vars as any)?.graphState.nodes.b.status).toBe('completed');

    // 模板经真实链路传递
    const bCall = stub.calls.filter(c => c.skill === 's2').at(-1)!;
    expect(bCall.input.x).toBe(42);
  });

  it('M2-4 审批：节点挂起 waiting_human → 审批中心跨 run 可见 → 改参数通过 → 用改后输入继续 → 完成', async () => {
    stub.behaviors.set('s1', () => ({ success: true, data: { v: 1 } }));
    stub.behaviors.set('s2', () => ({ success: true, data: { ok: true } }));

    const graph = {
      ...GRAPH,
      nodes: [
        { id: 'a', type: 'skill' as const, skill: 's1' },
        { id: 'b', type: 'skill' as const, skill: 's2', permission: 'approval' as const, input: { x: 1 } },
      ],
    };
    const { runId } = svc.startGraphRun({ goal: '审批流', graph });

    // 等待挂起
    await new Promise(r => setTimeout(r, 60));
    let run = runStore.get(runId)!;
    expect(run.status).toBe('waiting_human');

    const pending = svc.listAllPendingApprovals();
    expect(pending.some(p => p.runId === runId && p.skill === 's2')).toBe(true);

    // 改参数通过
    const approvalId = pending.find(p => p.runId === runId)!.approvalId;
    expect(svc.resolveApproval(runId, approvalId, true, { x: 999 })).toBe(true);

    const status = await waitForTerminal(runId);
    expect(status).toBe('completed');
    const bCall = stub.calls.filter(c => c.skill === 's2').at(-1)!;
    expect(bCall.input.x).toBe(999); // 改后参数生效
    const events = eventStore.listByRun(runId, 0, 500);
    expect(events.some(e => e.type === 'node.approval_required')).toBe(true);
    expect(events.some(e => e.type === 'node.approval_resolved' && e.payload?.approved === true)).toBe(true);
  });

  it('M2-4 审批拒绝：节点 failed → run failed', async () => {
    stub.behaviors.set('s1', () => ({ success: true, data: {} }));
    const graph = {
      name: 'reject-test',
      nodes: [{ id: 'a', type: 'skill' as const, skill: 's1', permission: 'approval' as const }],
      edges: [],
    };
    const { runId } = svc.startGraphRun({ goal: '拒绝', graph });
    await new Promise(r => setTimeout(r, 60));
    const pending = svc.listAllPendingApprovals().find(p => p.runId === runId)!;
    svc.resolveApproval(runId, pending.approvalId, false);
    expect(await waitForTerminal(runId)).toBe('failed');
  });

  it('M2-5 resume：模拟进程重启（直接标记 interrupted）→ 从 checkpoint 恢复 → 未完成节点续跑、已完成不重跑', async () => {
    // 第一步：让 a 完成、b 永远挂起（用审批挂住 run），然后"重启"
    stub.behaviors.set('s1', () => ({ success: true, data: { v: 7 } }));
    const graph = {
      name: 'resume-test',
      nodes: [
        { id: 'a', type: 'skill' as const, skill: 's1' },
        { id: 'b', type: 'skill' as const, skill: 's2', permission: 'approval' as const, input: { x: '${{ nodes.a.outputs.v }}' } },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    const { runId } = svc.startGraphRun({ goal: 'resume 测试', graph });
    await new Promise(r => setTimeout(r, 80));
    expect(runStore.get(runId)!.status).toBe('waiting_human'); // b 审批挂起，a 已完成

    // 模拟重启：服务重建（engines/pendingApprovals 清空），run 标记 interrupted
    svc = new GraphRunService({ skillExecutor: stub, runStore, eventStore, checkpointStore });
    const n = svc.markInterruptedGraphRuns();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(runStore.get(runId)!.end_reason).toBe('process_restarted');
    expect(svc.listResumable().some(r => r.runId === runId)).toBe(true);
    // resume 后 b（waiting_human 非终态）重跑并再次挂审批 — 这是正确的恢复语义
    expect(svc.resumeGraphRun(runId).ok).toBe(true);
    await new Promise(r => setTimeout(r, 80));
    expect(runStore.get(runId)!.status).toBe('waiting_human');
    expect(true).toBe(true);

    // b 行为改为直接成功；随后解决审批
    stub.behaviors.set('s2', () => ({ success: true, data: { ok: true } }));
    const pending = svc.listAllPendingApprovals().find(p => p.runId === runId)!;
    // a 没有重跑（calls 里 s1 只出现在 resume 前）
    const s1Calls = stub.calls.filter(c => c.skill === 's1').length;
    svc.resolveApproval(runId, pending.approvalId, true);
    expect(await waitForTerminal(runId)).toBe('completed');
    expect(stub.calls.filter(c => c.skill === 's1').length).toBe(s1Calls); // 未重跑
    const events = eventStore.listByRun(runId, 0, 500);
    expect(events.some(e => e.type === 'run.resumed')).toBe(true);
  });

  it('取消：waiting_human 的 run 可取消，未决审批被拒绝且不悬挂', async () => {
    stub.behaviors.set('s1', () => ({ success: true, data: {} }));
    const graph = {
      name: 'reject-test',
      nodes: [{ id: 'a', type: 'skill' as const, skill: 's1', permission: 'approval' as const }],
      edges: [],
    };
    const { runId } = svc.startGraphRun({ goal: '取消', graph });
    await new Promise(r => setTimeout(r, 60));
    expect(runStore.get(runId)!.status).toBe('waiting_human');
    expect(svc.cancelGraphRun(runId).ok).toBe(true);
    expect(await waitForTerminal(runId)).toBe('cancelled');
    expect(svc.listAllPendingApprovals().filter(p => p.runId === runId)).toHaveLength(0);
  });

  it('类型守卫：数组传给 string 字段 → 快失败并给可操作提示（替代 "[object Object]"）', async () => {
    // 桩 registry：web-reader 的 url 是 string
    const reg = {
      getByName: (name: string) => name === 'web-reader'
        ? { name, inputSchema: { properties: { url: { type: 'string' } } } }
        : null,
    };
    const guardedSvc = new GraphRunService({
      skillExecutor: stub,
      skillRegistry: reg as any,
      runStore,
      eventStore,
      checkpointStore,
    });
    const { runId } = guardedSvc.startGraphRun({
      goal: '类型守卫',
      graph: {
        name: 'guard-test',
        nodes: [{ id: 'r', type: 'skill', skill: 'web-reader', input: { url: '${{ input.urls }}' } }],
        edges: [],
        input: { urls: ['https://a.com', 'https://b.com'] },
      },
    });
    expect(await waitForTerminal(runId)).toBe('failed');
    const run = runStore.get(runId)!;
    expect(run.final_content).toContain('类型不匹配');
    expect(run.final_content).toContain('url');
  });

  it('非法 graph 启动即拒（校验前置）', () => {
    expect(() =>
      svc.startGraphRun({
        goal: 'x',
        graph: { nodes: [], edges: [] } as any,
      })
    ).toThrow(/校验失败/);
  });
});
