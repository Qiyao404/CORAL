import { describe, it, expect } from 'vitest';
import { clipToolResults, compressIfNeeded } from '../context-window.js';
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
});
