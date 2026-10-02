import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-short-'));
process.env.DATABASE_PATH = join(tmp, 'sched.db');

const { DAGScheduler } = await import('../../scheduler/dag-scheduler.js');
const { closeDb } = await import('../../store/index.js');
const { eventBus } = await import('../../event/event-bus.js');
import type { ExecutionPlan, SkillExecutionResult, SkillExecutionRequest, ParsedSkillManifest } from '../../types/index.js';

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * 按输入的 count 返回结果；配合 mock registry 的 empty_when:
 *   count: {count: 0} 命中 empty_when → 触发优雅短路
 */
class CountingExecutor {
  calls: string[] = [];
  constructor(private outputs: Record<string, Record<string, any>>) {}
  async execute(request: SkillExecutionRequest): Promise<SkillExecutionResult> {
    this.calls.push(request.skillName);
    const data = this.outputs[request.skillName] ?? { count: 1 };
    return {
      success: true,
      data,
      meta: { durationMs: 1, skillVersion: '1', executionMode: 'script', sandboxUsed: false },
    };
  }
}

/** mock registry — 只需提供 empty_when 判定所需的 manifest */
function makeRegistry(emptyWhen?: ParsedSkillManifest['emptyWhen']): any {
  return {
    getByName: (name: string) =>
      name === 's-source' ? ({ name: 's-source', emptyWhen } as Partial<ParsedSkillManifest>) : null,
  };
}

function chainPlan(taskId: string): ExecutionPlan {
  const agent = (agentId: string, skill: string, dependsOn: string[]) => ({
    agentId,
    name: agentId,
    role: 'r',
    assignedSkills: [skill],
    skillInputTemplates: { [skill]: {} },
    dependsOn,
    priority: 0,
    estimatedDurationMs: 100,
  });
  return {
    planId: `plan-${taskId}`,
    taskId,
    version: 1,
    agents: [agent('a1', 's-source', []), agent('a2', 's-filter', ['a1']), agent('a3', 's-post', ['a2'])],
    edges: [
      { from: 'a1', to: 'a2' },
      { from: 'a2', to: 'a3' },
    ],
    createdAt: new Date().toISOString(),
  };
}

describe('DAGScheduler 优雅短路（M0-7：单链场景）', () => {
  it('上游产物为空（count=0 命中 empty_when）→ 整条下游级联 skipped，任务不算失败', async () => {
    const executor = new CountingExecutor({ 's-source': { count: 0 } });
    const registry = makeRegistry([{ field: 'count', op: 'eq', value: 0 }]);
    const scheduler = new DAGScheduler(executor as any, registry);

    const result = await scheduler.execute(chainPlan('t-empty'), 't-empty', 'u', 'goal');

    // 任务成功（短路是优雅路径，不是失败）
    expect(result.success).toBe(true);
    expect(result.cancelled).toBeFalsy();

    const byId = new Map([...result.results.values()].map(a => [a.agentId, a]));
    expect(byId.get('a1')?.status).toBe('completed');
    expect(byId.get('a2')?.status).toBe('cancelled');
    expect(byId.get('a2')?.error?.code).toBe('UPSTREAM_EMPTY');
    expect(byId.get('a3')?.status).toBe('cancelled');

    // 只有源头执行了；下游从未启动
    expect(executor.calls).toEqual(['s-source']);

    const events = eventBus.history({ taskId: 't-empty' });
    const cancelEvents = events.filter(e => e.type === 'agent.cancelled');
    expect(cancelEvents).toHaveLength(2);
    expect(cancelEvents.every(e => e.payload.reason === 'upstream_empty')).toBe(true);
  });

  it('上游有数据（count=5）→ 全链正常执行', async () => {
    const executor = new CountingExecutor({ 's-source': { count: 5 } });
    const registry = makeRegistry([{ field: 'count', op: 'eq', value: 0 }]);
    const scheduler = new DAGScheduler(executor as any, registry);

    const result = await scheduler.execute(chainPlan('t-nonempty'), 't-nonempty', 'u', 'goal');

    expect(result.success).toBe(true);
    for (const agent of result.results.values()) {
      expect(agent.status).toBe('completed');
    }
    expect(executor.calls).toEqual(['s-source', 's-filter', 's-post']);
  });
});
