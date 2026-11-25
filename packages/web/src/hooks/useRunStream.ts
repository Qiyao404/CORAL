import { useEffect, useRef, useState, useCallback } from 'react';
import { insertBySeq, trimEventWindow } from './run-event-window';

/**
 * M1-8：v2 run 实时事件流 hook（M4 审查批次升级）。
 * · GET /api/runs/:id 事件先回放（断线/晚加入不丢），再挂 SSE /api/runs/:id/stream
 * · eventId 去重 + **按 seq 定序插入**（REG-12：REST 回放与 SSE 到达序交错时旧事件
 *   不得回退 UI 状态——todo 清单/工具卡以 seq 为准）
 * · SSE 重连（onopen）时按 afterSeq 游标补拉断线期间的事件（REG-12：断线空洞）
 * · 事件窗口裁剪只裁高频 delta 类事件，结构性事件（todo/run 终态/审批）永久保留
 *   （定序与裁剪的纯逻辑在 run-event-window.ts，可单测）
 * · 只直播、不落库的事件（思考过程 loop.reasoning）不进事件窗口，经 onTransient 旁路交给调用方
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
  /** 前端收到这条事件的本地时刻（思考计时用：服务端时间戳不可信 / 是回放时以它为准） */
  receivedAt?: number;
}

/** 只直播、不落库的事件：服务端不回放，所以不进事件窗口（进窗口会让重连后的回放与实时流对不上） */
export const TRANSIENT_EVENT_TYPES = new Set(['loop.reasoning']);

export function useRunStream(runId?: string, onTransient?: (ev: any) => void) {
  const [events, setEvents] = useState<RunEventItem[]>([]);
  const [connected, setConnected] = useState(false);

  const seen = useRef<Set<string>>(new Set());
  const cursorRef = useRef(0);
  // 回调放 ref：调用方每次渲染传新的闭包也不会让 SSE 重新订阅
  const transientRef = useRef(onTransient);
  transientRef.current = onTransient;

  const push = useCallback((ev: RunEventItem) => {
    if (!ev?.eventId || seen.current.has(ev.eventId)) return;
    seen.current.add(ev.eventId);
    cursorRef.current = Math.max(cursorRef.current, ev.seq ?? 0);
    setEvents(prev => trimEventWindow(insertBySeq(prev, { ...ev, receivedAt: Date.now() })));
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
      let parsed: any;
      try {
        parsed = JSON.parse(e.data);
      } catch { /* 忽略 */ return; }
      if (TRANSIENT_EVENT_TYPES.has(parsed?.type)) transientRef.current?.(parsed);
      else push(parsed);
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

/** 抓取类工具：它们的失败可能让结论不完整（回答旁的提示按它们计数） */
export const FETCH_TOOLS = new Set(['http_fetch', 'skill_web-reader']);
const NETWORK_ERROR_CODES = new Set(['HTTP_FAILED', 'HTTP_TIMEOUT', 'NETWORK_DOWN']);
const NETWORK_ERROR_WORDS = /网络|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|超时|timeout|NETWORK_DOWN|proxy|代理/i;
/**
 * 回答旁标注抓取失败的门槛。偶发一两次失败很常见、多半不影响结论；
 * 实测网络层失败 ≥5 次的评测题正确率比零失败的低约 10 个百分点——从 3 次起提醒才既有用又不唠叨。
 */
export const FETCH_FAILURE_WARN_AT = 3;

/** "模型正在思考"的起点：这些主循环事件之后、下一条主循环事件之前，模型调用在途 */
const THINKING_TYPES = new Set(['run.started', 'loop.step_started', 'loop.stalled', 'loop.budget_exceeded']);

/** 思考计时的起点：实时事件用本地收到时刻；回放的旧事件用服务端时间戳（本地时钟刚好慢几秒也不至于显示负数或虚高） */
export function eventTime(ev: RunEventItem): number {
  const ts = Date.parse(ev.timestamp ?? '');
  const local = ev.receivedAt ?? Date.now();
  return Number.isFinite(ts) && ts <= local + 5000 ? Math.min(ts, local) : local;
}

export interface ReasoningLive {
  runId: string;
  step: number;
  text: string;
}

/** 思考文本的保留上限：只留最近的（面板本来就是看"此刻在想什么"，不是存档） */
export const REASONING_CAP = 24_000;

/**
 * 思考过程增量的累积（纯函数，可单测）：只收主循环的（子代理的太吵）；
 * 进入新的一步就从头开始 — 上一步的想法不需要留着。
 */
export function appendReasoning(
  cur: ReasoningLive | null,
  ev: { runId?: string; agentId?: string | null; payload?: Record<string, any> },
): ReasoningLive | null {
  if ((ev.agentId ?? 'main') !== 'main') return cur;
  const runId = String(ev.runId ?? '');
  const step = Number(ev.payload?.step ?? 0);
  const base = cur && cur.runId === runId && cur.step === step ? cur.text : '';
  const text = base + String(ev.payload?.delta ?? '');
  return { runId, step, text: text.length > REASONING_CAP ? text.slice(-REASONING_CAP) : text };
}

export type RunErrorClass = 'quota' | 'auth' | 'network' | 'timeout' | 'interrupted';

/**
 * 把模型服务 / 运行时的原始报错归成几类人话（失败原因此前是把原始报错整段甩给用户）。
 * 实测任务失败的头号原因是模型服务的用量上限——用户最该看到的是"额度用完了"，而不是一串英文报错。
 */
export function classifyRunError(error: string | null | undefined): RunErrorClass | null {
  const s = String(error ?? '');
  if (!s) return null;
  if (/使用上限|限额|额度|余额|速率限制|请求频率|rate.?limit|quota|insufficient|\b429\b/i.test(s)) return 'quota';
  if (/api.?key|authentication|unauthorized|invalid.*key|密钥|\b401\b/i.test(s)) return 'auth';
  if (/被中断|interrupted|重启|restart/i.test(s)) return 'interrupted';
  if (/timeout|timed out|超时|ETIMEDOUT/i.test(s)) return 'timeout';
  if (/fetch failed|ECONN|ENOTFOUND|network|网络|proxy|代理/i.test(s)) return 'network';
  return null;
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
  let runError: string | null = null;
  const fetchFailures = { total: 0, network: 0 };

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
        // 抓取类工具的失败计数（回答旁的可信度提示）：一次调用内部重试耗尽才计一次
        if (ev.type === 'tool.call_failed' && FETCH_TOOLS.has(String(p.tool ?? ev.toolName ?? ''))) {
          fetchFailures.total++;
          const code = String(p.error?.code ?? '');
          const message = typeof p.error === 'string' ? p.error : String(p.error?.message ?? '');
          if (NETWORK_ERROR_CODES.has(code) || NETWORK_ERROR_WORDS.test(message)) fetchFailures.network++;
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
        endReason = events.some(e => e.type === 'run.budget_exceeded') ? 'budget_exceeded'
          : events.some(e => e.type === 'run.network_down') ? 'network_down'
          : 'final_answer';
        if (typeof p.finalContentPreview === 'string') finalContent = p.finalContentPreview;
        break;
      case 'run.failed': {
        // 失败原因必须带上界面（此前只把状态标成"失败"，用户无从得知为什么）—
        // 原地打转被终止 / 服务重启被中断 / 模型报错，原因都在这个事件的 error 里
        runStatus = 'failed';
        const e = p.error;
        if (typeof e === 'string' && e) runError = e;
        else if (e && typeof e === 'object' && typeof e.message === 'string') runError = e.message;
        break;
      }
      case 'run.cancelled':
        runStatus = 'cancelled';
        break;
      default:
        break;
    }
  }
  // 原地打转被运行时终止（终态事件是 run.failed，原因另发 run.stalled — 界面据此给出"继续"入口）
  if (runStatus === 'failed' && events.some(e => e.type === 'run.stalled')) endReason = 'stalled';
  // 任务已终态：还"挂着"的审批必然是残留（如服务重启被中断的任务，事件流里没有 resolved 事件）— 不再等人操作
  if (runStatus && ['completed', 'failed', 'cancelled'].includes(runStatus)) pendingApprovals.length = 0;
  return { todos, toolCards, pendingApprovals, finalContent, runStatus, endReason, runError, fetchFailures };
}

/**
 * 主循环此刻是否在等模型（"模型思考中"）：看最后一条主循环事件是不是一次模型调用的起点。
 * 只认主循环 — 子代理 / 队友的事件（它们自己的 step_started、delta）与主线程是否在思考无关。
 */
export function deriveThinking(events: RunEventItem[], runStatus: string | null): { since: number; step: number } | null {
  if (runStatus) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if ((ev.agentId ?? 'main') !== 'main') continue;
    if (!THINKING_TYPES.has(ev.type)) return null;
    return { since: eventTime(ev), step: Number(ev.payload?.step ?? 0) };
  }
  return null;
}
