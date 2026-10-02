import type { FastifyInstance } from 'fastify';
import { WorkspaceService } from '../services/workspace-service.js';

/**
 * M1-10（D11-D14）：多工作区 API。
 * 权限档（D12）：readonly / ask（出厂默认）/ auto。
 */
export function registerWorkspaceRoutes(app: FastifyInstance): void {
  const service = new WorkspaceService();

  app.get('/api/workspaces', async () => service.list());

  app.post('/api/workspaces', async (request, reply) => {
    const body = (request.body || {}) as { name?: string; dir?: string; permission?: string };
    try {
      const ws = service.create({
        name: String(body.name ?? ''),
        dir: String(body.dir ?? ''),
        permission: body.permission as any,
      });
      return reply.status(201).send(ws);
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message ?? '创建失败' });
    }
  });

  app.patch('/api/workspaces/:id', async (request, reply) => {
    const { id } = request.params as any;
    const body = (request.body || {}) as { name?: string; permission?: string };
    try {
      const ws = service.update(id, body);
      if (!ws) return reply.status(404).send({ error: '工作区不存在' });
      return ws;
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message ?? '更新失败' });
    }
  });

  app.delete('/api/workspaces/:id', async (request, reply) => {
    const { id } = request.params as any;
    const ok = service.remove(id);
    if (!ok) return reply.status(404).send({ error: '工作区不存在' });
    return { success: true };
  });

  app.post('/api/workspaces/:id/activate', async (request, reply) => {
    const { id } = request.params as any;
    try {
      return service.activate(id);
    } catch (err: any) {
      return reply.status(404).send({ error: err?.message ?? '激活失败' });
    }
  });
}
