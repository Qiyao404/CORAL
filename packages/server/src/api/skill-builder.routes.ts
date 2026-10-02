import type { FastifyInstance } from 'fastify';
import type { SkillBuilderService } from '../services/skill-builder-service.js';
import { SkillExistsError } from '../skill-runtime/skill-writer.js';

export function registerSkillBuilderRoutes(app: FastifyInstance, service: SkillBuilderService) {
  // 创建会话
  app.post('/api/skill-builder/sessions', async (request, reply) => {
    const body = (request.body || {}) as any;
    const session = service.createSession(body.userId || 'anonymous');
    return reply.status(201).send(session);
  });

  // 列出会话
  app.get('/api/skill-builder/sessions', async (request) => {
    const { userId } = request.query as any;
    const items = service.listSessions(userId);
    return { total: items.length, items };
  });

  // 获取会话详情
  app.get('/api/skill-builder/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as any;
    const session = service.getSession(sessionId);
    if (!session) return reply.status(404).send({ error: '会话不存在' });
    return session;
  });

  // 用户发送一条消息
  app.post('/api/skill-builder/sessions/:sessionId/messages', async (request, reply) => {
    const { sessionId } = request.params as any;
    const { content } = (request.body || {}) as any;
    if (!content || typeof content !== 'string') {
      return reply.status(400).send({ error: '缺少 content 字段' });
    }
    try {
      const result = await service.sendMessage(sessionId, content);
      return result;
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // 获取预览的 SKILL.md 文本
  app.get('/api/skill-builder/sessions/:sessionId/preview', async (request, reply) => {
    const { sessionId } = request.params as any;
    try {
      const skillMd = service.buildPreview(sessionId);
      return { sessionId, skillMd };
    } catch (err: any) {
      return reply.status(404).send({ error: err.message });
    }
  });

  // 手动 patch draft（前端表单编辑）
  app.patch('/api/skill-builder/sessions/:sessionId/draft', async (request, reply) => {
    const { sessionId } = request.params as any;
    const body = (request.body || {}) as Record<string, any>;
    try {
      const updated = service.patchDraft(sessionId, body);
      return updated;
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // 落盘
  app.post('/api/skill-builder/sessions/:sessionId/commit', async (request, reply) => {
    const { sessionId } = request.params as any;
    const { overwrite } = request.query as any;
    try {
      const manifest = await service.commitSession(sessionId, {
        overwrite: String(overwrite || '') === 'true' || String(overwrite || '') === '1',
      });
      return { success: true, skill: manifest };
    } catch (err: any) {
      if (err instanceof SkillExistsError) {
        return reply.status(409).send({ error: err.message, code: err.code });
      }
      return reply.status(400).send({ error: err.message });
    }
  });

  // 取消
  app.delete('/api/skill-builder/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as any;
    const ok = service.cancelSession(sessionId);
    if (!ok) return reply.status(404).send({ error: '会话不存在' });
    return { success: true };
  });
}
