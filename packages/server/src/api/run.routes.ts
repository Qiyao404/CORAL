import type { FastifyInstance } from 'fastify';
import type { RunEngine } from '../kernel/run-engine.js';

/**
 * M1-5：Free 模式 run API。
 *  · POST /api/runs                    创建并异步执行（goal + sessionId + 预算覆盖）
 *  · GET  /api/runs                    列表（session/status 过滤 + 分页）
 *  · GET  /api/runs/:id                详情（run + 全量事件 + checkpoint 元数据）
 *  · GET  /api/runs/:id/events         事件增量分页（afterSeq 游标，M1-9）
 *  · POST /api/runs/:id/cancel         取消（立即中止 loop/工具/LLM）
 *  · GET  /api/runs/:id/stream         SSE 实时流（taskId=runId 路由 + 心跳）
 */
export function registerRunRoutes(app: FastifyInstance, engine: RunEngine): void {
  app.post('/api/runs', async (request, reply) => {
    const body = (request.body || {}) as {
      goal?: string;
      sessionId?: string;
      budget?: { maxSteps?: number; maxTokens?: number; maxCostUsd?: number };
      workspaceId?: string;
      extraSystem?: string;
    };

    if (typeof body.goal !== 'string' || body.goal.trim().length === 0) {
      return reply.status(400).send({ error: '缺少 goal 参数' });
    }

    try {
      const { runId, sessionId } = engine.startRun({
        goal: body.goal,
        sessionId: body.sessionId,
        budget: body.budget,
        workspaceId: body.workspaceId,
        extraSystem: body.extraSystem,
      });
      return reply.status(201).send({ runId, sessionId, status: 'running' });
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message ?? '创建 run 失败' });
    }
  });

  app.get('/api/runs', async (request) => {
    const { sessionId, status, limit, offset } = request.query as any;
    return engine.store.list({
      sessionId: sessionId || undefined,
      status: status || undefined,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
    });
  });

  app.get('/api/runs/:runId', async (request, reply) => {
    const { runId } = request.params as any;
    const detail = engine.getRunDetail(runId);
    if (!detail) return reply.status(404).send({ error: 'run 不存在' });
    return detail;
  });

  app.get('/api/runs/:runId/events', async (request, reply) => {
    const { runId } = request.params as any;
    const { afterSeq, limit } = request.query as any;
    const run = engine.store.get(runId);
    if (!run) return reply.status(404).send({ error: 'run 不存在' });

    const after = parseInt(afterSeq) || 0;
    const items = engine.events.listByRun(runId, after, parseInt(limit) || 500);
    return {
      runId,
      afterSeq: after,
      // 供客户端续拉游标：最后一条的 seq（无新事件时维持原值）
      nextAfterSeq: items.length > 0 ? items[items.length - 1].seq : after,
      total: engine.events.countByRun(runId),
      items,
    };
  });

  app.post('/api/runs/:runId/cancel', async (request, reply) => {
    const { runId } = request.params as any;
    const result = engine.cancelRun(runId);
    if (!result.ok) return reply.status(404).send({ error: result.message });
    return { success: true, message: result.message };
  });

  // M1-10：审批流 — 解决一个待审批（diff 卡片的 通过/拒绝）
  app.post('/api/runs/:runId/approvals/:approvalId', async (request, reply) => {
    const { runId, approvalId } = request.params as any;
    const body = (request.body || {}) as { approved?: boolean };
    const ok = engine.resolveApproval(runId, approvalId, Boolean(body.approved));
    if (!ok) return reply.status(404).send({ error: '审批不存在或已处理' });
    return { success: true, approved: Boolean(body.approved) };
  });

  // 待审批列表（刷新页面后重取）
  app.get('/api/runs/:runId/approvals', async (request, reply) => {
    const { runId } = request.params as any;
    const run = engine.store.get(runId);
    if (!run) return reply.status(404).send({ error: 'run 不存在' });
    return { items: engine.listPendingApprovals(runId) };
  });

  // SSE — run 专用实时流
  app.get('/api/runs/:runId/stream', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = engine.store.get(runId);
    if (!run) return reply.status(404).send({ error: 'run 不存在' });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // 先回放已持久化的事件（断线/晚加入不丢）
    const { eventBus } = await import('../event/event-bus.js');
    const writeSse = (e: any) => {
      try {
        reply.raw.write(`id: ${e.eventId ?? e.id}\n`);
        // 不发 event: 名 — 客户端 onmessage 只收无名事件（实时性修复：
        // v1 客户端按类型 addEventListener，v2 useRunStream 只挂 onmessage）
        reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
      } catch { /* 客户端已断开 */ }
    };
    for (const e of engine.events.listByRun(runId, 0, 2000)) writeSse(e);

    const handler = (event: any) => {
      if (event.taskId !== runId) return;
      writeSse(event);
    };
    eventBus.on('*', handler);

    const heartbeat = setInterval(() => {
      try { reply.raw.write(': heartbeat\n\n'); } catch { /* ignore */ }
    }, 25000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      eventBus.off('*', handler);
    });
  });
}
