import type { FastifyInstance } from 'fastify';
import type { TriggerService } from '../services/trigger-service.js';

/**
 * M3-5：触发器 API。
 *  · GET/POST   /api/triggers             列表 / 创建（interval|cron|webhook）
 *  · PATCH      /api/triggers/:id         启停 { enabled }
 *  · DELETE     /api/triggers/:id         删除
 *  · POST       /api/hooks/:id            webhook 入站（body 变量注入 goal 的 {{key}}）
 */
export function registerTriggerRoutes(app: FastifyInstance, triggers: TriggerService): void {
  app.get('/api/triggers', async () => ({ items: triggers.list() }));

  app.post('/api/triggers', async (request, reply) => {
    const body = (request.body || {}) as {
      name?: string;
      kind?: 'interval' | 'cron' | 'webhook';
      spec?: string;
      action?: { mode?: 'free' | 'graph'; goal?: string; graph?: string; workspaceId?: string };
    };
    if (typeof body.name !== 'string' || !['interval', 'cron', 'webhook'].includes(body.kind ?? '')) {
      return reply.status(400).send({ error: '需要 name 和 kind（interval/cron/webhook）' });
    }
    const r = triggers.create({
      name: body.name,
      kind: body.kind!,
      spec: body.spec ?? '',
      action: {
        mode: body.action?.mode ?? 'free',
        goal: body.action?.goal ?? '',
        graph: body.action?.graph,
        workspaceId: body.action?.workspaceId,
      },
    });
    if (!r.ok) return reply.status(400).send({ error: r.message });
    return reply.status(201).send(r);
  });

  app.patch('/api/triggers/:id', async (request, reply) => {
    const { id } = request.params as any;
    const body = (request.body || {}) as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') return reply.status(400).send({ error: '需要 enabled' });
    const r = triggers.setEnabled(id, body.enabled);
    if (!r.ok) return reply.status(404).send({ error: r.message });
    return r;
  });

  app.delete('/api/triggers/:id', async (request, reply) => {
    const { id } = request.params as any;
    const r = triggers.remove(id);
    if (!r.ok) return reply.status(404).send({ error: r.message });
    return r;
  });

  // 入站 webhook：POST /api/hooks/:id（body 的顶层键可注入 goal 的 {{key}}）
  app.post('/api/hooks/:id', async (request, reply) => {
    const { id } = request.params as any;
    const body = (request.body || {}) as Record<string, any>;
    const r = await triggers.fireWebhook(id, { body });
    if (!r.ok) return reply.status(id.startsWith('hook_') ? 409 : 404).send({ error: r.message });
    return { success: true, runId: r.runId };
  });
}
