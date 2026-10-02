import { describe, it, expect } from 'vitest';
import { AgentLoop, type AgentLoopOptions, type LoopEvent, type LoopCheckpoint } from '../agent-loop.js';
import type { ChatRequest, ChatResponse } from '../../providers/types.js';
import type { Tool } from '../../tools/types.js';

/** 脚本化 LLM：按调用序号返回预设响应（或抛错） */
class ScriptedLLM {
  calls: ChatRequest[] = [];
  constructor(private script: Array<Partial<ChatResponse> | Error>) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    const item = this.script[this.calls.length - 1];
    if (item instanceof Error) throw item;
    return {
      content: item.content ?? '',
      toolCalls: item.toolCalls ?? [],
      usage: item.usage ?? { inputTokens: 100, outputTokens: 50 },
      stopReason: item.stopReason ?? 'end',
    };
  }
}

const toolCall = (id: string, name: string, input: any = {}) => ({ id, name, input });

function echoTool(name = 'echo', behavior?: (input: any) => any): Tool {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: { type: 'object' },
    source: 'builtin',
    permission: 'auto',
    invoke: async (input: any) => ({ ok: true, data: behavior ? behavior(input) : { echoed: input } }),
  };
}

function approvalTool(name = 'dangerous'): Tool {
  return {
    name,
    description: 'needs approval',
    inputSchema: { type: 'object' },
    source: 'builtin',
    permission: 'approval',
    invoke: async (input: any) => ({ ok: true, data: { ran: true, input } }),
  };
}

function harness(over: {
  llm: ScriptedLLM;
  tools?: Tool[];
  budget?: Partial<AgentLoopOptions['budget']>;
  approveTool?: AgentLoopOptions['approveTool'];
  signal?: AbortSignal;
  summarize?: (t: string) => Promise<string>;
  maxTotalChars?: number;
  keepRecent?: number;
}) {
  const events: LoopEvent[] = [];
  const checkpoints: LoopCheckpoint[] = [];
  const options: AgentLoopOptions = {
    runId: 'run-t',
    agentId: 'agent-t',
    goal: '测试目标',
    tools: over.tools ?? [echoTool()],
    budget: { maxSteps: 8, maxTokens: 1_000_000, ...over.budget },
    signal: over.signal ?? new AbortController().signal,
    onEvent: e => events.push(e),
    saveCheckpoint: cp => checkpoints.push(cp),
    approveTool: over.approveTool,
    summarize: over.summarize,
    maxTotalChars: over.maxTotalChars,
    keepRecent: over.keepRecent,
  };
  const loop = new AgentLoop(over.llm, options);
  return { loop, events, checkpoints, options };
}

describe('AgentLoop — 主循环语义（M1-3）', () => {
  it('happy path：1 轮工具 + 1 轮最终回答；消息序列与事件序列正确', async () => {
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c1', 'echo', { x: 1 })], content: '' },
      { stopReason: 'end', content: '任务完成' },
    ]);
    const { loop, events, checkpoints } = harness({ llm });

    const r = await loop.run();

    expect(r.status).toBe('completed');
    expect(r.finalContent).toBe('任务完成');
    expect(r.steps).toBe(2);
    expect(r.toolCalls).toBe(1);
    expect(r.tokensIn).toBe(200);

    // 消息序列：user → assistant(toolCalls) → tool → assistant(final)
    const roles = r.messages.map(m => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(r.messages[2].toolCallId).toBe('c1');
    expect(JSON.parse(r.messages[2].content).echoed).toEqual({ x: 1 });

    // 工具收到了完整系统提示与全部定义
    expect(llm.calls[0].system).toContain('CORAL');
    expect(llm.calls[0].tools?.[0].name).toBe('echo');
    expect(llm.calls[1].tools?.[0].name).toBe('echo');

    // 事件：每步 step_started/step_completed，工具 started/completed，checkpoint
    const types = events.map(e => e.type);
    expect(types).toContain('loop.step_started');
    expect(types).toContain('tool.call_started');
    expect(types).toContain('tool.call_completed');
    expect(types).toContain('checkpoint.created');
    expect(checkpoints).toHaveLength(2); // 每步一个
    expect(checkpoints[0].state.messages.length).toBe(3); // 工具轮结束时的快照
  });

  it('同轮多个工具调用按序执行，全部入历史', async () => {
    const order: string[] = [];
    const t1 = echoTool('first', i => { order.push('first'); return i; });
    const t2 = echoTool('second', i => { order.push('second'); return i; });
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('a', 'first'), toolCall('b', 'second')], content: '' },
      { stopReason: 'end', content: 'done' },
    ]);
    const { loop } = harness({ llm, tools: [t1, t2] });
    const r = await loop.run();

    expect(order).toEqual(['first', 'second']);
    expect(r.messages.filter(m => m.role === 'tool')).toHaveLength(2);
    expect(r.toolCalls).toBe(2);
  });

  it('工具失败 → 错误作为工具结果回传，循环继续', async () => {
    const failing: Tool = {
      name: 'boom', description: '', inputSchema: { type: 'object' }, source: 'builtin', permission: 'auto',
      invoke: async () => ({ ok: false, error: { code: 'X', message: '炸了', retryable: false } }),
    };
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c', 'boom')], content: '' },
      { stopReason: 'end', content: '工具失败但我看到了错误，汇报给用户' },
    ]);
    const { loop, events } = harness({ llm, tools: [failing] });
    const r = await loop.run();

    expect(r.status).toBe('completed');
    const toolMsg = r.messages.find(m => m.role === 'tool')!;
    expect(JSON.parse(toolMsg.content).error.message).toBe('炸了');
    expect(events.some(e => e.type === 'tool.call_failed')).toBe(true);
  });

  it('工具抛异常 → TOOL_CRASHED 兜底，循环不中断', async () => {
    const crashing: Tool = {
      name: 'crash', description: '', inputSchema: { type: 'object' }, source: 'builtin', permission: 'auto',
      invoke: async () => { throw new Error('unexpected crash'); },
    };
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c', 'crash')], content: '' },
      { stopReason: 'end', content: '恢复并总结' },
    ]);
    const { loop } = harness({ llm, tools: [crashing] });
    const r = await loop.run();
    expect(r.status).toBe('completed');
    expect(JSON.parse(r.messages.find(m => m.role === 'tool')!.content).error.code).toBe('TOOL_CRASHED');
  });

  it('未知工具名 → TOOL_NOT_FOUND 结果（模型可见）', async () => {
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c', 'ghost_tool')], content: '' },
      { stopReason: 'end', content: 'ok' },
    ]);
    const { loop } = harness({ llm, tools: [echoTool()] });
    const r = await loop.run();
    expect(JSON.parse(r.messages.find(m => m.role === 'tool')!.content).error.code).toBe('TOOL_NOT_FOUND');
  });

  it('审批工具：未接审批回调 → 安全默认拒绝；接了且批准 → 执行', async () => {
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c', 'dangerous')], content: '' },
      { stopReason: 'end', content: '被拒后收尾' },
    ]);
    const denied = await harness({ llm, tools: [approvalTool()] }).loop.run();
    expect(JSON.parse(denied.messages.find(m => m.role === 'tool')!.content).error.code).toBe('APPROVAL_DENIED');

    const llm2 = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c', 'dangerous')], content: '' },
      { stopReason: 'end', content: '执行后收尾' },
    ]);
    const approved = await harness({
      llm: llm2,
      tools: [approvalTool()],
      approveTool: async () => true,
    }).loop.run();
    expect(JSON.parse(approved.messages.find(m => m.role === 'tool')!.content).ran).toBe(true);
  });

  it('取消（LLM 调用中 AbortError）→ status cancelled + checkpoint + 事件', async () => {
    const abortErr = new Error('cancelled');
    abortErr.name = 'AbortError';
    const llm = new ScriptedLLM([abortErr]);
    const { loop, events, checkpoints } = harness({ llm });
    const r = await loop.run();

    expect(r.status).toBe('cancelled');
    expect(r.error).toBe('已取消');
    expect(events.some(e => e.type === 'loop.cancelled')).toBe(true);
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
  });

  it('取消（信号预先置位）→ 直接 cancelled', async () => {
    const c = new AbortController();
    c.abort();
    const llm = new ScriptedLLM([]);
    const r = await harness({ llm, signal: c.signal }).loop.run();
    expect(r.status).toBe('cancelled');
  });

  it('maxSteps 耗尽 → 优雅收尾：最后一次无工具调用生成总结，status budget_exceeded', async () => {
    const toolRound = () => ({ stopReason: 'tool_use', toolCalls: [toolCall('c', 'echo')], content: '' });
    const llm = new ScriptedLLM([
      toolRound(), toolRound(),                          // maxSteps=2
      { stopReason: 'end', content: 'BUDGET-SUMMARY' }, // 收尾调用
    ]);
    const { loop, events } = harness({ llm, budget: { maxSteps: 2 } });
    const r = await loop.run();

    expect(r.status).toBe('budget_exceeded');
    expect(r.finalContent).toBe('BUDGET-SUMMARY');
    expect(r.steps).toBe(2);
    // 收尾调用不带 tools
    expect(llm.calls[2].tools).toBeUndefined();
    expect(llm.calls[2].messages.at(-1)!.content).toContain('Budget limit');
    expect(events.some(e => e.type === 'loop.budget_exceeded')).toBe(true);
  });

  it('maxTokens 耗尽 → 同样优雅收尾', async () => {
    const toolRound = () => ({ stopReason: 'tool_use', toolCalls: [toolCall('c', 'echo')], content: '' });
    const llm = new ScriptedLLM([
      toolRound(),
      { usage: { inputTokens: 500, outputTokens: 400 }, stopReason: 'tool_use', toolCalls: [toolCall('c2', 'echo')], content: '' },
      { stopReason: 'end', content: 'TOKEN-SUMMARY' },
    ]);
    const { loop } = harness({ llm, budget: { maxTokens: 900 } });
    const r = await loop.run();
    expect(r.status).toBe('budget_exceeded');
    expect(r.finalContent).toBe('TOKEN-SUMMARY');
  });

  it('上下文压缩触发：超限历史被压缩后才进入 LLM 调用', async () => {
    const bigTool = echoTool('big', () => ({ blob: 'B'.repeat(5000) }));
    const toolRound = (n: string) => ({ stopReason: 'tool_use', toolCalls: [toolCall(n, 'big')], content: '' });
    const llm = new ScriptedLLM([
      toolRound('c1'), toolRound('c2'), toolRound('c3'),
      { stopReason: 'end', content: 'done' },
    ]);
    let summaryCalled = 0;
    const { loop, events } = harness({
      llm,
      tools: [bigTool],
      maxTotalChars: 8000,
      keepRecent: 2,
      summarize: async t => { summaryCalled++; return `压缩摘要#${summaryCalled}(${t.length}字)`; },
    });
    const r = await loop.run();

    expect(r.status).toBe('completed');
    expect(summaryCalled).toBeGreaterThanOrEqual(1);
    expect(events.some(e => e.type === 'loop.context_compressed')).toBe(true);
    // 第 4 次调用（最终回答）的消息里应能找到摘要痕迹
    const lastCall = llm.calls[3];
    expect(lastCall.messages.some(m => m.content.includes('压缩摘要#') || m.content.includes('Earlier conversation summary'))).toBe(true);
  });

  it('事件消费者抛异常不影响循环', async () => {
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c', 'echo')], content: '' },
      { stopReason: 'end', content: 'ok' },
    ]);
    const options: AgentLoopOptions = {
      runId: 'r', agentId: 'a', goal: 'g', tools: [echoTool()],
      budget: { maxSteps: 5, maxTokens: 1e9 },
      signal: new AbortController().signal,
      onEvent: () => { throw new Error('consumer boom'); },
    };
    const r = await new AgentLoop(llm, options).run();
    expect(r.status).toBe('completed');
  });

  it('extraSystem 注入系统提示；workspaceDir 注入提示', async () => {
    const llm = new ScriptedLLM([{ stopReason: 'end', content: 'ok' }]);
    const options: AgentLoopOptions = {
      runId: 'r', agentId: 'a', goal: 'g', tools: [],
      budget: { maxSteps: 5, maxTokens: 1e9 },
      signal: new AbortController().signal,
      onEvent: () => {},
      extraSystem: '公司画像：专注中试平台',
      workspaceDir: 'D:/ws',
    };
    await new AgentLoop(llm, options).run();
    expect(llm.calls[0].system).toContain('公司画像');
    expect(llm.calls[0].system).toContain('workspace');
  });
});
