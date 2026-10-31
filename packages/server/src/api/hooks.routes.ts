import type { FastifyInstance } from 'fastify';
import type { HookService, HookEvent } from '../hooks/hook-service.js';
import { HOOK_EVENTS } from '../hooks/hook-service.js';

/**
 * Hooks 管理 API（左侧「钩子」页）— 把 data/hooks.json 从手工文件变成可视化配置：
 *  · GET  /api/hooks         当前配置 + 配置文件路径 + 最近命中记录（环形缓冲）
 *  · PUT  /api/hooks         全量保存（校验：事件名 / command / matcher 正则 / timeout 1-300）
 *  · POST /api/hooks/test    样例载荷真实执行一条命令（stdin JSON / stdout 决策 / exit 2 = deny）
 */
export function registerHooksRoutes(app: FastifyInstance, hooks: HookService): void {
  app.get('/api/hooks', async () => {
    return {
      configPath: hooks.path,
      events: HOOK_EVENTS,
      hooks: hooks.listConfig(),
      recent: hooks.recentFirings(),
    };
  });

  app.put('/api/hooks', async (request, reply) => {
    const body = (request.body || {}) as { hooks?: Record<string, unknown> };
    if (!body.hooks || typeof body.hooks !== 'object') {
      return reply.status(400).send({ error: '缺少 hooks（按事件分组的配置对象）' });
    }
    const r = hooks.saveConfig(body.hooks);
    if (!r.ok) return reply.status(400).send({ error: r.error });
    return { saved: true, hooks: hooks.listConfig() };
  });

  app.post('/api/hooks/test', async (request, reply) => {
    const body = (request.body || {}) as {
      event?: string; command?: string; timeout?: number; sample?: Record<string, any>;
    };
    if (!HOOK_EVENTS.includes(body.event as HookEvent)) {
      return reply.status(400).send({ error: `event 必须是: ${HOOK_EVENTS.join(' / ')}` });
    }
    if (typeof body.command !== 'string' || !body.command.trim()) {
      return reply.status(400).send({ error: 'command 不能为空' });
    }
    const result = await hooks.test(
      body.event as HookEvent,
      body.command.trim(),
      Number(body.timeout) || 10,
      body.sample ?? {},
    );
    return result;
  });
}
