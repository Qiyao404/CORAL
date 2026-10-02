import type { FastifyInstance } from 'fastify';
import { MemoryService } from '../services/memory-service.js';
import { platformConfig } from '../services/config.js';

/**
 * 创新点③：记忆查看/编辑 API — 透明性卖点可视化（Settings 页记忆卡）。
 */
export function registerMemoryRoutes(app: FastifyInstance): void {
  const service = () => new MemoryService(platformConfig.memoryDir);

  app.get('/api/memory', async () => {
    const files = service().list();
    return { items: files, dir: platformConfig.memoryDir };
  });

  app.get('/api/memory/:name', async (request, reply) => {
    const { name } = request.params as any;
    const r = service().read(name);
    if (!r) return reply.status(404).send({ error: '记忆文件不存在' });
    return { name: service().sanitizeName(name), content: r.content, truncated: r.truncated, size: r.size };
  });

  app.put('/api/memory/:name', async (request, reply) => {
    const { name } = request.params as any;
    const body = (request.body || {}) as { content?: string };
    if (typeof body.content !== 'string') {
      return reply.status(400).send({ error: '缺少 content' });
    }
    try {
      const w = service().write(name, body.content);
      return { written: w.name, bytes: w.bytes, truncated: w.truncated };
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message ?? '写入失败' });
    }
  });

  app.delete('/api/memory/:name', async (request, reply) => {
    const { name } = request.params as any;
    const svc = service();
    const safe = svc.sanitizeName(name);
    const { unlinkSync, existsSync } = await import('fs');
    const { join } = await import('path');
    const abs = join(svc.dirPath, safe ?? '');
    if (!safe || !existsSync(abs)) return reply.status(404).send({ error: '记忆文件不存在' });
    unlinkSync(abs);
    return { success: true, deleted: safe };
  });
}
