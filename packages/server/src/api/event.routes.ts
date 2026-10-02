import type { FastifyInstance } from 'fastify';
import { eventBus } from '../event/event-bus.js';
import { auditStore } from '../store/index.js';
import type { CoralEvent } from '../types/index.js';

export function registerEventRoutes(app: FastifyInstance) {
  // 历史事件查询
  app.get('/api/events', async (request) => {
    const { taskId, type, limit } = request.query as any;

    const events = eventBus.history({
      taskId,
      type,
      limit: parseInt(limit) || 200,
    });

    return {
      total: events.length,
      items: events,
    };
  });

  // SSE — 全局/按任务
  app.get('/api/events/stream', async (request, reply) => {
    const { taskId } = request.query as any;
    setupSseHeaders(reply);
    const handler = (event: CoralEvent) => {
      if (taskId && event.taskId !== taskId) return;
      writeSse(reply, event);
    };
    eventBus.on('*', handler);
    request.raw.on('close', () => eventBus.off('*', handler));
  });

  // SSE — 任务专用（v1.1.0 新增 T-106：FR-C 兜底通道）
  app.get('/api/tasks/:taskId/stream', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    setupSseHeaders(reply);

    // 先把历史推送一份，避免错过早于订阅的事件
    // v1.1.1：合并内存 ring buffer + 持久化 audit_logs，按 eventId 去重
    // 让任务完成后/服务重启后重新打开详情页时仍能回放
    const liveHistory = eventBus.history({ taskId, limit: 1000 });
    const persistedHistory = auditStore.findByTaskId(taskId);
    const seen = new Set<string>();
    const merged: CoralEvent[] = [];
    for (const ev of [...persistedHistory, ...liveHistory]) {
      if (!ev?.eventId || seen.has(ev.eventId)) continue;
      seen.add(ev.eventId);
      merged.push(ev);
    }
    merged.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    for (const ev of merged) writeSse(reply, ev);

    const handler = (event: CoralEvent) => {
      if (event.taskId !== taskId) return;
      writeSse(reply, event);
    };
    eventBus.on('*', handler);

    // 心跳，避免代理/Nginx 超时
    const heartbeat = setInterval(() => {
      try { reply.raw.write(': heartbeat\n\n'); } catch { /* ignore */ }
    }, 25000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      eventBus.off('*', handler);
    });
  });
}

function setupSseHeaders(reply: any) {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // 禁用 nginx 缓冲
    // M0-6：移除 v1 手写的 Access-Control-Allow-Origin: * —
    // 开发走 Vite 代理（同源）、生产同源部署，跨域由 CORS 插件白名单统一管理
  });
}

function writeSse(reply: any, event: CoralEvent) {
  try {
    reply.raw.write(`id: ${event.eventId}\n`);
    reply.raw.write(`event: ${event.type}\n`);
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch { /* 客户端已断开 */ }
}
