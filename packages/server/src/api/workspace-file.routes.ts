import type { FastifyInstance } from 'fastify';
import { writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { WorkspaceService } from '../services/workspace-service.js';
import { resolveWorkspacePath } from '../tools/workspace-path.js';

/**
 * 创新点②：文件上传到工作区 — 用户拖文件给 agent 处理的入口。
 * 文本/小文件（≤1MB），落盘到工作区路径，agent 随后用 fs 工具读取。
 */
const MAX_FILE_BYTES = 1024 * 1024;

export function registerWorkspaceFileRoutes(
  app: FastifyInstance,
  workspaceService = new WorkspaceService()
): void {
  app.post('/api/workspaces/:id/files', async (request, reply) => {
    const { id } = request.params as any;
    const ws = workspaceService.get(id);
    if (!ws) return reply.status(404).send({ error: '工作区不存在' });

    const body = (request.body || {}) as { path?: string; content?: string; encoding?: string };
    const relPath = String(body.path ?? '').trim();
    const content = typeof body.content === 'string' ? body.content : '';

    if (!relPath) return reply.status(400).send({ error: '缺少 path（工作区内相对路径）' });
    if (!content) return reply.status(400).send({ error: '缺少 content（文本内容）' });
    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_BYTES) {
      return reply.status(413).send({ error: '文件过大（上限 1MB）— 大文件请直接放入工作区目录' });
    }

    // 三层守卫（与 fs 工具同规则）
    const r = resolveWorkspacePath(ws.dir, relPath);
    if (!r.ok) return reply.status(400).send({ error: r.message });
    if (ws.permission === 'readonly') {
      return reply.status(403).send({ error: '只读工作区不允许上传文件' });
    }

    try {
      const parent = r.absPath.replace(/[/\\][^/\\]+$/, '') || r.absPath;
      mkdirSync(parent, { recursive: true });
      const encoding = body.encoding === 'base64' ? ('base64' as const) : 'utf-8';
      writeFileSync(r.absPath, content, encoding as any);
      return reply.status(201).send({
        written: relPath.replace(/\\/g, '/'),
        bytes: Buffer.byteLength(content, encoding as any),
      });
    } catch (err: any) {
      return reply.status(500).send({ error: `写入失败: ${err?.message ?? err}` });
    }
  });

  // 列出某工作区根目录的顶层文件（供前端「附加文件」选择器）
  app.get('/api/workspaces/:id/files', async (request, reply) => {
    const { id } = request.params as any;
    const ws = workspaceService.get(id);
    if (!ws) return reply.status(404).send({ error: '工作区不存在' });

    try {
      const items = readdirSync(ws.dir, { withFileTypes: true })
        .filter(e => e.isFile() && !e.name.startsWith('.'))
        .map(e => {
          let size = 0;
          try { size = statSync(join(ws.dir, e.name)).size; } catch { /* 竞态 */ }
          return { name: e.name, size };
        });
      return { items };
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message ?? '读取失败' });
    }
  });
}
