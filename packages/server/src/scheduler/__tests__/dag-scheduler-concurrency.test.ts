import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-conc-'));
// 限制并发上限为 2，使并发约束可观测
process.env.DATABASE_PATH = join(tmp, 'sched.db');
process.env.MAX_CONCURRENT_AGENTS_PER_TASK = '2';

const { DAGScheduler } = await import('../../scheduler/dag-scheduler.js');
const { closeDb } = await import('../../store/index.js');
import type { ExecutionPlan, SkillExecutionResult, SkillExecutionRequest } from '../../types/index.js';

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/** 慢速成功执行器：150ms 后返回；实时统计同时在跑的数量 */
class SlowExecutor {
  calls = 0;
  active = 0;
  maxActive = 0;
  async execute(request: SkillExecutionRequest): Promise<SkillExecutionResult> {
    this.calls++;
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise(r => setTimeout(r, 150));
    this.active--;
    return {
      success: true,
      data: { done: request.skillName },
      meta: { durationMs: 150, skillVersion: '1', executionMode: 'llm_only', sandboxUsed: false },
    };
  }
}

function fanoutPlan(taskId: string, count: number): ExecutionPlan {
  return {
    planId: `plan-${taskId}`,
    taskId,
    version: 1,
    agents: Array.from({ length: count }, (_, i) => ({
      agentId: `a${i + 1}`,
      name: `Agent-${i + 1}`,
      role: 'r',
      assignedSkills: [`s${i + 1}`],
      skillInputTemplates: { [`s${i + 1}`]: { x: 1 } },
      dependsOn: [],
      priority: 0,
      estimatedDurationMs: 1000,
    })),
    edges: [],
    createdAt: new Date().toISOString(),
  };
}

describe('DAGScheduler 并发上限（M0-7：MAX_CONCURRENT_AGENTS_PER_TASK=2）', () => {
  it('3 个独立 Agent：同一时刻最多 2 个在跑，全部完成', async () => {
    const executor = new SlowExecutor();
    const scheduler = new DAGScheduler(executor as any);

    const result = await scheduler.execute(fanoutPlan('t-conc', 3), 't-conc', 'u', 'goal');

    expect(result.success).toBe(true);
    expect(executor.calls).toBe(3);
    // 并发被限制在 2（3 个就绪节点、上限 2 → 必然出现恰好 2 并发的窗口）
    expect(executor.maxActive).toBe(2);
    for (const agent of result.results.values()) {
      expect(agent.status).toBe('completed');
    }
  }, 15000);
});
