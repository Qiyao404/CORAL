import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-plan-'));
process.env.DATABASE_PATH = join(tmp, 'plan.db');

const { PlanningEngine } = await import('../../planning/planning-engine.js');
const { llmClient } = await import('../../services/llm-client.js');
const { closeDb } = await import('../../store/index.js');

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/** 最小 registry 替身：规划只依赖 listAvailable / getByName */
function makeRegistry(): any {
  return {
    listAvailable: () => [
      {
        name: 'summarize-document',
        description: '文档摘要',
        domain: 'general',
        capabilities: [],
        inputKeys: ['text'],
        outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
        executionMode: 'llm_only',
        consumesCompanyProfile: false,
        tags: [],
        defaultInput: undefined,
        emptyWhen: undefined,
      },
    ],
    getByName: (name: string) => (name === 'summarize-document' ? { name } : null),
  };
}

const engine = new PlanningEngine(makeRegistry());

/** 替换 llmClient.complete（planning-engine 用的是同一个单例） */
function stubComplete(fn: (messages: any[], options?: any) => Promise<any>): void {
  (llmClient as any).complete = fn;
}

const VALID_PLAN = JSON.stringify({
  reasoning: '单技能直接执行',
  agents: [
    {
      agentId: 'a1',
      name: '摘要智能体',
      role: 'r',
      assignedSkills: ['summarize-document'],
      skillInputTemplates: { 'summarize-document': { text: 'goal' } },
      dependsOn: [],
      priority: 0,
      estimatedDurationMs: 1000,
    },
  ],
  edges: [],
});

describe('PlanningEngine 错误透明化（P3 加固）', () => {
  it('LLM 返回非 JSON → 明确报错并附原始输出片段，绝不静默降级', async () => {
    stubComplete(async () => ({ content: '抱歉，我无法输出 JSON……', tokensUsed: 0 }));

    await expect(engine.plan('t-badjson', '目标')).rejects.toThrow(/解析失败.*无法输出 JSON/s);
  });

  it('LLM 返回带循环依赖的计划 → 明确报错，绝不静默降级', async () => {
    stubComplete(async () => ({
      content: JSON.stringify({
        agents: [
          { agentId: 'a1', assignedSkills: ['summarize-document'], dependsOn: ['a2'], skillInputTemplates: {} },
          { agentId: 'a2', assignedSkills: ['summarize-document'], dependsOn: ['a1'], skillInputTemplates: {} },
        ],
        edges: [
          { from: 'a1', to: 'a2' },
          { from: 'a2', to: 'a1' },
        ],
      }),
      tokensUsed: 0,
    }));

    await expect(engine.plan('t-cycle', '目标')).rejects.toThrow(/循环依赖/);
  });

  it('传输类错误（网络断开）→ 仍然降级为 fallback 计划（原设计保留）', async () => {
    stubComplete(async () => { throw new Error('Connection error.'); });

    const plan = await engine.plan('t-transport', '目标');
    expect(plan.plannerModel).toBe('fallback');
    expect(plan.agents).toHaveLength(1);
  });

  it('正常路径：合法 JSON → 计划生成，模型名非 fallback', async () => {
    stubComplete(async () => ({ content: VALID_PLAN, tokensUsed: 10 }));

    const plan = await engine.plan('t-ok', '目标');
    expect(plan.agents).toHaveLength(1);
    expect(plan.agents[0].assignedSkills).toEqual(['summarize-document']);
    expect(plan.plannerModel).not.toBe('fallback');
  });
});
