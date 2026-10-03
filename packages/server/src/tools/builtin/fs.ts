import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'fs';
import { join, relative, dirname } from 'path';
import type { Tool, ToolResult } from '../types.js';
import { toolOk, toolError } from '../types.js';
import { resolveWorkspacePath } from '../workspace-path.js';
import { unifiedDiff } from '../diff.js';

/**
 * M1-2：内置 fs 工具组 — Agentic Workspace 的手（D11/D12）。
 *
 *  · fs_list / fs_read：只读 → permission: auto
 *  · fs_write / fs_edit：落盘改动 → permission: approval（diff 审批 UI 在 M1-10 接管）
 *  · 全部路径经 resolveWorkspacePath 三层守卫（穿越/软链接/未绑定）
 *  · 写改产出 unified diff（返回给模型与审批卡片）
 */

const MAX_READ_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 500;

export const fsListTool: Tool = {
  name: 'fs_list',
  description:
    'List files and directories under a path in the bound workspace (relative path, default "."). ' +
    'Non-recursive by default; recursive=true walks subdirectories (bounded).',
  inputSchema: {
    type: 'object',
    required: [],
    properties: {
      path: { type: 'string', description: 'Relative path within workspace (default ".")' },
      recursive: { type: 'boolean', description: 'Walk subdirectories (default false)' },
    },
  },
  source: 'builtin',
  permission: 'auto',

  async invoke(input: any, ctx): Promise<ToolResult> {
    const r = resolveWorkspacePath(ctx.workspaceDir, String(input?.path ?? '.'));
        if (!r.ok) return toolError(r.code, r.message);
    if (!existsDir(r.absPath)) return toolError('NOT_A_DIRECTORY', `不是目录: ${input?.path ?? '.'}`);

    const entries: Array<{ path: string; type: 'file' | 'dir'; size?: number; modifiedAt?: string }> = [];
    const walk = (dir: string, recursive: boolean) => {
      for (const name of readdirSync(dir)) {
        if (entries.length >= MAX_LIST_ENTRIES) return;
        const abs = join(dir, name);
        const rel = relative(r.absPath, abs).replace(/\\/g, '/');
        const st = safeStat(abs);
        if (!st) continue;
        if (st.isDirectory()) {
          entries.push({ path: rel, type: 'dir' });
          if (recursive) walk(abs, true);
        } else {
          entries.push({ path: rel, type: 'file', size: st.size, modifiedAt: st.mtime.toISOString() });
        }
      }
    };
    walk(r.absPath, Boolean(input?.recursive));

    return toolOk({
      path: String(input?.path ?? '.'),
      entries,
      truncated: entries.length >= MAX_LIST_ENTRIES,
    });
  },
};

export const fsReadTool: Tool = {
  name: 'fs_read',
  description:
    'Read a UTF-8 text file from the bound workspace (relative path). ' +
    'Large files are truncated to 256KB; binary files are rejected with metadata.',
  inputSchema: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'Relative file path within workspace' },
    },
  },
  source: 'builtin',
  permission: 'auto',

  async invoke(input: any, ctx): Promise<ToolResult> {
    // 健壮性：模型偶用 file 误作键名 — 接受别名
    const relPath = String(input?.path ?? input?.file ?? '');
    const r = resolveWorkspacePath(ctx.workspaceDir, relPath);
    if (!r.ok) return toolError(r.code, r.message);
    if (!existsFile(r.absPath)) return toolError('FILE_NOT_FOUND', `文件不存在: ${relPath}`);

    const buf = readFileSync(r.absPath);
    if (buf.slice(0, 8192).includes(0)) {
      return toolOk({
        path: relPath,
        binary: true,
        size: buf.length,
        note: '二进制文件，内容未回传（Word 文档请用 docx_read）',
      });
    }

    const text = buf.toString('utf-8');
    const truncated = text.length > MAX_READ_BYTES;
    return toolOk({
      path: relPath,
      content: truncated ? text.slice(0, MAX_READ_BYTES) : text,
      size: buf.length,
      truncated,
    });
  },
};

export const fsWriteTool: Tool = {
  name: 'fs_write',
  description:
    'Create or overwrite a UTF-8 text file in the bound workspace (relative path). ' +
    'Overwriting an existing file returns a unified diff of the change.',
  inputSchema: {
    type: 'object',
    required: ['path', 'content'],
    properties: {
      path: { type: 'string', description: 'Relative file path within workspace' },
      content: { type: 'string', description: 'Full file content to write' },
    },
  },
  source: 'builtin',
  permission: 'approval',

  async invoke(input: any, ctx): Promise<ToolResult> {
    if (typeof input?.content !== 'string') {
      return toolError('BAD_INPUT', 'content 必须为字符串');
    }
    const r = resolveWorkspacePath(ctx.workspaceDir, String(input?.path ?? ''));
        if (!r.ok) return toolError(r.code, r.message);

    const existed = existsFile(r.absPath);
    const before = existed ? readFileSync(r.absPath, 'utf-8') : '';
    // 自动创建父目录（模型给出的路径常含新子目录）
    const parent = dirname(r.absPath);
    if (!existsDir(parent)) mkdirSync(parent, { recursive: true });
    writeFileSync(r.absPath, input.content, 'utf-8');

    const diff = existed ? unifiedDiff(before, input.content, String(input.path)) : '';
    return toolOk({
      path: String(input?.path),
      bytes: Buffer.byteLength(input.content, 'utf-8'),
      created: !existed,
      diff,
    });
  },
};

export const fsEditTool: Tool = {
  name: 'fs_edit',
  description:
    'Edit a UTF-8 text file in the bound workspace by replacing an exact text snippet. ' +
    'old_text must appear exactly once unless replace_all=true. Returns a unified diff.',
  inputSchema: {
    type: 'object',
    required: ['path', 'old_text', 'new_text'],
    properties: {
      path: { type: 'string', description: 'Relative file path within workspace' },
      old_text: { type: 'string', description: 'Exact text to find' },
      new_text: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
  },
  source: 'builtin',
  permission: 'approval',

  async invoke(input: any, ctx): Promise<ToolResult> {
    if (typeof input?.old_text !== 'string' || typeof input?.new_text !== 'string') {
      return toolError('BAD_INPUT', 'old_text / new_text 必须为字符串');
    }
    if (input.old_text === '') {
      return toolError('BAD_INPUT', 'old_text 不能为空');
    }
    const r = resolveWorkspacePath(ctx.workspaceDir, String(input?.path ?? ''));
        if (!r.ok) return toolError(r.code, r.message);
    if (!existsFile(r.absPath)) return toolError('FILE_NOT_FOUND', `文件不存在: ${input?.path}`);

    const before = readFileSync(r.absPath, 'utf-8');
    const count = countOccurrences(before, input.old_text);
    if (count === 0) {
      return toolError('MATCH_NOT_FOUND', 'old_text 在文件中未找到（须完全一致，含缩进与换行）');
    }
    if (count > 1 && !input?.replace_all) {
      return toolError('MATCH_AMBIGUOUS', `old_text 出现 ${count} 次：请提供更长且唯一的片段，或设 replace_all=true`);
    }

    const after = input.replace_all
      ? before.split(input.old_text).join(input.new_text)
      : before.replace(input.old_text, input.new_text);
    writeFileSync(r.absPath, after, 'utf-8');

    return toolOk({
      path: String(input?.path),
      replacements: input.replace_all ? count : 1,
      diff: unifiedDiff(before, after, String(input.path)),
    });
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function existsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function existsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeStat(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

export const fsTools: Tool[] = [fsListTool, fsReadTool, fsWriteTool, fsEditTool];
