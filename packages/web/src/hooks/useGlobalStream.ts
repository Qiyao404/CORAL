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

      ws.onopen = () => setWsConnected(true);
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
        if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        reconnectTimer.current = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      wsRef.current = ws;
    } catch { /* */ }
  }, [recountRunning]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { wsConnected, runningTasks };
}
