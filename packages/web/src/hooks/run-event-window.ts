import type { RunEventItem } from './useRunStream';

/**
 * 事件窗口（run-event-window）— useRunStream 的纯逻辑部分：按 seq 定序插入 + 窗口裁剪。
 * 不依赖 React，可直接单测（REG-12 / REG-39 的回归测试在这里）。
 */

/** 高频可裁剪事件（长 run 窗口淘汰只动这些 — 结构性事件保留） */
export const EVICTABLE = new Set(['loop.delta', 'skill.log', 'skill.progress']);

/** 高频事件的滑动窗口：只保留最近这么多条（流式文本 / 技能日志需要一段连续的近期窗口） */
export const EVICTABLE_WINDOW = 600;

/** 结构性事件的硬上限（防极端 run 撑爆内存） */
export const HARD_CAP = 4000;

/**
 * 按 seq 插入（REG-12：REST 回放与 SSE 到达序交错时，旧事件不得回退 UI 状态 —
 * todo 清单 / 工具卡以 seq 为准）。事件基本有序 → 尾部扫描 O(1) 摊销。
 */
export function insertBySeq<T extends { seq?: number }>(prev: T[], ev: T): T[] {
  const next = [...prev, ev];
  let i = next.length - 1;
  while (i > 0 && (next[i - 1].seq ?? 0) > (ev.seq ?? 0)) {
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    i--;
  }
  return next;
}

/**
 * 窗口裁剪（REG-39）：高频事件只保留**最近**的 EVICTABLE_WINDOW 条，从最旧的开始淘汰；
 * 结构性事件照旧全保留，只有其自身超过硬上限时才截尾。
 *
 * 此前是"总数超 800 就把全部高频事件一次丢光"：长任务里流式文本会突然整段消失再从头累积；
 * 结构性事件自身超过 800 条后，每个新到的 delta 都被立刻丢掉 — 流式直播彻底失效。
 */
export function trimEventWindow<T extends Pick<RunEventItem, 'type'>>(events: T[]): T[] {
  let evictable = 0;
  for (const e of events) if (EVICTABLE.has(e.type)) evictable++;
  let out = events;
  if (evictable > EVICTABLE_WINDOW) {
    let drop = evictable - EVICTABLE_WINDOW;
    out = events.filter(e => {
      if (drop > 0 && EVICTABLE.has(e.type)) {
        drop--;
        return false;
      }
      return true;
    });
  }
  // 结构性事件的硬上限（防极端 run 撑爆内存）
  return out.length > HARD_CAP ? out.slice(-HARD_CAP) : out;
}
