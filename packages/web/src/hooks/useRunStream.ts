import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * M1-8：v2 run 实时事件流 hook（M4 审查批次升级）。
 * · GET /api/runs/:id 事件先回放（断线/晚加入不丢），再挂 SSE /api/runs/:id/stream
 * · eventId 去重 + **按 seq 定序插入**（REG-12：REST 回放与 SSE 到达序交错时旧事件
 *   不得回退 UI 状态——todo 清单/工具卡以 seq 为准）
 * · SSE 重连（onopen）时按 afterSeq 游标补拉断线期间的事件（REG-12：断线空洞）
 * · 事件窗口裁剪只裁高频 delta 类事件，结构性事件（todo/run 终态/审批）永久保留
 */
export interface RunEventItem {
  eventId: string;
  runId: string;
  seq: number;
  type: string;
  agentId?: string | null;
  toolName?: string | null;
  payload: Record<string, any>;
  timestamp: string;
}

/** 高频可裁剪事件（长 run 窗口淘汰只动这些 — 结构性事件保留） */
const EVICTABLE = new Set(['loop.delta', 'skill.log', 'skill.progress']);

/** 窗口上限（含保留事件的总软上限，防极端 run 撑爆内存） */
const HARD_CAP = 4000;

export function useRunStream(runId?: string) {
  const [events, setEvents] = useState<RunEventItem[]>([]);
  const [connected, setConnected] = useState(false);

  const seen = useRef<Set<string>>(new Set());
  const cursorRef = useRef(0);

  const push = useCallback((ev: RunEventItem) => {
    if (!ev?.eventId || seen.current.has(ev.eventId)) return;
    seen.current.add(ev.eventId);
    cursorRef.current = Math.max(cursorRef.current, ev.seq ?? 0);
    setEvents(prev => {
      // REG-12：按 seq 插入（找第一个更大的事件插到它前面 — 事件基本有序，尾部扫描 O(1) 均摊）
      const next = [...prev, ev];
      let i = next.length - 1;
      while (i > 0 && (next[i - 1].seq ?? 0) > (ev.seq ?? 0)) {
        [next[i - 1], next[i]] = [next[i], next[i - 1]];
        i--;
      }
      // 窗口裁剪：超 800 才裁，只裁高频事件（delta/log/progress），结构性事件全保留
      if (next.length > 800) {
        const kept = next.filter(e => !EVICTABLE.has(e.type));
        return kept.length > HARD_CAP ? kept.slice(-HARD_CAP) : kept;
      }
      return next;
    });
  }, []);

  // 初次挂载：回放持久化事件
  useEffect(() => {
    if (!runId) return;
    seen.current = new Set();
    cursorRef.current = 0;
    setEvents([]);
    let cancelled = false;

    (async () => {
      try {
        const { api } = await import('../api/client');
        const detail = await api.getRun(runId);
        if (cancelled) return;
        for (const ev of detail.events ?? []) push(ev);
      } catch { /* run 不存在等 */ }
    })();

    return () => {
      cancelled = true;
    };
  }, [runId, push]);

  // SSE 实时 + 断线补拉（REG-12）
  useEffect(() => {
    if (!runId) return;
    const es = new EventSource(`/api/runs/${runId}/stream`);
    let disposed = false;

    const backfill = async () => {
      // 终审 P2：按 nextAfterSeq 循环拉到不再前进（单次 500 会漏长 run 尾部）
      try {
        const { api } = await import('../api/client');
        let cursor = cursorRef.current;
        for (let round = 0; round < 20; round++) {
          const d = await api.getRunEvents(runId, cursor);
          const items = d.items ?? [];
          if (!disposed) for (const ev of items) push(ev);
          if (items.length === 0 || (d.nextAfterSeq ?? cursor) <= cursor) break;
          cursor = d.nextAfterSeq;
        }
      } catch { /* 补拉失败不致命 — SSE 会继续推新事件 */ }
    };

    es.onopen = () => {
      setConnected(true);
      if (cursorRef.current > 0) void backfill(); // 首连不需要（挂载回放已做）
    };
    es.onerror = () => setConnected(false);
    const onMsg = (e: MessageEvent) => {
      try {
        push(JSON.parse(e.data));
      } catch { /* 忽略 */ }
    };
    es.onmessage = onMsg;
    return () => {
      disposed = true;
      es.close();
      setConnected(false);
    };
  }, [runId, push]);

  return { events, connected };
}

/** 从事件流派生 UI 状态（工具卡时间线 / todo 清单 / 待审批 / 终态） */
export function deriveRunView(events: RunEventItem[]) {
  const todos: Array<{ content: string; status: string }> = [];
  const toolCards: Array<{
    callId: string;
    tool: string;
    agentId: string;
    status: 'running' | 'ok' | 'failed';
    inputPreview?: string;
    resultPreview?: string;
    error?: string;
  }> = [];
  const pendingApprovals: Array<{ approvalId: string; tool: string; diff: string | null; input: any }> = [];
  let finalContent: string | null = null;
  let runStatus: string | null = null;
  let endReason: string | null = null;

  for (const ev of events) {
    const p = ev.payload ?? {};
    switch (ev.type) {
      case 'todo.updated':
        if (Array.isArray(p.todos)) todos.splice(0, todos.length, ...p.todos);
        break;
      case 'tool.call_started':
        toolCards.push({
          callId: p.callId ?? `${ev.seq}`,
          tool: p.tool ?? ev.toolName ?? '',
          agentId: ev.agentId ?? 'main',
          status: 'running',
          inputPreview: p.inputPreview,
        });
        break;
      case 'tool.call_completed':
      case 'tool.call_failed': {
        const card = [...toolCards].reverse().find(c => c.callId === p.callId && c.status === 'running');
        if (card) {
          card.status = ev.type === 'tool.call_completed' ? 'ok' : 'failed';
          if (p.error) card.error = typeof p.error === 'string' ? p.error : JSON.stringify(p.error);
        }
        break;
      }
      case 'tool.result_preview': {
        const card = [...toolCards].reverse().find(c => c.callId === p.callId);
        if (card) card.resultPreview = p.preview;
        break;
      }
      case 'tool.approval_required':
        pendingApprovals.push({ approvalId: p.approvalId, tool: p.tool, diff: p.diff ?? null, input: p.input });
        break;
      case 'tool.approval_resolved': {
        const idx = pendingApprovals.findIndex(a => a.approvalId === p.approvalId);
        if (idx >= 0) pendingApprovals.splice(idx, 1);
        break;
      }
      case 'run.completed':
        runStatus = 'completed';
        endReason = events.some(e => e.type === 'run.budget_exceeded') ? 'budget_exceeded' : 'final_answer';
        if (typeof p.finalContentPreview === 'string') finalContent = p.finalContentPreview;
        break;
      case 'run.failed':
        runStatus = 'failed';
        break;
      case 'run.cancelled':
        runStatus = 'cancelled';
        break;
      default:
        break;
    }
  }
  return { todos, toolCards, pendingApprovals, finalContent, runStatus, endReason };
}
