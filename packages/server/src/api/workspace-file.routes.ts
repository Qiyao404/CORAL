import type { FastifyInstance } from 'fastify';
import { writeFileSync, mkdirSync, readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { WorkspaceService } from '../services/workspace-service.js';
import { resolveWorkspacePath } from '../tools/workspace-path.js';
import { extractDocxText } from '../tools/builtin/docx.js';

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

  // 递归列出工作区文件（@引用选择器数据源 — 覆盖子目录如 research/xx.md）
  app.get('/api/workspaces/:id/files', async (request, reply) => {
    const { id } = request.params as any;
    const ws = workspaceService.get(id);
    if (!ws) return reply.status(404).send({ error: '工作区不存在' });

    try {
      const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'dist', '.trash']);
      const items: Array<{ name: string; rel: string; size: number }> = [];
      const walk = (dir: string, prefix: string, depth: number) => {
        if (depth > 4 || items.length >= 300) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (items.length >= 300) return;
          if (e.name.startsWith('.')) continue;
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            walk(join(dir, e.name), rel, depth + 1);
          } else if (e.isFile()) {
            let size = 0;
            try { size = statSync(join(dir, e.name)).size; } catch { /* 竞态 */ }
            items.push({ name: e.name, rel, size });
          }
        }
      };
      walk(ws.dir, '', 0);
      items.sort((a, b) => a.rel.localeCompare(b.rel));
      return { items };
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message ?? '读取失败' });
    }
  });

// ── 文件预览（回复底部产物 chips 的右侧面板数据源）──────────────────────

const TEXT_EXTS = new Set(['md', 'txt', 'json', 'csv', 'js', 'ts', 'py', 'html', 'htm', 'xml', 'log', 'yml', 'yaml', 'ini', 'toml', 'sql', 'sh', 'css']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);
const MAX_PREVIEW_TEXT = 200 * 1024;

const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
};

function extOf(p: string): string {
  return p.split('.').pop()?.toLowerCase() ?? '';
}

app.get('/api/workspaces/:id/preview', async (request, reply) => {
  const { id } = request.params as any;
  const ws = workspaceService.get(id);
  if (!ws) return reply.status(404).send({ error: '工作区不存在' });
  const relPath = String((request.query as any).path ?? '');
  const r = resolveWorkspacePath(ws.dir, relPath);
  if (!r.ok) return reply.status(400).send({ error: r.message });
  if (!existsSync(r.absPath) || !statSync(r.absPath).isFile()) {
    return reply.status(404).send({ error: `文件不存在: ${relPath}` });
  }

  const ext = extOf(relPath);
  const size = statSync(r.absPath).size;

  // 文本类：直接回内容（docx 走 python 提取全文文本）
  if (TEXT_EXTS.has(ext)) {
    const text = readFileSync(r.absPath, 'utf-8');
    return {
      kind: 'text', name: relPath.split(/[\/]/).pop(), size,
      content: text.length > MAX_PREVIEW_TEXT ? text.slice(0, MAX_PREVIEW_TEXT) + '\n\n[...预览截断，全文请下载]' : text,
    };
  }
  if (ext === 'docx') {
    const text = extractDocxText(r.absPath);
    if (text === null) {
      return { kind: 'binary', name: relPath.split(/[\/]/).pop(), size, note: 'docx 文本提取不可用（需要 Python）— 可下载后用 Word 打开' };
    }
    return {
      kind: 'text', name: relPath.split(/[\/]/).pop(), size,
      content: text.length > MAX_PREVIEW_TEXT ? text.slice(0, MAX_PREVIEW_TEXT) + '\n\n[...预览截断]' : text,
    };
  }
  if (ext === 'pdf' || IMAGE_EXTS.has(ext)) {
    // 浏览器原生渲染：前端拿 raw URL 塞 iframe/img
    return { kind: ext === 'pdf' ? 'pdf' : 'image', name: relPath.split(/[\/]/).pop(), size, rawUrl: `/api/workspaces/${id}/raw?path=${encodeURIComponent(relPath)}` };
  }
  return { kind: 'binary', name: relPath.split(/[\/]/).pop(), size, rawUrl: `/api/workspaces/${id}/raw?path=${encodeURIComponent(relPath)}&download=1` };
});

app.get('/api/workspaces/:id/raw', async (request, reply) => {
  const { id } = request.params as any;
  const ws = workspaceService.get(id);
  if (!ws) return reply.status(404).send({ error: '工作区不存在' });
  const q = request.query as any;
  const relPath = String(q.path ?? '');
  const r = resolveWorkspacePath(ws.dir, relPath);
  if (!r.ok) return reply.status(400).send({ error: r.message });
  if (!existsSync(r.absPath) || !statSync(r.absPath).isFile()) {
    return reply.status(404).send({ error: `文件不存在: ${relPath}` });
  }
  const ext = extOf(relPath);
  const buf = readFileSync(r.absPath);
  reply.header('Content-Type', MIME[ext] ?? 'application/octet-stream');
  reply.header('Cache-Control', 'no-cache');
  if (q.download) {
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(relPath.split(/[\/]/).pop() ?? 'file')}"`);
  }
  return reply.send(buf);
});
}
