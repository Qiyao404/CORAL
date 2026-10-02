import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-sched-cancel-'));
// 关键：必须在首次 import 调度器链（→ store → config → 打开数据库）之前设置，
// 让全局单例落到临时库，避免污染真实 data/coral.db
process.env.DATABASE_PATH = join(tmp, 'sched.db');

const { DAGScheduler } = await import('../../scheduler/dag-scheduler.js');
const { agentStore, closeDb } = await import('../../store/index.js');
const { eventBus } = await import('../../event/event-bus.js');
const { releaseAbortController } = await import('../../services/task-abort-registry.js');
import type { ExecutionPlan, SkillExecutionResult, SkillExecutionRequest } from '../../types/index.js';

afterAll(() => {
  // Windows 下必须先关连接才能删除库文件（EBUSY）
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

// ── 测试替身：可控的 SkillExecutor ──────────────────────────────

type Mode = 'fast' | 'hang-until-abort';

class MockExecutor {
  calls: SkillExecutionRequest[] = [];
  constructor(private mode: Mode) {}
  async execute(request: SkillExecutionRequest): Promise<SkillExecutionResult> {
    this.calls.push(request);
    if (this.mode === 'fast') {
      return {
        success: true,
        data: { done: true },
        meta: { durationMs: 1, skillVersion: '1', executionMode: 'llm_only', sandboxUsed: false },
      };
    }
    // 挂起直到 abortSignal 触发（模拟 LLM 调用/子进程被取消中止）
    return new Promise<SkillExecutionResult>((resolve, reject) => {
      const signal = request.context.abortSignal;
      const timer = setTimeout(() => {
        resolve({
          success: true,
          data: { done: true },
          meta: { durationMs: 10000, skillVersion: '1', executionMode: 'llm_only', sandboxUsed: false },
        });
      }, 10000);
      const onAbort = () => {
        clearTimeout(timer);
        const err = new Error('执行已取消');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}

function makePlan(taskId: string): ExecutionPlan {
  const agent = (agentId: string, dependsOn: string[]) => ({
    agentId,
    name: `Agent-${agentId}`,
    role: 'r',
    assignedSkills: ['noop-skill'],
    skillInputTemplates: { 'noop-skill': { x: 1 } },
    dependsOn,
    priority: 0,
    estimatedDurationMs: 1000,
  });
  return {
    planId: `plan-${taskId}`,
    taskId,
    version: 1,
    agents: [agent('a1', []), agent('a2', ['a1'])],
    edges: [{ from: 'a1', to: 'a2' }],
    createdAt: new Date().toISOString(),
  };
}

function makeScheduler(executor: MockExecutor): DAGScheduler {
  return new DAGScheduler(executor as any);
}

// ── 用例 ────────────────────────────────────────────────────────

describe('DAGScheduler 取消语义（M0-2 / A1 修复）', () => {
  it('正常路径不受影响：两节点链式全部完成', async () => {
    const executor = new MockExecutor('fast');
    const scheduler = makeScheduler(executor);
    const result = await scheduler.execute(makePlan('t-ok'), 't-ok', 'u', 'goal');

    expect(result.success).toBe(true);
    expect(result.cancelled).toBeUndefined();
    const statuses = [...result.results.values()].map(a => a.status);
    expect(statuses).toEqual(['completed', 'completed']);
    expect(executor.calls).toHaveLength(2);
  });

  it('执行中取消：在跑 Agent 标 cancelled（不重试），未启动 Agent 级联取消', async () => {
    const executor = new MockExecutor('hang-until-abort');
    const scheduler = makeScheduler(executor);
    const controller = new AbortController();

    const promise = scheduler.execute(makePlan('t-cancel'), 't-cancel', 'u', 'goal', undefined, controller.signal);
    setTimeout(() => controller.abort(), 100); // a1 挂起中触发取消

    const result = await promise;

    expect(result.cancelled).toBe(true);
    expect(result.success).toBe(false);

    // a1 被中止（1 次调用，绝不重试）；a2 从未启动
    expect(executor.calls).toHaveLength(1);
    // M0-3 后执行器收到的是联动的 attempt 信号（随任务取消而 aborted）
    expect(executor.calls[0].context.abortSignal?.aborted).toBe(true);

    const byId = new Map([...result.results.values()].map(a => [a.agentId, a]));
    expect(byId.get('a1')?.status).toBe('cancelled');
    expect(byId.get('a2')?.status).toBe('cancelled');

    // 事件语义：有 agent.cancelled，绝无 agent.failed
    const events = eventBus.history({ taskId: 't-cancel' });
    expect(events.some(e => e.type === 'agent.cancelled')).toBe(true);
    expect(events.some(e => e.type === 'agent.failed')).toBe(false);

    // 持久化同样落到 cancelled
    const stored = agentStore.find(a => a.taskId === 't-cancel');
    expect(stored.every(a => a.status === 'cancelled')).toBe(true);

    releaseAbortController('t-cancel');
  });

  it('预中止（abort 后才 execute）：一个 Agent 都不启动', async () => {
    const executor = new MockExecutor('hang-until-abort');
    const scheduler = makeScheduler(executor);
    const controller = new AbortController();
    controller.abort(); // 先取消再执行

    const result = await scheduler.execute(makePlan('t-pre'), 't-pre', 'u', 'goal', undefined, controller.signal);

    expect(result.cancelled).toBe(true);
    expect(executor.calls).toHaveLength(0);
    const statuses = [...result.results.values()].map(a => a.status);
    expect(statuses).toEqual(['cancelled', 'cancelled']);

    releaseAbortController('t-pre');
  });
});
