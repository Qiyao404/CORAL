import { useEffect, useRef, useState, useCallback } from 'react';
import type { CoralEvent } from './useTaskStream';

/**
 * 全局事件流 hook —— 全站共享一份 WS 连接，统计运行中任务数与连接状态
 */
export function useGlobalStream() {
  const [wsConnected, setWsConnected] = useState(false);
  const [runningTasks, setRunningTasks] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const disposedRef = useRef(false); // 审查 P1：cleanup 后拦截 onclose 重连
  const taskStateRef = useRef<Map<string, string>>(new Map());

  const recountRunning = useCallback(() => {
    let count = 0;
    for (const [, status] of taskStateRef.current) {
      if (status === 'planning' || status === 'executing') count++;
    }
    setRunningTasks(count);
  }, []);

  const connect = useCallback(() => {
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/events`);

      ws.onopen = () => {
        setWsConnected(true);
        // 审查 P3：重连对账 — 断线期间结束的任务不能永远停在 planning/executing（侧栏虚高）
        taskStateRef.current.clear();
        import('../api/client').then(({ api }) => {
          api.listTasks({ status: 'executing' }).then((d: any) => {
            for (const t of d.items ?? []) taskStateRef.current.set(t.id, 'executing');
            // 终审 P3：planning 也算"进行中"（漏了会侧栏虚低）
            return api.listTasks({ status: 'planning' });
          }).then((d: any) => {
            for (const t of d.items ?? []) taskStateRef.current.set(t.id, 'planning');
            recountRunning();
          }).catch(() => {});
        }).catch(() => {});
      };
      ws.onmessage = (msg) => {
        try {
          const ev: CoralEvent = JSON.parse(msg.data);
          if (ev.type.startsWith('task.') && ev.taskId) {
            const next = ev.type.replace('task.', '');
            // 把 plan_ready 等中间事件归一为 executing
            const status =
              next === 'created' ? 'created' :
              next === 'planning' ? 'planning' :
              next === 'plan_ready' ? 'planning' :
              next === 'executing' ? 'executing' :
              next === 'completed' ? 'completed' :
              next === 'failed' ? 'failed' :
              next === 'cancelled' ? 'cancelled' : next;
            taskStateRef.current.set(ev.taskId, status);
            recountRunning();
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        setWsConnected(false);
        if (disposedRef.current) return; // 审查 P1：cleanup 后不复活
        if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        reconnectTimer.current = setTimeout(() => { if (!disposedRef.current) connect(); }, 3000);
      };
      ws.onerror = () => ws.close();
      wsRef.current = ws;
    } catch { /* */ }
  }, [recountRunning]);

  useEffect(() => {
    disposedRef.current = false;
    connect();
    return () => {
      disposedRef.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { wsConnected, runningTasks };
}
