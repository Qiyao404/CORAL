import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { Tool, ToolResult } from '../types.js';
import { toolOk, toolError } from '../types.js';
import { resolveWorkspacePath } from '../workspace-path.js';

/**
 * M1-10（D20）：fs_search — 工作区内关键词搜索（glob 思路的扩展名过滤 + 行级 grep）。
 * 没有它，「读文件夹」是残缺的。只读 → auto 权限。零新依赖。
 */

const MAX_FILES_SCANNED = 2000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_MATCHES = 80;
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.tar',
  '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.mp3', '.mp4', '.avi', '.mov', '.wav',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.db', '.sqlite', '.docx', '.xlsx', '.pptx',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.history', '.trash']);

export const fsSearchTool: Tool = {
  name: 'fs_search',
  description:
    'Search for a keyword across text files in the bound workspace (recursive, case-insensitive, ' +
    'returns file/line/text matches). Optional extension filter like ".ts,.md". Use it to locate code, config or notes before reading whole files.',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Keyword to find (case-insensitive substring)' },
      path: { type: 'string', description: 'Sub-directory to search within (default workspace root)' },
      extensions: { type: 'string', description: 'Comma-separated extension filter, e.g. ".ts,.md"' },
      max_results: { type: 'integer', description: 'Max matches (default 40, max 80)' },
    },
  },
  source: 'builtin',
  permission: 'auto',

  async invoke(input: any, ctx): Promise<ToolResult> {
    const query = String(input?.query ?? '').trim().toLowerCase();
    if (!query) return toolError('BAD_INPUT', 'query 必填');

    const r = resolveWorkspacePath(ctx.workspaceDir, String(input?.path ?? '.'));
    if (!r.ok) return toolError(r.code, r.message);
    const root = r.absPath;

    const extFilter = String(input?.extensions ?? '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(e => e.startsWith('.'));
    const maxResults = Math.min(Math.max(Number(input?.max_results) || 40, 1), MAX_MATCHES);

    const matches: Array<{ file: string; line: number; text: string }> = [];
    let scanned = 0;
    let truncated = false;

    const walk = (dir: string) => {
      if (truncated) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (truncated) return;
        if (entry.name.startsWith('.')) continue;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(abs);
          continue;
        }
        if (!entry.isFile() || scanned >= MAX_FILES_SCANNED) continue;
        if (BINARY_EXTS.has(entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase())) continue;
        if (extFilter.length > 0 && !extFilter.some(e => entry.name.toLowerCase().endsWith(e))) continue;
        scanned++;

        let text: string;
        try {
          if (statSync(abs).size > MAX_FILE_BYTES) continue;
          text = readFileSync(abs, 'utf-8');
        } catch {
          continue;
        }
        if (text.slice(0, 8192).includes('\0')) continue; // 二进制嗅探

        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(query)) {
            matches.push({
              file: abs.slice(root.length + 1).replace(/\\/g, '/'),
              line: i + 1,
              text: lines[i].trim().slice(0, 240),
            });
            if (matches.length >= maxResults) {
              truncated = true;
              return;
            }
          }
        }
      }
    };

    try {
      walk(root);
    } catch { /* 尽力而为 */ }

    return toolOk({
      query,
      scanned,
      matches,
      truncated,
      note: matches.length === 0 ? '无匹配' : undefined,
    });
  },
};
