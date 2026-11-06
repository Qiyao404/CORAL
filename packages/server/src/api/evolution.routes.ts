import type { FastifyInstance } from 'fastify';
import type { EvolutionService } from '../services/evolution-service.js';

/**
 * 演化提议 API（自进化闭环的人审面）：
 *  · GET   /api/evolution/proposals?status=pending   提议列表（技能修订/新技能/画像）
 *  · POST  /api/evolution/proposals/:id/decide       裁决 { accept: boolean }
 *     — 技能类接受即写盘热加载（旧版备份 .history/）；画像类接受即并入画像
 */
export function registerEvolutionRoutes(app: FastifyInstance, evolution: EvolutionService): void {
  app.get('/api/evolution/proposals', async (request) => {
    const { status } = (request.query ?? {}) as { status?: string };
    const valid = status === 'pending' || status === 'accepted' || status === 'rejected' ? status : undefined;
    const items = evolution.list(valid);
    return { items, pending: evolution.list('pending').length };
  });

  app.post('/api/evolution/proposals/:id/decide', async (request, reply) => {
    const { id } = request.params as any;
    const body = (request.body || {}) as { accept?: boolean };
    if (typeof body.accept !== 'boolean') {
      return reply.status(400).send({ error: '需要 accept（boolean）' });
    }
    const r = await evolution.decide(String(id), body.accept);
    if (!r.ok) return reply.status(400).send({ error: r.message });
    return r;
  });
}
