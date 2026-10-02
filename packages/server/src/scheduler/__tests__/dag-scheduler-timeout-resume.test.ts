import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-resume-'));
// 超时 400ms + 1 次超时重试（隔离真实库 + 加速）
process.env.DATABASE_PATH = join(tmp, 'sched.db');
process.env.AGENT_DEFAULT_TIMEOUT_MS = '400';
process.env.AGENT_MAX_RETRIES = '1';

const { DAGScheduler } = await import('../../scheduler/dag-scheduler.js');
const { closeDb } = await import('../../store/index.js');
import type { ExecutionPlan, SkillExecutionResult, SkillExecutionRequest } from '../../types/index.js';

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * 按 skillName 行为分派：fast 立即成功；hang 挂到 10s（只被超时 abort 打断）。
 */
class ResumeExecutor {
  calls: string[] = [];
  async execute(request: SkillExecutionRequest): Promise<SkillExecutionResult> {
    this.calls.push(request.skillName);
    if (request.skillName === 's-fast') {
      return {
        success: true,
        data: { fast: true },
        meta: { durationMs: 1, skillVersion: '1', executionMode: 'llm_only', sandboxUsed: false },
      };
    }
    return new Promise((_resolve, reject) => {
      const signal = request.context.abortSignal;
      const timer = setTimeout(() => _resolve({
        success: true, data: {},
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

describe('超时重试从失败 Skill 恢复（M0-4：已完成的 Skill 绝不重跑）', () => {
  it('两轮尝试都超时：s-fast 全程只执行 1 次，s-hang 每轮各 1 次，最终 AGENT_TIMEOUT', async () => {
    const executor = new ResumeExecutor();
    const scheduler = new DAGScheduler(executor as any);

    const plan: ExecutionPlan = {
      planId: 'p-resume',
      taskId: 't-resume',
      version: 1,
      agents: [
        {
          agentId: 'a1',
          name: '恢复测试',
          role: 'r',
          assignedSkills: ['s-fast', 's-hang'],
          skillInputTemplates: { 's-fast': {}, 's-hang': {} },
          dependsOn: [],
          priority: 0,
          estimatedDurationMs: 1000,
        },
      ],
      edges: [],
      createdAt: new Date().toISOString(),
    };

    const result = await scheduler.execute(plan, 't-resume', 'u', 'goal');

    // 两轮均超时 → 最终 AGENT_TIMEOUT 失败
    expect(result.success).toBe(false);
    expect(result.cancelled).toBeFalsy();
    const agent = result.results.get('a1')!;
    expect(agent.status).toBe('failed');
    expect(agent.error?.code).toBe('AGENT_TIMEOUT');
    expect(agent.retryCount).toBe(2); // 1 次初始 + 1 次超时重试

    // 核心断言：已完成的 s-fast 从未重跑（v1 会把两个 Skill 全部重跑 → LLM 费用翻倍）
    const fastCalls = executor.calls.filter(s => s === 's-fast').length;
    const hangCalls = executor.calls.filter(s => s === 's-hang').length;
    expect(fastCalls).toBe(1);
    expect(hangCalls).toBe(2); // 每轮各一次
  }, 15000);
});
