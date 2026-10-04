import { spawnSync } from 'child_process';
import type { Tool, ToolResult } from '../types.js';
import { toolOk, toolError } from '../types.js';
import { resolveWorkspacePath } from '../workspace-path.js';
import { platformConfig } from '../../services/config.js';
import { join } from 'path';

/**
 * M1 补强（用户实测驱动）：真实 .docx 读/写。
 * 此前 CORAL 没有任何工具能读 Word 文件（fs_read 拒二进制，llm_only 技能会
 * 幻觉内容），agent 只能在幻觉上盖楼。实现走 skills/_lib/docx_text.py
 * （Python 标准库 zipfile + OOXML，零新依赖）。
 *
 *  · docx_read  — auto 权限：抽取全部段落文本
 *  · docx_write — approval 权限：把 Markdown-ish 纯文本构建为真实 .docx
 */

const MAX_DOCX_BYTES = 10 * 1024 * 1024;

/** 审查 P2：结果缓存 — spawnSync 阻塞事件循环，探测只允许发生一次 */
const PYTHON_CMD_CACHE: { cmd?: string } = {};
function detectPython(): string {
  if (PYTHON_CMD_CACHE.cmd) return PYTHON_CMD_CACHE.cmd;
  const isWin = process.platform === 'win32';
  for (const cmd of isWin ? ['python', 'py', 'python3'] : ['python3', 'python']) {
    const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: isWin });
    if (r.status === 0) { PYTHON_CMD_CACHE.cmd = cmd; return cmd; }
  }
  PYTHON_CMD_CACHE.cmd = isWin ? 'python' : 'python3';
  return PYTHON_CMD_CACHE.cmd;
}

/** 调 docx_text.py（JSON stdin → JSON stdout） */
function runDocxHelper(payload: { mode: 'read' | 'write'; path: string; content?: string }): { ok: true; data: any } | { ok: false; code: string; message: string; retryable?: boolean } {
  const helperPath = join(platformConfig.skillsDir, '_lib', 'docx_text.py');
  const python = detectPython();
  const isWin = process.platform === 'win32';
  const r = spawnSync(python, [helperPath], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: 30_000,
    windowsHide: true,
    shell: isWin,
  });
  if (r.error) {
    return {
      ok: false,
      code: 'PYTHON_UNAVAILABLE',
      message: `Python 不可用（docx 工具需要 Python ≥3.9 且在 PATH 中）：${r.error.message}`,
      retryable: false,
    };
  }
  const out = (r.stdout ?? '').trim();
  try {
    const data = JSON.parse(out);
    if (data.ok === false) {
      return { ok: false, code: 'DOCX_ERROR', message: String(data.error ?? 'docx 处理失败'), retryable: false };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, code: 'DOCX_SCRIPT_ERROR', message: `docx 脚本异常: ${(r.stderr || out || '无输出').slice(0, 300)}`, retryable: false };
  }
}

export const docxReadTool: Tool = {
  name: 'docx_read',
  description:
    'Extract ALL text from a .docx (Word) file in the bound workspace as paragraphs. ' +
    'Use this instead of fs_read for Word documents — fs_read cannot read binary files.',
  inputSchema: {
    type: 'object',
    required: ['path'],
    properties: { path: { type: 'string', description: 'Relative path to the .docx file' } },
  },
  source: 'builtin',
  permission: 'auto',

  async invoke(input: any, ctx): Promise<ToolResult> {
    const path = String(input?.path ?? '');
    if (!path.toLowerCase().endsWith('.docx')) {
      return toolError('BAD_INPUT', '仅支持 .docx 文件');
    }
    const r = resolveWorkspacePath(ctx.workspaceDir, path);
    if (!r.ok) return toolError(r.code, r.message);

    const res = runDocxHelper({ mode: 'read', path: r.absPath });
    if (!res.ok) return toolError(res.code, res.message, res.retryable);
    const data = res.data as any;
    return toolOk({
      path: String(input?.path),
      title: (data.paragraphs?.[0] ?? '').slice(0, 200),
      count: data.count,
      text: (data.paragraphs as string[]).join('\n\n'),
    });
  },
};

export const docxWriteTool: Tool = {
  name: 'docx_write',
  description:
    'Create a REAL Word (.docx) file in the bound workspace from plain text: one line = one paragraph, ' +
    'a line starting with "# " becomes a heading, empty lines become spacers. Use this — NOT fs_write — ' +
    'when the user asks for a Word document; fs_write would produce a fake .docx containing plain text.',
  inputSchema: {
    type: 'object',
    required: ['path', 'content'],
    properties: {
      path: { type: 'string', description: 'Relative output path, must end with .docx' },
      content: { type: 'string', description: 'Document text (# heading / paragraphs / empty-line spacers)' },
    },
  },
  source: 'builtin',
  permission: 'approval', // 落盘写操作 — 与 fs_write 同策略

  async invoke(input: any, ctx): Promise<ToolResult> {
    const path = String(input?.path ?? '');
    const content = input?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return toolError('BAD_INPUT', 'content 必须为非空字符串');
    }
    if (!path.toLowerCase().endsWith('.docx')) {
      return toolError('BAD_INPUT', `输出路径必须以 .docx 结尾: ${path}（生成纯文本请用 fs_write）`);
    }
    if (Buffer.byteLength(content, 'utf-8') > MAX_DOCX_BYTES) {
      return toolError('BAD_INPUT', '内容超过 10MB 上限');
    }
    const r = resolveWorkspacePath(ctx.workspaceDir, path);
    if (!r.ok) return toolError(r.code, r.message);

    const res = runDocxHelper({ mode: 'write', path: r.absPath, content });
    if (!res.ok) return toolError(res.code, res.message, res.retryable);
    const data = res.data as any;

    ctx.emit({
      type: 'artifact',
      payload: { name: path.split(/[\\/]/).pop(), path: r.absPath, type: 'file' },
    });
    return toolOk({
      path: String(input?.path),
      paragraphs: data.paragraphs,
      note: '已生成真实 Word 文档（OOXML），可用 Word/WPS 直接打开',
    });
  },
};

export const docxTools: Tool[] = [docxReadTool, docxWriteTool];
