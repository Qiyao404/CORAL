import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ChatRequest, ChatResponse } from '../../providers/types.js';
import type { LoopEvent } from '../agent-loop.js';
import type { Tool } from '../../tools/types.js';
import { toolOk } from '../../tools/types.js';

/**
 * 审计修复（内核循环层）：REG-21 / REG-23 / REG-24 / REG-27 / REG-30
 *  · REG-21 原地打转熔断（同一调用重复几百次无人管）
 *  · REG-23 结束前排空"还没送达的"（收尾前到达的用户补充被静默丢弃）
 *  · REG-24 取消检查覆盖循环体内部（同一步后续工具 / 守卫升级审批 / team_wait 轮询）
 *  · REG-27 跨模块约定同源（事实门 × 证据层 × 工具别名；裁剪阈值 × 归档阈值）
 *  · REG-30 输出截断不当完整回答交付
 */

const { AgentLoop } = await import('../agent-loop.js');
const { EvidenceStore } = await import('../evidence.js');
const { TeamService } = await import('../team-service.js');
const { makeTeamWaitTool } = await import('../../tools/builtin/team.js');

type Inbox = Array<{ from: string; content: string; kind?: 'user' | 'system' }>;
type Step = Partial<ChatResponse> | ((n: number, req: ChatRequest) => Partial<ChatResponse>);

/** 脚本化 LLM：按调用次序返回（超出脚本长度重复最后一项） */
function makeLLM(script: Step[]) {
  const calls: ChatRequest[] = [];
  let n = 0;
  const llm = {
    calls,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      calls.push(req);
      const step = script[Math.min(n, script.length - 1)];
      const r = typeof step === 'function' ? step(n, req) : step;
      n++;
      return {
        content: r.content ?? '',
        toolCalls: (r.toolCalls ?? []) as ChatResponse['toolCalls'],
        usage: r.usage ?? { inputTokens: 10, outputTokens: 5 },
        stopReason: r.stopReason ?? (r.toolCalls?.length ? 'tool_use' : 'end'),
      } as ChatResponse;
    },
    async complete() { return { content: 's' }; },
  };
  return llm;
}

function makeTool(name: string, invoke: Tool['invoke'], over: Partial<Tool> = {}): Tool {
  return { name, description: name, inputSchema: { type: 'object' }, source: 'builtin', permission: 'auto', effects: { idempotent: true }, invoke, ...over };
}
const call = (id: string, name: string, input: Record<string, any> = {}) => ({ id, name, input });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function runLoop(llm: any, tools: Tool[], over: Record<string, any> = {}) {
  const events: LoopEvent[] = [];
  const controller = new AbortController();
  const loop = new AgentLoop(llm as any, {
    runId: 'run-fix', agentId: 'main', goal: '任务', tools,
    budget: { maxSteps: 200, maxTokens: 100_000_000 },
    signal: controller.signal,
    onEvent: e => events.push(e),
    ...over,
  } as any);
  return { run: () => loop.run(), events, controller };
}

// ─── REG-21 ───────────────────────────────────────────────────────────────
describe('REG-21 · 原地打转熔断', () => {
  const same = () => ({ toolCalls: [call(`c${Math.random()}`, 'http_fetch', { url: 'https://example.test/same' })] });

  it('同一调用连打：第 5 次警告（附在工具结果末尾），第 15 次强制收尾', async () => {
    let executed = 0;
    const llm = makeLLM([n => (n < 15 ? same() : { content: '到这里为止的总结' })]);
    const { run, events } = runLoop(llm, [makeTool('http_fetch', async () => { executed++; return toolOk({ status: 429 }); })]);
    const r = await run();

    expect(r.status).toBe('stalled');
    expect(r.finalContent).toBe('到这里为止的总结');
    expect(executed).toBe(15); // 不是跑到 maxSteps=200 才停
    const warnings = events.filter(e => e.type === 'loop.stall_warning');
    expect(warnings).toHaveLength(1);
    expect((warnings[0].payload as any).count).toBe(5);
    const stalled = events.find(e => e.type === 'loop.stalled')!;
    expect((stalled.payload as any).tool).toBe('http_fetch');
    // 警告文本进了模型的上下文（第 5 条工具结果末尾）
    const toolMsgs = llm.calls[15].messages.filter(m => m.role === 'tool');
    expect(toolMsgs[4].content).toContain('[runtime notice]');
    expect(toolMsgs[3].content).not.toContain('[runtime notice]');
  });

  it('team_wait 是轮询语义，豁免', async () => {
    const llm = makeLLM([n => (n < 20 ? { toolCalls: [call(`w${n}`, 'team_wait', { agents: ['x'] })] } : { content: '完成' })]);
    const { run, events } = runLoop(llm, [makeTool('team_wait', async () => toolOk({ results: [] }))]);
    const r = await run();
    expect(r.status).toBe('completed');
    expect(events.some(e => e.type === 'loop.stalled')).toBe(false);
  });

  it('入参不同不算打转', async () => {
    const llm = makeLLM([n => (n < 20 ? { toolCalls: [call(`u${n}`, 'http_fetch', { url: `https://example.test/${n}` })] } : { content: '完成' })]);
    const { run, events } = runLoop(llm, [makeTool('http_fetch', async () => toolOk({ ok: true }))]);
    expect((await run()).status).toBe('completed');
    expect(events.some(e => e.type === 'loop.stalled')).toBe(false);
  });

  it('不连续但累计重复（A、B 交替，A 打了 30 次）同样熔断', async () => {
    let a = 0;
    const llm = makeLLM([n => {
      const first = call(`a${n}`, 'http_fetch', { url: 'https://example.test/same' });
      const second = call(`b${n}`, 'todo_write', { todos: [] });
      if (a >= 30) return { content: '总结' };
      a++;
      return { toolCalls: [first, second] };
    }]);
    const { run } = runLoop(llm, [
      makeTool('http_fetch', async () => toolOk({ status: 429 })),
      makeTool('todo_write', async () => toolOk({})),
    ]);
    const r = await run();
    expect(r.status).toBe('stalled');
    expect(a).toBe(30);
  });
});

// ─── REG-23 ───────────────────────────────────────────────────────────────
describe('REG-23 · 结束前排空未送达的消息', () => {
  it('最终回答生成的瞬间到达的用户补充：不丢，带着它再跑一轮', async () => {
    const inbox: Inbox = [];
    let executed = 0;
    const llm = makeLLM([
      () => ({ toolCalls: [call('c1', 'todo_write', { todos: [] })] }),
      () => { inbox.push({ from: 'user', kind: 'user', content: '等等，改成用表格' }); return { content: '第一版回答' }; },
      () => ({ content: '改成表格后的回答' }),
    ]);
    const { run, events } = runLoop(llm, [makeTool('todo_write', async () => { executed++; return toolOk({}); })], { pollInbox: () => inbox.splice(0) });
    const r = await run();

    expect(r.status).toBe('completed');
    expect(r.finalContent).toBe('改成表格后的回答');
    const lastReq = llm.calls[llm.calls.length - 1];
    expect(lastReq.messages.some(m => m.content.includes('[user follow-up]') && m.content.includes('改成用表格'))).toBe(true);
    expect(lastReq.messages.some(m => m.role === 'assistant' && m.content === '第一版回答')).toBe(true); // 第一版没被吞
    expect(events.filter(e => e.type === 'run.user_input_injected')).toHaveLength(1);
  });

  it('预算耗尽（无法再跑）：未送达的补充如实附在收尾内容里 + 事件留痕', async () => {
    const inbox: Inbox = [];
    const llm = makeLLM([
      () => ({ toolCalls: [call('c1', 'todo_write', { todos: [] })] }),
      () => { inbox.push({ from: 'user', kind: 'user', content: '记得附上数据来源' }); return { content: '预算用尽的总结' }; },
    ]);
    const { run, events } = runLoop(llm, [makeTool('todo_write', async () => toolOk({}))], { pollInbox: () => inbox.splice(0), budget: { maxSteps: 1, maxTokens: 100_000_000 } });
    const r = await run();

    expect(r.status).toBe('budget_exceeded');
    expect(r.finalContent).toContain('预算用尽的总结');
    expect(r.finalContent).toContain('记得附上数据来源'); // 用户的话原样带出，而不是消失
    expect(events.some(e => e.type === 'loop.inbox_undelivered')).toBe(true);
    expect(inbox).toHaveLength(0);
  });

  it('消息源源不断（模型每答一次就又来一条）：续跑有上限，run 一定结束，超出的消息不丢', async () => {
    const inbox: Inbox = [];
    let n = 0;
    const llm = makeLLM([() => {
      n++;
      if (n >= 2) inbox.push({ from: 'user', kind: 'user', content: `补充第${n}条` });
      return n === 1 ? { toolCalls: [call('c1', 'todo_write', {})] } : { content: `第${n}版回答` };
    }]);
    const { run } = runLoop(llm, [makeTool('todo_write', async () => toolOk({}))], { pollInbox: () => inbox.splice(0) });

    const r = await run(); // 若没有上限，这里永远不返回（vitest 会超时失败）
    expect(r.status).toBe('completed');
    // 1 个工具轮 + 5 轮续跑（第 2~6 次调用，每次到达一条新补充）+ 1 轮收尾
    expect(llm.calls.length).toBe(1 + 5 + 1);
    // 到达上限那一轮取出的消息没有被丢：如实附在最终回答末尾
    expect(r.finalContent.startsWith('第7版回答')).toBe(true);
    expect(r.finalContent).toContain('未处理的消息');
    expect(r.finalContent).toContain('补充第7条');
    expect(inbox).toHaveLength(0);
  });
});

// ─── REG-24 ───────────────────────────────────────────────────────────────
describe('REG-24 · 取消检查覆盖循环体内部', () => {
  const multi = () => ({ toolCalls: [call('c1', 'A'), call('c2', 'B'), call('c3', 'C')] });

  it('同一步里第 1 个工具执行期间取消 → 第 2、3 个不再执行', async () => {
    const log: string[] = [];
    let saved: any[] = [];
    const { run, controller } = runLoop(makeLLM([multi]), ['A', 'B', 'C'].map(name => makeTool(name, async () => {
      log.push(name);
      if (name === 'A') controller.abort();
      return toolOk({});
    })), { saveCheckpoint: cp => { saved = cp.state.messages; } });
    const r = await run();
    expect(r.status).toBe('cancelled');
    expect(log).toEqual(['A']);
    // REG-04 不变量仍成立：落库的中间状态对"下次加载"合法（半截的工具组被修剪）
    expect(saved.some(m => m.role === 'assistant' && m.toolCalls?.length)).toBe(false);
    expect(saved.some(m => m.role === 'tool')).toBe(false);
  });

  it('守卫把工具升级为审批时：已取消的 run 不再发起审批', async () => {
    let approvals = 0;
    const { run, controller } = runLoop(makeLLM([multi]), ['A', 'B', 'C'].map(name => makeTool(name, async () => {
      if (name === 'A') controller.abort();
      return toolOk({});
    })), {
      approveTool: async () => { approvals++; return true; },
      hooks: { run: async (event) => ({ decision: event === 'pre_tool_use' ? 'ask' : 'allow', matched: 1, failed: 0 }) },
    });
    const r = await run();
    expect(r.status).toBe('cancelled');
    expect(approvals).toBe(1); // 第 1 个工具执行前的审批是合理的；取消之后没有再发起
  });

  it('team_wait 轮询期间取消 → 立即返回，不再干等', async () => {
    const team = new TeamService('run-fix', () => {});
    team.registerTeammate('scout', 'mate-scout');
    const controller = new AbortController();
    const waitTool = makeTeamWaitTool(team);
    const started = Date.now();
    const p = waitTool.invoke({ agents: ['scout'], timeout_s: 30 }, { runId: 'run-fix', agentId: 'main', signal: controller.signal, emit: () => {} } as any);
    setTimeout(() => controller.abort(), 40);
    const res = await p;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.ok).toBe(false);
    expect((res.error as any).code).toBe('CANCELLED');
    await sleep(50);
  });
});

// ─── REG-27 ───────────────────────────────────────────────────────────────
describe('REG-27 · 事实门认得证据层与别名读取', () => {
  const wsDir = mkdtempSync(join(tmpdir(), 'coral-factgate-'));
  writeFileSync(join(wsDir, 'notes.md'), '# 旧标题\n\n正文。\n', 'utf-8');
  const fsRead = (maxResultSizeChars?: number) => makeTool('fs_read', async () => toolOk({ path: 'notes.md', content: '# 旧标题\n\n正文。', size: 20, truncated: false }), maxResultSizeChars ? { maxResultSizeChars } : {});
  const fsEdit = makeTool('fs_edit', async () => toolOk({ path: 'notes.md', edited: true }), { effects: { writesFilesystem: true } });
  const edit = call('e1', 'fs_edit', { path: 'notes.md', old_text: '旧标题', new_text: '新标题' });

  it('模型用别名 read_file 读过 → 事实门认这次读取', async () => {
    const llm = makeLLM([
      { toolCalls: [call('r1', 'read_file', { path: 'notes.md' })] },
      { toolCalls: [edit] },
      { content: '完成' },
    ]);
    const { run, events } = runLoop(llm, [fsRead(), fsEdit], { workspaceDir: wsDir });
    const r = await run();
    const firstTool: any = r.messages.find(m => m.role === 'tool');
    expect(firstTool.toolName).toBe('fs_read'); // 记录实际执行的名字（别名不进历史）
    expect(events.filter(e => e.type === 'tool.fact_gate' && (e.payload as any).decision === 'deny')).toHaveLength(0);
  });

  it('读的是超大文件（结果转成证据摘要）→ 摘要里带路径，事实门照样认', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'coral-factgate-ev-'));
    const store = new EvidenceStore(tmp);
    const bigRead = makeTool('fs_read', async () => toolOk({ path: 'notes.md', content: '正文'.repeat(3000), size: 6000, truncated: false }), { maxResultSizeChars: 200 });
    const llm = makeLLM([
      { toolCalls: [call('r1', 'fs_read', { path: 'notes.md' })] },
      { toolCalls: [edit] },
      { content: '完成' },
    ]);
    const { run, events } = runLoop(llm, [bigRead, fsEdit], { workspaceDir: wsDir, evidenceStore: store });
    const r = await run();
    const firstTool: any = r.messages.find(m => m.role === 'tool');
    expect(firstTool.content).toContain('evidenceId'); // 确实走了证据层
    expect(events.filter(e => e.type === 'tool.fact_gate' && (e.payload as any).decision === 'deny')).toHaveLength(0);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('REG-27 · 会被裁剪的结果先存证据', () => {
  it('工具允许 20 万字符、结果 10 万字符：中段不再静默丢失', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'coral-clip-'));
    const store = new EvidenceStore(tmp);
    const body = 'A'.repeat(49_990) + '【关键中段内容KEY】' + 'B'.repeat(49_990);
    const bigRead = makeTool('fs_read', async () => toolOk({ path: 'big.txt', content: body, size: body.length, truncated: false }), { maxResultSizeChars: 200_000 });
    const llm = makeLLM([{ toolCalls: [call('r1', 'fs_read', { path: 'big.txt' })] }, { content: '完成' }]);
    const { run } = runLoop(llm, [bigRead], { evidenceStore: store });
    const r = await run();
    const toolMsg: any = r.messages.find(m => m.role === 'tool');
    expect(store.list('run-fix')).toHaveLength(1); // 整体已存档，可 evidence_read 翻页取回
    expect(toolMsg.content).toContain('evidenceId');
    expect(toolMsg.content.includes('【关键中段内容KEY】')).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('evidence_read 自己翻页取回的内容不再被"证据的证据"套娃归档', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'coral-clip2-'));
    const store = new EvidenceStore(tmp);
    const rec = store.save('run-fix', 'fs_read', JSON.stringify({ path: 'big.txt', content: 'X'.repeat(50_000) }));
    const evRead = makeTool('evidence_read', async () => toolOk({ evidenceId: rec.id, content: 'X'.repeat(45_000), totalChars: 50_000, offset: 0, hasMore: true }), { maxResultSizeChars: 70_000 });
    const llm = makeLLM([{ toolCalls: [call('r1', 'evidence_read', { evidence_id: rec.id, limit: 45000 })] }, { content: '完成' }]);
    const { run } = runLoop(llm, [evRead], { evidenceStore: store });
    await run();
    expect(store.list('run-fix')).toHaveLength(1);
    rmSync(tmp, { recursive: true, force: true });
  });
});

// ─── REG-30 ───────────────────────────────────────────────────────────────
describe('REG-30 · 输出截断不当完整回答交付', () => {
  it('最终回答被输出上限截断 → 接着写完，两段拼成完整回答', async () => {
    const llm = makeLLM([
      { content: '## 报告\n\n第一部分：市场概况如下……', stopReason: 'max_tokens' },
      { content: '\n\n第二部分：风险与建议。', stopReason: 'end' },
    ]);
    const { run, events } = runLoop(llm, []);
    const r = await run();
    expect(r.status).toBe('completed');
    expect(r.finalContent).toContain('第一部分');
    expect(r.finalContent).toContain('第二部分');
    expect(events.some(e => e.type === 'loop.answer_continued')).toBe(true);
  });

  it('工具调用的参数被截断 → 不执行半截参数，让模型重发', async () => {
    let executed = 0;
    const llm = makeLLM([
      { toolCalls: [call('c1', 'todo_write', { todos: [{ content: '被截断的' }] })], stopReason: 'max_tokens' },
      { toolCalls: [call('c2', 'todo_write', { todos: [{ content: '完整的第一项', status: 'in_progress' }] })], stopReason: 'tool_use' },
      { content: '完成' },
    ]);
    const { run, events } = runLoop(llm, [makeTool('todo_write', async () => { executed++; return toolOk({}); })]);
    const r = await run();
    expect(executed).toBe(1); // 半截的那次没执行
    expect(r.status).toBe('completed');
    expect(events.some(e => e.type === 'loop.tool_call_truncated')).toBe(true);
  });

  it('模型反复截断：续写有上限，到点如实交付已得内容并告警', async () => {
    const llm = makeLLM([(n: number) => ({ content: `第${n + 1}段。`, stopReason: 'max_tokens' })]);
    const { run, events } = runLoop(llm, []);
    const r = await run();
    expect(r.status).toBe('completed');
    expect(r.finalContent).toContain('第1段');
    expect(r.finalContent).toContain('第4段');
    expect(r.finalContent).not.toContain('第5段'); // 续写 3 次后停
    expect(events.some(e => e.type === 'loop.answer_truncated')).toBe(true);
  });
});
