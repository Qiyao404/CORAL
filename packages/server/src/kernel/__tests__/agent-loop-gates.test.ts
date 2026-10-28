import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentLoop, type AgentLoopOptions, type LoopEvent } from '../agent-loop.js';
import { EvidenceStore } from '../evidence.js';
import type { ChatRequest, ChatResponse } from '../../providers/types.js';
import type { Tool } from '../../tools/types.js';

/** 脚本化 LLM（与 agent-loop.test.ts 同款） */
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

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'coral-gates-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function harness(over: {
  llm: ScriptedLLM;
  tools: Tool[];
  workspaceDir?: string;
  evidenceStore?: EvidenceStore;
  summarize?: (t: string) => Promise<string>;
  maxTotalChars?: number;
  keepRecent?: number;
  budget?: Partial<AgentLoopOptions['budget']>;
}) {
  const events: LoopEvent[] = [];
  const options: AgentLoopOptions = {
    runId: 'run-g',
    agentId: 'main',
    goal: '测试目标',
    tools: over.tools,
    budget: { maxSteps: 12, maxTokens: 10_000_000, ...over.budget },
    signal: new AbortController().signal,
    onEvent: e => events.push(e),
    workspaceDir: over.workspaceDir,
    evidenceStore: over.evidenceStore,
    summarize: over.summarize,
    maxTotalChars: over.maxTotalChars,
    keepRecent: over.keepRecent,
  };
  return { loop: new AgentLoop(over.llm, options), events };
}

/** fs 读写桩（带效果声明 — 事实门据此设门） */
function fsStubs() {
  const readTool: Tool = {
    name: 'fs_read',
    description: '',
    inputSchema: { type: 'object' },
    source: 'builtin',
    permission: 'auto',
    effects: { idempotent: true },
    invoke: async (input: any) => ({ ok: true, data: { path: input.path, content: `content of ${input.path}` } }),
  };
  const listTool: Tool = {
    name: 'fs_list',
    description: '',
    inputSchema: { type: 'object' },
    source: 'builtin',
    permission: 'auto',
    effects: { idempotent: true },
    invoke: async () => ({ ok: true, data: { path: '.', entries: [{ path: 'a.md', type: 'file' }] } }),
  };
  const editTool: Tool = {
    name: 'fs_edit',
    description: '',
    inputSchema: { type: 'object' },
    source: 'builtin',
    permission: 'auto',
    effects: { writesFilesystem: true },
    invoke: async (input: any) => ({ ok: true, data: { path: input.path, replaced: true } }),
  };
  return { readTool, listTool, editTool };
}

describe('AgentLoop × 事实门 — 盲改被拦，调查后放行', () => {
  it('未读过直接 fs_edit → FACTS_REQUIRED + 事件；读过重试 → 执行成功', async () => {
    writeFileSync(join(tmpDir, 'a.md'), 'hello', 'utf-8');
    const { readTool, editTool } = fsStubs();
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c1', 'fs_edit', { path: 'a.md', old_text: 'h', new_text: 'H' })], content: '' },
      { stopReason: 'tool_use', toolCalls: [toolCall('c2', 'fs_read', { path: 'a.md' })], content: '先读文件确认现状' },
      { stopReason: 'tool_use', toolCalls: [toolCall('c3', 'fs_edit', { path: 'a.md', old_text: 'h', new_text: 'H' })], content: '' },
      { stopReason: 'end', content: '已完成修改' },
    ]);
    const { loop, events } = harness({ llm, tools: [readTool, editTool], workspaceDir: tmpDir });
    const r = await loop.run();

    expect(r.status).toBe('completed');
    const toolMsgs = r.messages.filter(m => m.role === 'tool');
    // 第一次 edit 被事实门拒绝（可重试错误）
    expect(JSON.parse(toolMsgs[0].content).error.code).toBe('FACTS_REQUIRED');
    // 调查（fs_read）成功
    expect(JSON.parse(toolMsgs[1].content).path).toBe('a.md');
    // 重试 edit 放行执行
    expect(JSON.parse(toolMsgs[2].content).replaced).toBe(true);
    // 事件可复核
    const gateEvents = events.filter(e => e.type === 'tool.fact_gate');
    expect(gateEvents.some(e => (e.payload as any).decision === 'deny')).toBe(true);
  });

  it('覆盖已有文件没读过 → 拦截；fs_read 之后放行（新建文件不设门）', async () => {
    writeFileSync(join(tmpDir, 'b.md'), 'old', 'utf-8');
    const { readTool, listTool, editTool } = fsStubs();
    const writeTool: Tool = {
      ...editTool,
      name: 'fs_write',
      invoke: async (input: any) => ({ ok: true, data: { path: input.path, created: false } }),
    };
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c1', 'fs_write', { path: 'b.md', content: 'new' })], content: '' },
      { stopReason: 'tool_use', toolCalls: [toolCall('c2', 'fs_read', { path: 'b.md' })], content: '' },
      { stopReason: 'tool_use', toolCalls: [toolCall('c3', 'fs_write', { path: 'b.md', content: 'new' })], content: '' },
      { stopReason: 'end', content: 'done' },
    ]);
    const { loop, events } = harness({ llm, tools: [listTool, readTool, writeTool], workspaceDir: tmpDir });
    const r = await loop.run();

    const toolMsgs = r.messages.filter(m => m.role === 'tool');
    expect(JSON.parse(toolMsgs[0].content).error.code).toBe('FACTS_REQUIRED');
    expect(JSON.parse(toolMsgs[2].content).created).toBe(false);
    expect(events.some(e => e.type === 'tool.fact_gate')).toBe(true);
  });

  it('种子历史里的读取也算数（fork/续接不误伤）', async () => {
    writeFileSync(join(tmpDir, 'a.md'), 'hello', 'utf-8');
    const { readTool, editTool } = fsStubs();
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c1', 'fs_edit', { path: 'a.md' })], content: '' },
      { stopReason: 'end', content: 'done' },
    ]);
    // 直接构造 options 注入 initialHistory（上一轮已读过 a.md）
    const events: LoopEvent[] = [];
    const loop = new AgentLoop(llm, {
      runId: 'r', agentId: 'main', goal: '继续修改',
      tools: [readTool, editTool],
      budget: { maxSteps: 5, maxTokens: 1e9 },
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
      workspaceDir: tmpDir,
      initialHistory: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'p1', name: 'fs_read', input: { path: 'a.md' } }] },
        { role: 'tool', toolCallId: 'p1', toolName: 'fs_read', content: JSON.stringify({ path: 'a.md', content: 'hello' }) },
      ],
    });
    const r = await loop.run();
    const editMsg = r.messages.filter(m => m.role === 'tool').at(-1)!;
    expect(JSON.parse(editMsg.content).replaced).toBe(true);
  });
});

describe('AgentLoop × 证据记录 — 大结果落盘，摘要入上下文', () => {
  it('超预算工具结果转为摘要+ID；evidence_read 可取回全文', async () => {
    const store = new EvidenceStore(join(tmpDir, 'data'));
    const bigTool: Tool = {
      name: 'big_fetch',
      description: '',
      inputSchema: { type: 'object' },
      source: 'builtin',
      permission: 'auto',
      effects: { accessesNetwork: true },
      maxResultSizeChars: 5000,
      invoke: async () => ({ ok: true, data: { blob: 'Z'.repeat(20_000) } }),
    };
    // evidence_read 桩（同名 — 验证模型侧可翻页取回）
    const readBack: Tool = {
      name: 'evidence_read',
      description: '',
      inputSchema: { type: 'object' },
      source: 'builtin',
      permission: 'auto',
      invoke: async (input: any, ctx: any) => {
        const r = store.read(ctx.runId, input.evidence_id, Number(input.offset) || 0, Number(input.limit) || 8000);
        return r ? { ok: true, data: { content: r.page, hasMore: r.hasMore } } : { ok: false, error: { code: 'NOT_FOUND', message: '', retryable: false } };
      },
    };
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c1', 'big_fetch')], content: '' },
      { stopReason: 'end', content: 'done' },
    ]);
    const { loop, events } = harness({ llm, tools: [bigTool, readBack], evidenceStore: store });
    const r = await loop.run();

    const toolMsg = r.messages.find(m => m.role === 'tool')!;
    const parsed = JSON.parse(toolMsg.content);
    expect(parsed.evidenceId).toMatch(/^ev-/);
    expect(parsed.totalChars).toBeGreaterThan(19_000);
    expect(parsed.preview.length).toBeLessThan(2000);
    expect(events.some(e => e.type === 'tool.evidence_saved')).toBe(true);

    // 取回：按记录 ID 分页读（存档是完整 JSON 序列化，首页即含数据体）
    const back = store.read('run-g', parsed.evidenceId, 0, 8000)!;
    expect(back.page).toContain('Z'.repeat(100));
    expect(back.hasMore).toBe(true);
  });
});

describe('AgentLoop × 收工门 — 复杂任务的合理化话术被打回', () => {
  const writeStub = (): Tool => ({
    name: 'fs_write',
    description: '',
    inputSchema: { type: 'object' },
    source: 'builtin',
    permission: 'auto',
    effects: { writesFilesystem: true },
    invoke: async (input: any) => ({ ok: true, data: { path: input.path } }),
  });

  it('3 次写操作后交含话术的总结 → 打回一次；诚实重写后放行', async () => {
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c1', 'fs_write', { path: 'a.md' })], content: '' },
      { stopReason: 'tool_use', toolCalls: [toolCall('c2', 'fs_write', { path: 'b.md' })], content: '' },
      { stopReason: 'tool_use', toolCalls: [toolCall('c3', 'fs_write', { path: 'c.md' })], content: '' },
      { stopReason: 'end', content: 'All done. The failing tests are a pre-existing issue, we will fix it later.' },
      { stopReason: 'end', content: '## 完成\n三个文件已写入。\n\n## 未完成事项\n- 边界测试未覆盖，建议下轮补充。' },
    ]);
    const { loop, events } = harness({ llm, tools: [writeStub()], workspaceDir: tmpDir });
    const r = await loop.run();

    expect(r.status).toBe('completed');
    expect(r.finalContent).toContain('未完成事项');
    expect(events.some(e => e.type === 'loop.gate_rejected')).toBe(true);
    // 打回的追问进入了下一轮上下文
    const pushbackCall = llm.calls[4];
    expect(pushbackCall.messages.some(m => m.content?.includes('QUALITY GATE'))).toBe(true);
  });

  it('连续 3 次话术 → 强制放行 + 告警事件（门防偷懒不防交付）', async () => {
    const rambling = 'Done. This is a pre-existing issue, we will fix it later.';
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c1', 'fs_write', { path: 'a.md' })], content: '' },
      { stopReason: 'tool_use', toolCalls: [toolCall('c2', 'fs_write', { path: 'b.md' })], content: '' },
      { stopReason: 'tool_use', toolCalls: [toolCall('c3', 'fs_write', { path: 'c.md' })], content: '' },
      { stopReason: 'end', content: rambling },
      { stopReason: 'end', content: rambling },
      { stopReason: 'end', content: rambling },
    ]);
    const { loop, events } = harness({ llm, tools: [writeStub()], workspaceDir: tmpDir });
    const r = await loop.run();

    expect(r.status).toBe('completed');
    expect(r.finalContent).toContain('pre-existing');
    expect(events.filter(e => e.type === 'loop.gate_rejected')).toHaveLength(2);
    expect(events.some(e => e.type === 'loop.gate_forced_pass')).toBe(true);
  });

  it('轻任务（<3 写操作）不设门 — 话术也不打扰', async () => {
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c1', 'fs_write', { path: 'a.md' })], content: '' },
      { stopReason: 'end', content: 'Done, will fix it later maybe.' },
    ]);
    const { loop, events } = harness({ llm, tools: [writeStub()], workspaceDir: tmpDir });
    const r = await loop.run();
    expect(r.status).toBe('completed');
    expect(events.some(e => e.type === 'loop.gate_rejected')).toBe(false);
  });
});

describe('AgentLoop × 压缩冷却阶梯 — 失败分级降级', () => {
  it('summarize 抛错 → 冷却计时 + 确定性摘要立即兜底，run 不受影响', async () => {
    const bigTool: Tool = {
      name: 'big',
      description: '',
      inputSchema: { type: 'object' },
      source: 'builtin',
      permission: 'auto',
      invoke: async () => ({ ok: true, data: { blob: 'Q'.repeat(50_000) } }),
    };
    const round = (n: string) => ({ stopReason: 'tool_use' as const, toolCalls: [toolCall(n, 'big')], content: '' });
    const llm = new ScriptedLLM([
      round('c1'), round('c2'), round('c3'), round('c4'), round('c5'),
      { stopReason: 'end', content: 'done' },
    ]);
    let summarizeCalls = 0;
    const { loop, events } = harness({
      llm,
      tools: [bigTool],
      maxTotalChars: 9_000,
      keepRecent: 2,
      summarize: async () => { summarizeCalls++; throw new Error('LLM 摘要不可用'); },
    });
    const r = await loop.run();

    expect(r.status).toBe('completed'); // 压缩故障绝不杀 run
    expect(summarizeCalls).toBeGreaterThanOrEqual(1);
    // 首次失败即冷却（60s 档）— 测试窗口内不再重试模型摘要
    expect(summarizeCalls).toBeLessThanOrEqual(2);
    const failed = events.filter(e => e.type === 'loop.compact_failed');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect((failed[0].payload as any).cooldownMs).toBeGreaterThanOrEqual(60_000);
    // 确定性兜底生效：消息被骨架摘要压缩（保转录）
    expect(events.some(e => e.type === 'loop.compact_deterministic')).toBe(true);
    const finalCall = llm.calls.at(-1)!;
    expect(finalCall.messages.some(m => m.content.includes('deterministic fallback compression'))).toBe(true);
  });
});
