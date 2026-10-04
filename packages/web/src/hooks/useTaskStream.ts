import { useEffect, useRef, useState, useCallback } from 'react';

export interface CoralEvent {
  eventId: string;
  type: string;
  taskId?: string;
  agentId?: string;
  skillName?: string;
  payload: Record<string, any>;
  timestamp: string;
}

export interface ProgressState {
  agentId: string;
  skillName: string;
  phase: string;
  step?: number;
  total?: number;
  percent: number;
  message: string;
  updatedAt: string;
}

export interface ArtifactItem {
  type: 'markdown' | 'csv' | 'json' | 'file' | 'text';
  name: string;
  path?: string;
  sizeBytes?: number;
  preview?: string;
  agentId: string;
  skillName: string;
  createdAt: string;
}

type Transport = 'none' | 'ws' | 'sse' | 'both';

const MAX_EVENTS = 500;
const MAX_LOGS = 500;

/**
 * v1.1.0 统一任务流 hook（T-401）
 * · WS + SSE 双订阅，按 eventId 去重
 * · 派生 progressByAgent / artifacts / logs / connection
 */
export function useTaskStream(taskId?: string) {
  const [events, setEvents] = useState<CoralEvent[]>([]);
  const [progressByAgent, setProgressByAgent] = useState<Record<string, ProgressState>>({});
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([]);
  const [logs, setLogs] = useState<Array<{ agentId?: string; skillName?: string; level: string; message: string; timestamp: string; source?: string }>>([]);
  const [wsConnected, setWsConnected] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);

  const seenIds = useRef<Set<string>>(new Set());
  const disposedRef = useRef(false); // 审查 P1：cleanup 后拦截 onclose 重连
  const wsRef = useRef<WebSocket | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const pushEvent = useCallback((event: CoralEvent) => {
    if (!event?.eventId || seenIds.current.has(event.eventId)) return;
    seenIds.current.add(event.eventId);
    if (taskId && event.taskId && event.taskId !== taskId) return;

    setEvents(prev => [...prev.slice(-MAX_EVENTS + 1), event]);

    // Progress 派生
    if (event.type === 'skill.progress' && event.agentId) {
      const p = event.payload || {};
      setProgressByAgent(prev => ({
        ...prev,
        [event.agentId!]: {
          agentId: event.agentId!,
          skillName: event.skillName || p.skillName || '',
          phase: p.phase || 'unknown',
          step: typeof p.step === 'number' ? p.step : undefined,
          total: typeof p.total === 'number' ? p.total : undefined,
          percent: typeof p.percent === 'number' ? p.percent
            : (typeof p.step === 'number' && typeof p.total === 'number' && p.total > 0)
              ? Math.round((p.step / p.total) * 100) : 0,
          message: p.message || '',
          updatedAt: event.timestamp,
        },
      }));
    }

    if (event.type === 'skill.log') {
      const p = event.payload || {};
      setLogs(prev => [...prev.slice(-MAX_LOGS + 1), {
        agentId: event.agentId,
        skillName: event.skillName,
        level: p.level || 'info',
        message: p.message || '',
        timestamp: event.timestamp,
        source: p.source,
      }]);
    }

    if (event.type === 'skill.artifact') {
      const a = (event.payload as any)?.artifact;
      if (a) {
        setArtifacts(prev => [
          ...prev,
          {
            ...a,
            agentId: event.agentId || '',
            skillName: event.skillName || '',
            createdAt: event.timestamp,
          },
        ]);
      }
    }

    // Agent 完成时强制把 progress 拉到 100（避免最后一条 progress 漏掉）
    if (event.type === 'agent.completed' && event.agentId) {
      setProgressByAgent(prev => ({
        ...prev,
        [event.agentId!]: {
          ...(prev[event.agentId!] || { agentId: event.agentId!, skillName: '', phase: 'done', message: '', updatedAt: event.timestamp }),
          percent: 100,
          phase: 'done',
          updatedAt: event.timestamp,
        },
      }));
    }
  }, [taskId]);

  // ── WebSocket ──
  const connectWs = useCallback(() => {
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/events`);

      ws.onopen = () => {
        setWsConnected(true);
        if (taskId) {
          ws.send(JSON.stringify({ type: 'subscribe', taskId }));
        }
      };

      ws.onmessage = (msg) => {
        try {
          const event: CoralEvent = JSON.parse(msg.data);
          pushEvent(event);
        } catch { /* ignore */ }
      };

      ws.onclose = () => {
        setWsConnected(false);
        // 审查 P1：cleanup 触发的 close 不再重连（否则 3 秒后以旧 taskId 闭包复活僵尸 WS）
        if (disposedRef.current) return;
        if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        reconnectTimer.current = setTimeout(() => { if (!disposedRef.current) connectWs(); }, 3000);
      };

      ws.onerror = () => { ws.close(); };
      wsRef.current = ws;
    } catch { /* ignore */ }
  }, [taskId, pushEvent]);

  // ── SSE ──
  const connectSse = useCallback(() => {
    if (!taskId) return;
    try {
      const sse = new EventSource(`/api/tasks/${taskId}/stream`);
      sse.onopen = () => setSseConnected(true);
      sse.onerror = () => {
        // 审查 P2：不手动 close — close 后浏览器不再自动重连，SSE 通道永久死亡
        setSseConnected(false);
      };
      // 在所有事件类型上挂载 listener（事件名 = 事件 type）
      const types = [
        'task.created','task.planning','task.plan_ready','task.executing','task.completed','task.failed','task.cancelled',
        'agent.spawned','agent.started','agent.completed','agent.failed','agent.cancelled','agent.suspended','agent.resumed',
        'skill.executing','skill.completed','skill.failed','skill.sandbox_started','skill.sandbox_finished',
        'skill.progress','skill.log','skill.artifact',
        'skill.registered','skill.updated','skill.removed',
      ];
      const listener = (e: MessageEvent) => {
        try { pushEvent(JSON.parse(e.data)); } catch { /* */ }
      };
      sse.onmessage = listener;
      for (const t of types) sse.addEventListener(t, listener as any);
      sseRef.current = sse;
    } catch { /* ignore */ }
  }, [taskId, pushEvent]);

  useEffect(() => {
    disposedRef.current = false;
    // 审查 P1：taskId 变化（路由复用组件）先清全部状态 — 旧任务的产物/事件不混入新任务
    setEvents([]);
    setArtifacts([]);
    setLogs([]);
    setProgressByAgent({});
    seenIds.current = new Set();
    connectWs();
    connectSse();
    return () => {
      disposedRef.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      sseRef.current?.close();
    };
  }, [connectWs, connectSse]);

  const transport: Transport = wsConnected && sseConnected
    ? 'both'
    : wsConnected
    ? 'ws'
    : sseConnected
    ? 'sse'
    : 'none';

  /**
   * 重放外部历史事件（如 GET /api/tasks/:taskId 返回的持久化 events）
   * · 通过 eventId 去重，重复事件不会被处理两次
   * · 让任务完成后重新进入详情页时也能恢复进度/产物/日志
   */
  const seedEvents = useCallback((seed?: CoralEvent[] | null) => {
    if (!Array.isArray(seed) || seed.length === 0) return;
    for (const ev of seed) pushEvent(ev);
  }, [pushEvent]);

  return {
    events,
    progressByAgent,
    artifacts,
    logs,
    transport,
    connected: wsConnected || sseConnected,
    wsConnected,
    sseConnected,
    seedEvents,
  };
}
