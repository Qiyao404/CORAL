import { describe, it, expect } from 'vitest';
import { clipToolResults, compressIfNeeded, deterministicCompress, shelveOldToolResults } from '../context-window.js';
import type { ChatMessage } from '../../providers/types.js';

const msg = (role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ role, content, ...extra });

describe('clipToolResults（M1-3 一级防护）', () => {
  it('超长工具结果被裁剪为头 80% + 尾 10% + 截断标记', () => {
    const huge = 'A'.repeat(50_000) + 'TAIL-MARKER';
    const out = clipToolResults([msg('tool', huge, { toolCallId: '1', toolName: 'http_fetch' })], { maxToolChars: 10_000 });
    expect(out[0].content.length).toBeLessThan(50_000);
    expect(out[0].content).toContain('已截断');
    expect(out[0].content.startsWith('A'.repeat(7_999))).toBe(true); // 头部保留
    expect(out[0].content.endsWith('TAIL-MARKER')).toBe(true);       // 尾部保留
  });

  it('未超限与其他角色消息原样保留', () => {
    const m1 = msg('user', 'hi');
    const m2 = msg('tool', 'short', { toolCallId: '1' });
    const out = clipToolResults([m1, m2]);
    expect(out[0]).toBe(m1);
    expect(out[1]).toBe(m2);
  });
});

describe('compressIfNeeded（M1-3 二级防护）', () => {
  const opts = {
    maxTotalChars: 1000,
    keepRecent: 4,
    summarize: async (t: string) => `SUMMARY(${t.length} chars): ${t.slice(0, 50)}`,
  };

  it('未超限 → 原样返回不压缩', async () => {
    const messages = [msg('user', 'goal'), msg('assistant', 'ok')];
    const r = await compressIfNeeded(messages, opts);
    expect(r.compressed).toBe(false);
    expect(r.messages).toBe(messages);
  });

  it('超限 → 中段压缩为摘要消息，首条 goal 与最近 N 条保留', async () => {
    const messages: ChatMessage[] = [
      msg('user', 'THE-GOAL'),
      ...Array.from({ length: 10 }, (_, i) => msg('assistant', `old-${i}-`.repeat(60))), // 中段大块
      msg('tool', 'recent-tool', { toolCallId: 't1', toolName: 'fs_read' }),
      msg('assistant', 'recent-answer'),
    ];
    const r = await compressIfNeeded(messages, opts);
    expect(r.compressed).toBe(true);
    expect(r.summary).toContain('SUMMARY');

    // 结构：[摘要(含原 goal), ...最近4条]
    expect(r.messages.length).toBe(1 + 4);
    expect(r.messages[0].role).toBe('user');
    expect(r.messages[0].content).toContain('THE-GOAL');
    expect(r.messages[0].content).toContain('SUMMARY');
    // 最近 4 条原样在尾部
    expect(r.messages.at(-1)!.content).toBe('recent-answer');
    expect(r.messages.at(-2)!.content).toBe('recent-tool');
  });

  it('消息数太少（≤ keepRecent+1）即使超长也不压缩', async () => {
    const messages = [msg('user', 'g'), msg('tool', 'x'.repeat(5000), { toolCallId: '1' })];
    const r = await compressIfNeeded(messages, opts);
    expect(r.compressed).toBe(false);
  });

  it('摘要器收到的是中段转录（含角色标注）', async () => {
    let received = '';
    const messages: ChatMessage[] = [
      msg('user', 'g'),
      msg('assistant', 'middle-1'.repeat(100)),
      msg('tool', 'middle-tool-content', { toolCallId: '1', toolName: 'fs_read' }),
      msg('assistant', 'recent'),
    ];
    await compressIfNeeded(messages, { maxTotalChars: 100, keepRecent: 1, summarize: async t => { received = t; return 'S'; } });
    expect(received).toContain('[assistant]');
    expect(received).toContain('[tool:fs_read]');
    expect(received).toContain('middle-tool-content');
    expect(received).not.toContain('recent'); // 最近段不进摘要
  });

  it('REG-03 回归：切片边界落在工具调用组内时向前扩展（recent 不以孤儿 tool 开头）', async () => {
    const opts = { maxTotalChars: 1, keepRecent: 2 };
    const messages = [
      { role: 'user' as const, content: 'goal' },
      { role: 'assistant' as const, content: '', toolCalls: [{ id: 'c1', name: 'fs_read', input: {} }] },
      { role: 'tool' as const, toolCallId: 'c1', toolName: 'fs_read', content: 'A'.repeat(3000) },
      { role: 'assistant' as const, content: '', toolCalls: [{ id: 'c2', name: 'fs_read', input: {} }] },
      { role: 'tool' as const, toolCallId: 'c2', toolName: 'fs_read', content: 'B'.repeat(3000) },
      { role: 'assistant' as const, content: '中间回答' },
    ];
    const r = await compressIfNeeded(messages, { ...opts, summarize: async () => '摘要' });
    expect(r.compressed).toBe(true);
    // recent 首条不得是孤儿 tool（其 assistant(toolCalls) 必须同在）
    const recentStart = r.messages[1];
    expect(recentStart.role === 'tool' ? false : true).toBe(true);
    // 若含 tool 消息，其前面的 assistant 必须带对应 toolCalls
    for (let i = 1; i < r.messages.length; i++) {
      if (r.messages[i].role === 'tool') {
        const prev = r.messages[i - 1];
        expect(prev.role === 'assistant' && (prev.toolCalls ?? []).some(c => c.id === (r.messages[i] as any).toolCallId)).toBe(true);
      }
    }
  });
});

// ─── A3：压缩路标（有损压缩必须自带回查指引）────────────────────────────

describe('压缩路标（compression signpost）', () => {
  it('compressIfNeeded：摘要消息含回查路标（精确值须重新推导）', async () => {
    const messages = [
      { role: 'user' as const, content: '任务目标' },
      ...Array.from({ length: 20 }, (_, i) => ({ role: 'tool' as const, content: `x`.repeat(200) + i, toolName: 't' })),
      { role: 'assistant' as const, content: 'recent' },
    ];
    const r = await compressIfNeeded(messages, {
      maxTotalChars: 2000, keepRecent: 3,
      summarize: async () => '概要：做了些事，数值 12345',
    });
    expect(r.compressed).toBe(true);
    const summaryMsg = r.messages.find(m => m.content.includes('概要'));
    expect(summaryMsg).toBeTruthy();
    expect(summaryMsg!.content).toContain('compression signpost');
    expect(summaryMsg!.content).toContain('re-derive');
    // 路标在摘要之后、原始任务之前（模型读到摘要立刻看到警示）
    const idxSign = summaryMsg!.content.indexOf('[compression signpost]');
    const idxSummary = summaryMsg!.content.indexOf('概要');
    const idxTask = summaryMsg!.content.indexOf('[The original task');
    expect(idxSummary).toBeLessThan(idxSign);
    expect(idxSign).toBeLessThan(idxTask);
  });

  it('deterministicCompress：骨架消息声明"只保留前 160 字符、非忠实摘要"', () => {
    const messages = [
      { role: 'user' as const, content: 'goal' },
      ...Array.from({ length: 30 }, (_, i) => ({ role: 'tool' as const, content: 'y'.repeat(300) + i })),
      { role: 'assistant' as const, content: 'recent' },
    ];
    const r = deterministicCompress(messages, { maxTotalChars: 1500, keepRecent: 3 });
    expect(r.compressed).toBe(true);
    expect(r.messages[0].content).toContain('NOT a faithful summary');
  });

  it('shelveOldToolResults：有归档 → 指明何时回查；无归档 → 声明不可恢复', () => {
    const mk = () => [
      { role: 'user' as const, content: 'g' },
      ...Array.from({ length: 6 }, () => ({ role: 'tool' as const, content: 'z'.repeat(2000) })),
      { role: 'assistant' as const, content: 'r' },
    ];
    // 有归档
    const withArchive = shelveOldToolResults(mk(), 10_000, {
      archive: () => 'ev-test123',
    });
    expect(withArchive.shelved).toBeGreaterThan(0);
    const stub1 = withArchive.messages.find(m => m.role === 'tool')!.content;
    expect(stub1).toContain('ev-test123');
    expect(stub1).toContain('evidence_read 回查');
    // 无归档
    const noArchive = shelveOldToolResults(mk(), 10_000, {});
    const stub2 = noArchive.messages.find(m => m.role === 'tool')!.content;
    expect(stub2).toContain('不可恢复');
    expect(stub2).toContain('重新执行工具');
  });

  it('clipToolResults：截断标记含"精确值须收窄查询重取"提示', () => {
    const long = { role: 'tool' as const, content: 'a'.repeat(50_000) };
    const r = clipToolResults([long]);
    expect(r[0].content).toContain('narrow the query or re-run');
  });
});
