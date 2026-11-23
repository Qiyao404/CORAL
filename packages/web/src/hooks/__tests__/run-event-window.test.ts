import { describe, it, expect } from 'vitest';
import { insertBySeq, trimEventWindow, EVICTABLE_WINDOW, HARD_CAP } from '../run-event-window';
import type { RunEventItem } from '../useRunStream';

/**
 * REG-39：事件超过 800 条后，流式文本被整体淘汰。
 *
 * 界面上的流式文本 = 全部 loop.delta 事件拼接。原裁剪逻辑是"总数超 800 就把**所有**高频事件
 *（delta / 日志 / 进度）一次丢光"：长任务里用户看到的字会突然消失、再从头累积；
 * 结构性事件本身超过 800 条时，每个新到的 delta 都被立刻丢掉 —— 流式直播彻底失效。
 *
 * 修法：高频事件保留"最近的一段"（滑动窗口），只从最旧的开始淘汰；结构性事件照旧全保留。
 */

const ev = (seq: number, type: string, extra: Record<string, any> = {}): RunEventItem => ({
  eventId: `e${seq}`, runId: 'r1', seq, type, payload: extra, timestamp: new Date().toISOString(),
});

/** n 条结构性事件 + m 条增量事件，交错排列 */
function build(structural: number, deltas: number): RunEventItem[] {
  const out: RunEventItem[] = [];
  let seq = 0;
  for (let i = 0; i < Math.max(structural, deltas); i++) {
    if (i < structural) out.push(ev(seq++, 'tool.call_started'));
    if (i < deltas) out.push(ev(seq++, 'loop.delta', { delta: `字${i}` }));
  }
  return out;
}

describe('trimEventWindow · 高频事件滑动窗口', () => {
  it('事件超过 800 条后，最近的流式文本仍然在（不是全部消失）', () => {
    const events = build(700, 300); // 共 1000 条：700 结构性 + 300 增量
    const kept = trimEventWindow(events);
    const deltas = kept.filter(e => e.type === 'loop.delta');
    expect(deltas.length).toBeGreaterThan(200);
    // 保留下来的必须是最新的那一段，且顺序不变 → 拼出来就是最近的文字
    expect(deltas.slice(-3).map(e => e.payload.delta)).toEqual(['字297', '字298', '字299']);
  });

  it('只从最旧的开始淘汰：结构性事件一条不少，高频事件不超过窗口大小', () => {
    const events = build(50, 1000);
    const kept = trimEventWindow(events);
    const deltas = kept.filter(e => e.type === 'loop.delta');
    expect(kept.filter(e => e.type === 'tool.call_started')).toHaveLength(50);
    expect(deltas).toHaveLength(EVICTABLE_WINDOW);
    expect(deltas[deltas.length - 1].payload.delta).toBe('字999');
    // seq 仍然单调（裁剪不改变相对顺序）
    const seqs = kept.map(e => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('没超过窗口时不做任何裁剪（短任务零影响）', () => {
    const events = build(30, 100);
    expect(trimEventWindow(events)).toBe(events);
  });

  it('结构性事件自身超过硬上限：截尾保留最近的', () => {
    const events = Array.from({ length: HARD_CAP + 100 }, (_, i) => ev(i, 'tool.call_started'));
    const kept = trimEventWindow(events);
    expect(kept).toHaveLength(HARD_CAP);
    expect(kept[kept.length - 1].seq).toBe(HARD_CAP + 99);
  });
});

describe('insertBySeq · 按 seq 定序（REG-12）', () => {
  it('乱序到达的旧事件插到正确位置，不回退到末尾', () => {
    let list: RunEventItem[] = [];
    for (const s of [3, 1, 5, 2, 4]) list = insertBySeq(list, ev(s, 'todo.updated'));
    expect(list.map(e => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('有序到达（常见情形）原样追加', () => {
    let list: RunEventItem[] = [];
    for (const s of [1, 2, 3]) list = insertBySeq(list, ev(s, 'loop.delta'));
    expect(list.map(e => e.seq)).toEqual([1, 2, 3]);
  });
});
