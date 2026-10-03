import type { FastifyInstance } from 'fastify';
import type { RunEngine } from '../kernel/run-engine.js';
import type { GraphRunService } from '../services/graph-run-service.js';
import { parseAndValidateGraphYaml } from '../kernel/graph/dsl.js';

/**
 * M1-5：Free 模式 run API；M2：Graph 模式接入。
 *  · POST /api/runs                    创建并异步执行（mode=free：goal + sessionId + 预算覆盖；
 *                                      mode=graph：goal + graph（YAML 文本）+ input 运行时输入）
 *  · GET  /api/runs                    列表（session/status/mode 过滤 + 分页）
 *  · GET  /api/runs/:id                详情（run + 全量事件 + checkpoint 元数据）
 *  · GET  /api/runs/:id/events         事件增量分页（afterSeq 游标，M1-9）
 *  · POST /api/runs/:id/cancel         取消（立即中止 loop/工具/LLM/图节点）
 *  · GET  /api/runs/:id/stream         SSE 实时流（taskId=runId 路由 + 心跳）
 *  · POST /api/runs/:id/resume         M2-5：中断的 graph run 从 checkpoint 续跑
 *  · GET  /api/runs/graph/resumable    M2-5：可恢复列表（重启提示）
 *  · POST /api/graphs/validate         M2-2：YAML 校验（Workflow 编辑器用）
 *  · GET  /api/approvals/pending       M2-4：审批中心 — 跨 run 待审批列表
 */
export function registerRunRoutes(app: FastifyInstance, engine: RunEngine, graphSvc?: GraphRunService): void {
  app.post('/api/runs', async (request, reply) => {
    const body = (request.body || {}) as {
      goal?: string;
      sessionId?: string;
      budget?: { maxSteps?: number; maxTokens?: number; maxCostUsd?: number };
      workspaceId?: string;
      extraSystem?: string;
      continueSession?: boolean;
      mode?: 'free' | 'graph';
      /** mode=graph：graph DSL 的 YAML 文本（前端编辑器直传） */
      graph?: string;
      /** mode=graph：运行时输入（覆盖 graph.input 默认值） */
      input?: Record<string, any>;
    };

    if (typeof body.goal !== 'string' || body.goal.trim().length === 0) {
      return reply.status(400).send({ error: '缺少 goal 参数' });
    }

    // M2：Graph 模式分支
    if (body.mode === 'graph') {
      if (!graphSvc) return reply.status(501).send({ error: 'graph 模式未启用' });
      if (typeof body.graph !== 'string' || !body.graph.trim()) {
        return reply.status(400).send({ error: 'graph 模式需要 graph 参数（YAML 文本）' });
      }
      const parsed = parseAndValidateGraphYaml(body.graph);
      if (!parsed.ok) {
        return reply.status(400).send({ error: 'graph 校验失败', issues: parsed.issues });
      }
      try {
        const { runId, sessionId } = graphSvc.startGraphRun({
          goal: body.goal,
          graph: parsed.graph!,
          input: body.input,
          sessionId: body.sessionId,
        });
        return reply.status(201).send({ runId, sessionId, status: 'running', mode: 'graph' });
      } catch (err: any) {
        return reply.status(400).send({ error: err?.message ?? '创建 graph run 失败' });
      }
    }

    try {
      const { runId, sessionId } = engine.startRun({
        goal: body.goal,
        sessionId: body.sessionId,
        budget: body.budget,
        workspaceId: body.workspaceId,
        extraSystem: body.extraSystem,
        continueSession: body.continueSession,
      });
      return reply.status(201).send({ runId, sessionId, status: 'running' });
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message ?? '创建 run 失败' });
    }
  });

  app.get('/api/runs', async (request) => {
    const { sessionId, status, mode, limit, offset } = request.query as any;
    return engine.store.list({
      sessionId: sessionId || undefined,
      status: status || undefined,
      mode: mode || undefined,
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
    const run = engine.store.get(runId);
    const result = run?.mode === 'graph' && graphSvc
      ? graphSvc.cancelGraphRun(runId)
      : engine.cancelRun(runId);
    if (!result.ok) return reply.status(404).send({ error: result.message });
    return { success: true, message: result.message };
  });

  // ── M2：Graph 模式端点 ──────────────────────────────────

  // M2-5：可恢复列表（服务重启后的提示）
  app.get('/api/runs/graph/resumable', async () => {
    if (!graphSvc) return { items: [] };
    return { items: graphSvc.listResumable() };
  });

  // M2-5：从最近 checkpoint 续跑
  app.post('/api/runs/:runId/resume', async (request, reply) => {
    const { runId } = request.params as any;
    if (!graphSvc) return reply.status(501).send({ error: 'graph 模式未启用' });
    const result = graphSvc.resumeGraphRun(runId);
    if (!result.ok) return reply.status(400).send({ error: result.message });
    return { success: true, message: result.message };
  });

  // M2-2：YAML 校验（Workflow 编辑器的「校验」按钮）
  app.post('/api/graphs/validate', async (request, reply) => {
    const body = (request.body || {}) as { graph?: string };
    if (typeof body.graph !== 'string') {
      return reply.status(400).send({ error: '缺少 graph 参数（YAML 文本）' });
    }
    const parsed = parseAndValidateGraphYaml(body.graph);
    return {
      ok: parsed.ok,
      issues: parsed.issues,
      ...(parsed.ok ? { topoOrder: parsed.topoOrder, graph: parsed.graph } : {}),
    };
  });

  // M2-3：goal→graph AI 编译（x-planning 提示随技能清单注入；校验失败自愈重试一次）
  app.post('/api/graphs/compile', async (request, reply) => {
    const body = (request.body || {}) as { goal?: string };
    if (!graphSvc) return reply.status(501).send({ error: 'graph 模式未启用' });
    if (typeof body.goal !== 'string' || !body.goal.trim()) {
      return reply.status(400).send({ error: '缺少 goal 参数' });
    }
    const { llmClient } = await import('../services/llm-client.js');
    const { FilesystemSkillRegistry } = await import('../skill-runtime/filesystem-registry.js');
    const { platformConfig } = await import('../services/config.js');
    const { compileGoalToGraph } = await import('../kernel/graph/graph-compiler.js');
    const registry = new FilesystemSkillRegistry(platformConfig.skillsDir);
    await registry.reloadAll();
    const hints = registry.listAll().map((m: any) => ({
      name: m.name,
      description: m.description,
      inputSchema: m.inputSchema,
      outputSchema: m.outputSchema,
      ...(m.xPlanning ? { xPlanning: m.xPlanning } : {}),
    }));
    const result = await compileGoalToGraph(body.goal, hints, llmClient as any);
    if (!result.ok) return reply.status(422).send({ error: result.error, issues: result.issues });
    return { graph: result.graph, yaml: result.yaml, attempts: result.attempts };
  });

  // M2-4：审批中心 — 跨 run 待审批（free 工具审批 + graph 节点审批合并）
  app.get('/api/approvals/pending', async () => {
    const items: Array<Record<string, any>> = [];
    for (const r of engine.store.list({ limit: 50 }).items) {
      if (r.status !== 'waiting_human') continue;
      for (const p of engine.listPendingApprovals(r.id)) {
        items.push({ runId: r.id, kind: 'tool', ...p });
      }
    }
    if (graphSvc) {
      for (const p of graphSvc.listAllPendingApprovals()) {
        items.push({ kind: 'node', ...p });
      }
    }
    return { items };
  });

  // M1 复审补（用户反馈）：删除对话 — 单个 run / 整个会话
  app.delete('/api/runs/:runId', async (request, reply) => {
    const { runId } = request.params as any;
    const result = engine.deleteRun(runId);
    if (!result.ok) return reply.status(404).send({ error: result.message });
    return { success: true, message: result.message };
  });

  app.delete('/api/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as any;
    const deleted = engine.deleteSession(sessionId);
    if (deleted === 0) return reply.status(404).send({ error: '会话不存在' });
    return { success: true, deleted };
  });

  // M1-10：审批流 — 解决一个待审批（diff 卡片的 通过/拒绝）
  app.post('/api/runs/:runId/approvals/:approvalId', async (request, reply) => {
    const { runId, approvalId } = request.params as any;
    const body = (request.body || {}) as { approved?: boolean; input?: Record<string, any> };
    const run = engine.store.get(runId);
    // M2-4：graph 节点审批支持改参数后继续（input 覆盖节点输入）
    const ok = run?.mode === 'graph' && graphSvc
      ? graphSvc.resolveApproval(runId, approvalId, Boolean(body.approved), body.input)
      : engine.resolveApproval(runId, approvalId, Boolean(body.approved));
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
