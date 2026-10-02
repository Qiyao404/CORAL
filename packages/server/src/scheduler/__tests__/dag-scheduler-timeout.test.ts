import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-sched-timeout-'));
// 关键：必须在首次 import 调度器链之前设置（隔离真实库 + 缩短超时与重试以加速用例）
process.env.DATABASE_PATH = join(tmp, 'sched.db');
process.env.AGENT_DEFAULT_TIMEOUT_MS = '300'; // Agent 级超时压到 300ms
process.env.AGENT_MAX_RETRIES = '1';          // 1 次重试（共 2 次尝试）

const { DAGScheduler } = await import('../../scheduler/dag-scheduler.js');
const { agentStore, closeDb } = await import('../../store/index.js');
const { eventBus } = await import('../../event/event-bus.js');
import type { ExecutionPlan, SkillExecutionResult, SkillExecutionRequest } from '../../types/index.js';

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/** 挂起直到 abortSignal 触发（模拟 LLM 调用/子进程被超时中止） */
class HangExecutor {
  calls: SkillExecutionRequest[] = [];
  async execute(request: SkillExecutionRequest): Promise<SkillExecutionResult> {
    this.calls.push(request);
    return new Promise((_resolve, reject) => {
      const signal = request.context.abortSignal;
      const timer = setTimeout(() => _resolve({
        success: true,
        data: { done: true },
        meta: { durationMs: 10000, skillVersion: '1', executionMode: 'llm_only', sandboxUsed: false },
      }), 10000);
      const onAbort = () => {
        clearTimeout(timer);
        const err = new Error('aborted');
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
  return {
    planId: `plan-${taskId}`,
    taskId,
    version: 1,
    agents: [
      {
        agentId: 'a1',
        name: '慢 Agent',
        role: 'r',
        assignedSkills: ['noop-skill'],
        skillInputTemplates: { 'noop-skill': {} },
        dependsOn: [],
        priority: 0,
        estimatedDurationMs: 1000,
      },
    ],
    edges: [],
    createdAt: new Date().toISOString(),
  };
}

describe('DAGScheduler Agent 级超时（M0-3 / A2 修复）', () => {
  it('超时 → 中止在跑工作 → AGENT_TIMEOUT 失败（含 1 次重试），不是 cancelled', async () => {
    const executor = new HangExecutor();
    const scheduler = new DAGScheduler(executor as any);

    const result = await scheduler.execute(makePlan('t-timeout'), 't-timeout', 'u', 'goal');

    // 任务未被取消（无外层信号），语义是失败
    expect(result.cancelled).toBeFalsy();
    expect(result.success).toBe(false);

    const agent = result.results.get('a1')!;
    expect(agent.status).toBe('failed');
    expect(agent.error?.code).toBe('AGENT_TIMEOUT');
    expect(agent.error?.message).toContain('超时');

    // 2 次尝试：初始 + 1 次重试（每次尝试有独立 deadline，均超时）
    expect(executor.calls).toHaveLength(2);
    // 下游收到的信号在两次尝试中各自独立
    expect(executor.calls[0].context.abortSignal).not.toBe(executor.calls[1].context.abortSignal);

    // 事件语义：agent.failed（超时），绝无 agent.cancelled
    const events = eventBus.history({ taskId: 't-timeout' });
    expect(events.some(e => e.type === 'agent.failed')).toBe(true);
    expect(events.some(e => e.type === 'agent.cancelled')).toBe(false);

    // 持久化同样 failed + AGENT_TIMEOUT
    const stored = agentStore.find(a => a.taskId === 't-timeout');
    expect(stored[0]?.status).toBe('failed');
    expect(stored[0]?.error?.code).toBe('AGENT_TIMEOUT');
  }, 15000);
});
