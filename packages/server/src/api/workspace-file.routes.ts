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

/** 文本通道防护：内容若按 utf-8 读写会损坏（控制字符/NUL 密集）→ 要求 base64 */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 8000);
  let suspicious = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0 || (c < 9 && c !== 0) || (c > 13 && c < 32)) suspicious++;
  }
  return suspicious / sample.length > 0.1;
}

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
    if (!content) return reply.status(400).send({ error: '缺少 content' });
    // encoding: 'base64' 通道 — 二进制文件（.docx/.xlsx/.png…）用 base64 保真传输
    const isB64 = body.encoding === 'base64';
    const byteLen = isB64 ? Buffer.byteLength(content, 'base64') : Buffer.byteLength(content, 'utf-8');
    if (byteLen > MAX_FILE_BYTES) {
      return reply.status(413).send({ error: `文件过大（${(byteLen / 1024).toFixed(0)}KB，上限 1MB）— 大文件请直接放入工作区目录` });
    }
    if (!isB64 && looksBinary(content)) {
      return reply.status(400).send({ error: '内容疑似二进制 — 请以 base64 编码上传（encoding: "base64"）' });
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
      writeFileSync(r.absPath, content, isB64 ? ('base64' as any) : 'utf-8');
      return reply.status(201).send({
        written: relPath.replace(/\\/g, '/'),
        bytes: byteLen,
        binary: isB64,
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
