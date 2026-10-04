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

  it('REG-17：narration 续跑 — 过渡话不是最终回答，循环继续直到真答案', async () => {
    const llm = new ScriptedLLM([
      // 第 1 轮：调一个工具（建立多步语境）
      { stopReason: 'tool_use', toolCalls: [toolCall('c1', 'echo')], content: '' },
      // 第 2 轮：只回过渡话（用户实测的 fork 场景 — 曾被误判为最终回答）
      { stopReason: 'end', content: "Now I'll write the document generator." },
      // 第 3 轮：真正的最终回答
      { stopReason: 'end', content: '文档已生成：总结.docx' },
    ]);
    const { loop, events } = harness({ llm });
    const r = await loop.run();

    expect(r.status).toBe('completed');
    expect(r.steps).toBe(3); // 没有提前收尾
    expect(r.finalContent).toBe('文档已生成：总结.docx');
    expect(events.some(e => e.type === 'loop.narration_continued')).toBe(true);
  });

  it('REG-17：真正的短回答（如"完成"）不被续跑 — 直接收尾', async () => {
    const llm = new ScriptedLLM([
      { stopReason: 'end', content: '完成' },
    ]);
    const { loop, events } = harness({ llm });
    const r = await loop.run();
    expect(r.status).toBe('completed');
    expect(r.steps).toBe(1);
    expect(events.some(e => e.type === 'loop.narration_continued')).toBe(false);
  });

  it('REG-17：narration 续跑上限 2 次 — 模型连续耍嘴皮时不无限循环', async () => {
    const llm = new ScriptedLLM([
      { stopReason: 'end', content: "Let me check that." },
      { stopReason: 'end', content: "Now I'll do it." },
      { stopReason: 'end', content: "Next I'll try again." },
      { stopReason: 'end', content: "I'll keep going." }, // 超过 NARRATION_MAX → 收尾
    ]);
    const { loop } = harness({ llm });
    const r = await loop.run();
    expect(r.status).toBe('completed');
    // NARRATION_MAX=2：第 1、2 次续跑，第 3 次按最终回答收尾（防无限循环）
    expect(r.steps).toBe(3);
    expect(r.finalContent).toBe("Next I'll try again.");
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

describe('AgentLoop — todo 清单保障（可观测性）', () => {
  const todoTool = (): Tool => ({
    name: 'todo_write',
    description: 'write todos',
    inputSchema: { type: 'object' },
    source: 'builtin',
    permission: 'auto',
    invoke: async (input: any) => ({ ok: true, data: { todos: input.todos ?? [] } }),
  });

  it('模型跳过 todo_write 连用 2+ 工具 → 下轮注入一次性提醒 + loop.todo_reminder 事件', async () => {
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('a', 'echo'), toolCall('b', 'echo')], content: '' },
      { stopReason: 'tool_use', toolCalls: [toolCall('c', 'todo_write', { todos: [{ content: 'x', status: 'in_progress' }] })], content: '' },
      { stopReason: 'end', content: 'done' },
    ]);
    const { loop, events } = harness({ llm, tools: [echoTool(), todoTool()] });
    const r = await loop.run();

    expect(r.status).toBe('completed');
    // 第 2 次 LLM 调用可见一次性提醒（ScriptedLLM 持引用，数组会继续增长 → 按内容定位）
    const reminderMsg = llm.calls[1].messages.find(m => m.content?.includes('[system] You are working'))!;
    expect(reminderMsg?.role).toBe('user');
    expect(reminderMsg.content).toContain('todo_write');
    expect(events.some(e => e.type === 'loop.todo_reminder')).toBe(true);
    // 只提醒一次：补建 todo 后的第 3 次调用不再追加提醒
    const reminders3 = llm.calls[2].messages.filter(m => m.content?.includes('[system] You are working'));
    expect(reminders3).toHaveLength(1);
  });

  it('模型首轮就建了 todo → 不提醒', async () => {
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c', 'todo_write'), toolCall('a', 'echo')], content: '' },
      { stopReason: 'end', content: 'done' },
    ]);
    const { loop, events } = harness({ llm, tools: [echoTool(), todoTool()] });
    await loop.run();
    expect(events.some(e => e.type === 'loop.todo_reminder')).toBe(false);
    expect(llm.calls[1].messages.some(m => m.content?.includes('[system] You are working'))).toBe(false);
  });

  it('单工具轻任务（累计 <2 次调用）→ 不提醒，避免噪声', async () => {
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('a', 'echo')], content: '' },
      { stopReason: 'end', content: 'done' },
    ]);
    const { loop, events } = harness({ llm, tools: [echoTool(), todoTool()] });
    await loop.run();
    expect(events.some(e => e.type === 'loop.todo_reminder')).toBe(false);
  });

  it('工具列表没有 todo_write（如子代理）→ 不提醒', async () => {
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('a', 'echo'), toolCall('b', 'echo')], content: '' },
      { stopReason: 'end', content: 'done' },
    ]);
    const { loop, events } = harness({ llm, tools: [echoTool()] });
    await loop.run();
    expect(events.some(e => e.type === 'loop.todo_reminder')).toBe(false);
  });
});

describe('AgentLoop — todo 终态收口（清单不再永远转圈）', () => {
  const todoTool = (): Tool => ({
    name: 'todo_write',
    description: 'write todos',
    inputSchema: { type: 'object' },
    source: 'builtin',
    permission: 'auto',
    invoke: async (input: any, ctx: any) => {
      // 与真实工具一致：清单经 ctx.emit 进入事件流
      ctx?.emit({ type: 'todo.updated', payload: { todos: input.todos ?? [] } });
      return { ok: true, data: { todos: input.todos ?? [] } };
    },
  });

  it('最终回答时仍有 in_progress 项 → 合成 todo.updated 全部收口（in_progress→completed）', async () => {
    const llm = new ScriptedLLM([
      // 第 1 轮：建清单（一项 in_progress），模型最终回答前忘了更新
      { stopReason: 'tool_use', toolCalls: [toolCall('t', 'todo_write', { todos: [
        { content: 'read file', status: 'completed' },
        { content: 'summarize', status: 'in_progress' },
      ] })], content: '' },
      { stopReason: 'end', content: 'SUMMARY' },
    ]);
    const { loop, events } = harness({ llm, tools: [todoTool()] });
    const r = await loop.run();

    expect(r.status).toBe('completed');
    const todoEvents = events.filter(e => e.type === 'todo.updated');
    expect(todoEvents).toHaveLength(2); // 工具 1 次 + 引擎收口 1 次
    const closed = todoEvents[1].payload!.todos as Array<{ status: string }>;
    expect(closed.map(t => t.status)).toEqual(['completed', 'completed']);
    expect(todoEvents[1].payload!._closedBy).toBe('run_end');
  });

  it('取消 → in_progress 置回 pending（如实反映未完成）', async () => {
    const abortErr = new Error('cancelled');
    abortErr.name = 'AbortError';
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('t', 'todo_write', { todos: [
        { content: 'a', status: 'in_progress' },
      ] })], content: '' },
      abortErr,
    ]);
    const { loop, events } = harness({ llm, tools: [todoTool()] });
    await loop.run();

    const todoEvents = events.filter(e => e.type === 'todo.updated');
    expect(todoEvents).toHaveLength(2);
    expect(todoEvents[1].payload!.todos[0].status).toBe('pending');
  });

  it('没有未完成项 / 从未建清单 → 不合成收口事件', async () => {
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('t', 'todo_write', { todos: [
        { content: 'a', status: 'completed' },
      ] })], content: '' },
      { stopReason: 'end', content: 'ok' },
    ]);
    const { loop, events } = harness({ llm, tools: [todoTool()] });
    await loop.run();
    expect(events.filter(e => e.type === 'todo.updated')).toHaveLength(1);

    const llm2 = new ScriptedLLM([{ stopReason: 'end', content: 'ok' }]);
    const { loop: loop2, events: events2 } = harness({ llm: llm2, tools: [echoTool()] });
    await loop2.run();
    expect(events2.filter(e => e.type === 'todo.updated')).toHaveLength(0);
  });
});
