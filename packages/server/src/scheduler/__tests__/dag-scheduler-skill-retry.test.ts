import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-skill-retry-'));
// 必须在首次 import 调度器链之前设置（隔离真实库；AGENT_MAX_RETRIES 默认 2）
process.env.DATABASE_PATH = join(tmp, 'sched.db');

const { DAGScheduler } = await import('../../scheduler/dag-scheduler.js');
const { agentStore, closeDb } = await import('../../store/index.js');
const { eventBus } = await import('../../event/event-bus.js');
import type { ExecutionPlan, SkillExecutionResult, SkillExecutionRequest } from '../../types/index.js';

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

interface Script {
  /** 每次调用按序返回；'flaky-ok' = 失败 n-1 次（retryable）后成功 */
  behavior: 'ok' | 'flaky' | 'permanent-fail';
  /** flaky 场景：前 failTimes 次返回可重试失败 */
  failTimes?: number;
}

/** 脚本化 MockExecutor：按 skillName 的行为定义返回结果 */
class ScriptedExecutor {
  calls: Array<{ skillName: string; attemptSignal?: AbortSignal }> = [];
  constructor(private script: Record<string, Script>) {}

  private okResult(): SkillExecutionResult {
    return {
      success: true,
      data: { done: true },
      meta: { durationMs: 1, skillVersion: '1', executionMode: 'llm_only', sandboxUsed: false },
    };
  }

  private failResult(code: string, message: string, retryable: boolean): SkillExecutionResult {
    return {
      success: false,
      error: { code, message, retryable },
      meta: { durationMs: 1, skillVersion: '1', executionMode: 'llm_only', sandboxUsed: false },
    };
  }

  async execute(request: SkillExecutionRequest): Promise<SkillExecutionResult> {
    const conf = this.script[request.skillName] || { behavior: 'ok' as const };
    this.calls.push({ skillName: request.skillName, attemptSignal: request.context.abortSignal });

    if (conf.behavior === 'ok') return this.okResult();
    if (conf.behavior === 'permanent-fail') {
      return this.failResult('SCRIPT_LOGICAL_ERROR', '确定性错误（如参数不合法）', false);
    }
    // flaky：本 skill 的第几次调用
    const nth = this.calls.filter(c => c.skillName === request.skillName).length;
    if (nth <= (conf.failTimes ?? 1)) {
      return this.failResult('SCRIPT_EXIT_NONZERO', `瞬时失败 #${nth}`, true);
    }
    return this.okResult();
  }
}

function makePlan(taskId: string, skills: string[]): ExecutionPlan {
  return {
    planId: `plan-${taskId}`,
    taskId,
    version: 1,
    agents: [
      {
        agentId: 'a1',
        name: 'Agent-1',
        role: 'r',
        assignedSkills: skills,
        skillInputTemplates: Object.fromEntries(skills.map(s => [s, { x: 1 }])),
        dependsOn: [],
        priority: 0,
        estimatedDurationMs: 1000,
      },
    ],
    edges: [],
    createdAt: new Date().toISOString(),
  };
}

describe('DAGScheduler Skill 粒度重试（M0-4 / A5 后半修复）', () => {
  it('flaky Skill 重试 2 次后成功：只重试该 Skill，前序 Skill 绝不重跑', async () => {
    const executor = new ScriptedExecutor({
      's1-first': { behavior: 'ok' },
      's2-flaky': { behavior: 'flaky', failTimes: 2 },
    });
    const scheduler = new DAGScheduler(executor as any);

    const result = await scheduler.execute(makePlan('t-flaky', ['s1-first', 's2-flaky']), 't-flaky', 'u', 'goal');

    expect(result.success).toBe(true);
    const agent = result.results.get('a1')!;
    expect(agent.status).toBe('completed');

    // 核心：s1 只执行 1 次；s2 执行 3 次（首次 + 2 次重试）
    const s1Calls = executor.calls.filter(c => c.skillName === 's1-first').length;
    const s2Calls = executor.calls.filter(c => c.skillName === 's2-flaky').length;
    expect(s1Calls).toBe(1);
    expect(s2Calls).toBe(3);
  }, 10000);

  it('不可重试错误（retryable=false）：仅 1 次尝试，Agent 直接失败并透传错误码', async () => {
    const executor = new ScriptedExecutor({
      's1-first': { behavior: 'ok' },
      's2-bad': { behavior: 'permanent-fail' },
    });
    const scheduler = new DAGScheduler(executor as any);

    const result = await scheduler.execute(makePlan('t-perm', ['s1-first', 's2-bad']), 't-perm', 'u', 'goal');

    expect(result.success).toBe(false);
    expect(result.cancelled).toBeFalsy();

    const agent = result.results.get('a1')!;
    expect(agent.status).toBe('failed');
    expect(agent.error?.code).toBe('SCRIPT_LOGICAL_ERROR'); // Skill 错误码透传
    expect(agent.error?.retryable).toBe(false);

    // 不可重试 → s2 只调了 1 次；v1 在这里会把两个 Skill 全部重跑 2 遍
    expect(executor.calls.filter(c => c.skillName === 's2-bad')).toHaveLength(1);
    expect(executor.calls.filter(c => c.skillName === 's1-first')).toHaveLength(1);

    const stored = agentStore.find(a => a.taskId === 't-perm');
    expect(stored[0]?.error?.code).toBe('SCRIPT_LOGICAL_ERROR');

    const events = eventBus.history({ taskId: 't-perm' });
    expect(events.some(e => e.type === 'agent.failed')).toBe(true);
  });

  it('可重试错误耗尽重试次数：Skill 尝试 maxRetries+1 次后 Agent 失败', async () => {
    const executor = new ScriptedExecutor({
      's-always-down': { behavior: 'flaky', failTimes: 99 },
    });
    const scheduler = new DAGScheduler(executor as any);

    const result = await scheduler.execute(makePlan('t-exhaust', ['s-always-down']), 't-exhaust', 'u', 'goal');

    expect(result.success).toBe(false);
    expect(result.results.get('a1')?.status).toBe('failed');
    expect(result.results.get('a1')?.error?.code).toBe('SCRIPT_EXIT_NONZERO');
    // 默认 agentMaxRetries=2 → 首次 + 2 次重试
    expect(executor.calls).toHaveLength(3);
  }, 10000);
});
