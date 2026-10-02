import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * M1-8：v2 run 实时事件流 hook。
 * · GET /api/runs/:id 事件先回放（断线/晚加入不丢），再挂 SSE /api/runs/:id/stream
 * · eventId 去重；SSE 断开后用 afterSeq 游标补拉（双保险）
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

export function useRunStream(runId?: string) {
  const [events, setEvents] = useState<RunEventItem[]>([]);
  const [connected, setConnected] = useState(false);

  const seen = useRef<Set<string>>(new Set());
  const cursorRef = useRef(0);

  const push = useCallback((ev: RunEventItem) => {
    if (!ev?.eventId || seen.current.has(ev.eventId)) return;
    seen.current.add(ev.eventId);
    cursorRef.current = Math.max(cursorRef.current, ev.seq ?? 0);
    setEvents(prev => [...prev.slice(-800), ev]);
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

  // SSE 实时
  useEffect(() => {
    if (!runId) return;
    const es = new EventSource(`/api/runs/${runId}/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const onMsg = (e: MessageEvent) => {
      try {
        push(JSON.parse(e.data));
      } catch { /* 忽略 */ }
    };
    es.onmessage = onMsg;
    return () => {
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
        endReason = 'run.budget_exceeded' === events.find(e => e.type === 'run.budget_exceeded')?.type
          ? 'budget_exceeded' : 'final_answer';
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
