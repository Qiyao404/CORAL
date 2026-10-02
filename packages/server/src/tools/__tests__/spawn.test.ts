import { describe, it, expect } from 'vitest';
import { makeSpawnTool, type SpawnDeps } from '../builtin/spawn.js';
import { makeToolContext, type Tool } from '../types.js';
import type { ChatRequest, ChatResponse } from '../../providers/types.js';

/** 全局脚本 LLM：所有循环（父调用方直接 invoke 工具，这里只有子循环用）按序消费 */
class ScriptedLLM {
  calls: Array<{ req: ChatRequest; agentIdHint?: string }> = [];
  constructor(private script: Array<Partial<ChatResponse> | Error>) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push({ req });
    const item = this.script[this.calls.length - 1];
    if (item instanceof Error) throw item;
    return {
      content: item.content ?? '',
      toolCalls: item.toolCalls ?? [],
      usage: item.usage ?? { inputTokens: 10, outputTokens: 5 },
      stopReason: item.stopReason ?? 'end',
    };
  }
}

const echoTool = (name: string): Tool => ({
  name,
  description: `test ${name}`,
  inputSchema: { type: 'object' },
  source: 'builtin',
  permission: 'auto',
  invoke: async (input: any) => ({ ok: true, data: { from: name, input } }),
});

function deps(over: Partial<SpawnDeps> & { llm: SpawnDeps['llm'] }): SpawnDeps {
  return {
    baseTools: [echoTool('alpha'), echoTool('beta')],
    depth: 0,
    maxDepth: 2,
    spawnCounter: { count: 0 },
    maxSpawnsPerRun: 8,
    subBudget: { defaultSteps: 5, defaultTokens: 50000, maxSteps: 10, maxTokens: 100000 },
    ...over,
  };
}

const ctx = (events: any[] = [], signal?: AbortSignal) =>
  makeToolContext({ runId: 'run-t', emit: ev => events.push(ev), signal });

describe('agent_spawn 工具（M1-4）', () => {
  it('子 agent 独立执行：事件带 sub agentId、结果回传最终答案', async () => {
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [{ id: 's1', name: 'alpha', input: { q: 1 } }], content: '' },
      { stopReason: 'end', content: '子任务答案：42' },
    ]);
    const events: any[] = [];
    const tool = makeSpawnTool(deps({ llm }));

    const r = await tool.invoke({ goal: '计算答案' }, ctx(events));

    expect(r.ok).toBe(true);
    expect((r.data as any).finalContent).toBe('子任务答案：42');
    expect((r.data as any).steps).toBe(2);

    // 生命周期事件 + 子循环事件全部带 sub agentId
    expect(events[0].type).toBe('subagent.started');
    expect(events[0].payload.agentId).toMatch(/^sub-1-/);
    const loopEvents = events.filter(e => e.type.startsWith('loop.'));
    expect(loopEvents.every(e => e.payload.agentId.startsWith('sub-1-'))).toBe(true);
    expect(events.at(-1)!.type).toBe('subagent.completed');

    // 子循环的工具请求：默认继承全部基础工具 + 下一代 spawn（depth1 < maxDepth2）
    const subReq = llm.calls[0].req;
    const names = (subReq.tools ?? []).map(t => t.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).toContain('agent_spawn');
    // 子代理系统提示包含 SUB-AGENT 指引
    expect(subReq.system).toContain('SUB-AGENT');
  });

  it('工具子集：按名筛选生效；请求不存在的工具 → 明确报错并列出可用集', async () => {
    const llm = new ScriptedLLM([{ stopReason: 'end', content: '只用了 alpha' }]);
    const tool = makeSpawnTool(deps({ llm }));

    const ok = await tool.invoke({ goal: 'g', tools: ['alpha'] }, ctx());
    expect(ok.ok).toBe(true);
    const names = (llm.calls[0].req.tools ?? []).map(t => t.name);
    expect(names).toEqual(['alpha', 'agent_spawn']); // 子集 + 下一代 spawn

    const bad = await tool.invoke({ goal: 'g', tools: ['alpha', 'nuclear_launch'] }, ctx());
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('BAD_TOOLS');
    expect(bad.error?.message).toContain('nuclear_launch');
    expect(bad.error?.message).toContain('beta');
  });

  it('深度封顶：depth=2 的 spawn 工具仍可执行，但其子循环不再配备 agent_spawn', async () => {
    const llm = new ScriptedLLM([{ stopReason: 'end', content: '孙代回答' }]);
    // depth=2（孙代循环持有的工具）→ childDepth=3 不再 < maxDepth
    const tool = makeSpawnTool(deps({ llm, depth: 2 }));
    const r = await tool.invoke({ goal: 'g' }, ctx());
    expect(r.ok).toBe(true);
    const names = (llm.calls[0].req.tools ?? []).map(t => t.name);
    expect(names).not.toContain('agent_spawn');
    expect(events_agentId_prefix(r)).toMatch(/^sub-3-/);
  });

  it('spawn 限额：超出 maxSpawnsPerRun → SPAWN_LIMIT', async () => {
    const llm = new ScriptedLLM([]);
    const counter = { count: 8 };
    const tool = makeSpawnTool(deps({ llm, spawnCounter: counter, maxSpawnsPerRun: 8 }));
    const r = await tool.invoke({ goal: 'g' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SPAWN_LIMIT');
  });

  it('预算钳制：请求超限被压到上限；max_steps=1 时子代理单轮后优雅收尾', async () => {
    const toolRound = () => ({ stopReason: 'tool_use' as const, toolCalls: [{ id: 'c', name: 'alpha', input: {} }], content: '' });
    // 用例 A：请求 999 → 钳到上限 10（通过 started 事件里的 budget 观测）
    const llmA = new ScriptedLLM([{ stopReason: 'end', content: 'ok' }]);
    const eventsA: any[] = [];
    await makeSpawnTool(deps({ llm: llmA })).invoke(
      { goal: 'g', max_steps: 999, max_tokens: 999999999 },
      ctx(eventsA)
    );
    const budgetA = eventsA.find(e => e.type === 'subagent.started')!.payload.budget;
    expect(budgetA.maxSteps).toBe(10);   // subBudget.maxSteps
    expect(budgetA.maxTokens).toBe(100000);

    // 用例 B：max_steps=1 → 单轮工具 + 收尾调用
    const llm = new ScriptedLLM([
      toolRound(),
      { stopReason: 'end', content: '收尾' },
    ]);
    const tool = makeSpawnTool(deps({ llm }));
    const r = await tool.invoke({ goal: 'g', max_steps: 1 }, ctx());

    expect(r.ok).toBe(true);
    expect((r.data as any).status).toBe('budget_exceeded');
    expect(llm.calls.length).toBe(2);
  });

  it('取消级联：signal 中止 → 子循环 cancelled → CANCELLED 结果 + subagent.failed', async () => {
    const llm = new ScriptedLLM([]);
    llm.chat = async (req: any) => {
      await new Promise((_, rej) => {
        req.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          rej(e);
        });
      });
      throw new Error('unreachable');
    };
    const events: any[] = [];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100); // 子任务挂起 100ms 后取消
    const tool = makeSpawnTool(deps({ llm }));
    const r = await tool.invoke({ goal: '长任务' }, ctx(events, controller.signal));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('CANCELLED');
    expect(events.some(e => e.type === 'subagent.failed' && e.payload.status === 'cancelled')).toBe(true);
  }, 10000);

  it('goal 校验：空/超长 → BAD_INPUT', async () => {
    const tool = makeSpawnTool(deps({ llm: new ScriptedLLM([]) }));
    expect((await tool.invoke({ goal: '' }, ctx())).error?.code).toBe('BAD_INPUT');
    expect((await tool.invoke({ goal: 'x'.repeat(10001) }, ctx())).error?.code).toBe('BAD_INPUT');
  });
});

function events_agentId_prefix(r: any): string {
  return (r.data as any).finalContent ? 'sub-3-' : 'sub-?';
}
