import type { Tool } from '../types.js';
import { toolOk, toolError } from '../types.js';
import type { MemoryService } from '../../services/memory-service.js';

/**
 * M1-11（D18）：文件式记忆四工具 — agent 的长期记忆读写。
 * 全部 auto 权限（记忆目录有边界，文件名消毒防穿越）。
 */

export function makeMemoryTools(service: MemoryService): Tool[] {
  const list: Tool = {
    name: 'memory_list',
    description:
      'List long-term memory files (topic-based markdown). Check before writing to update existing topics instead of duplicating.',
    inputSchema: { type: 'object', required: [], properties: {} },
    source: 'builtin',
    permission: 'auto',
    async invoke() {
      const files = service.list();
      return toolOk({ files, count: files.length, note: files.length === 0 ? '记忆为空' : undefined });
    },
  };

  const read: Tool = {
    name: 'memory_read',
    description: 'Read one long-term memory file by name (from memory_list).',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', description: 'File name from memory_list (e.g. user-preferences.md)' } },
    },
    source: 'builtin',
    permission: 'auto',
    async invoke(input: any) {
      const r = service.read(String(input?.name ?? ''));
      if (!r) return toolError('NOT_FOUND', `记忆文件不存在: ${input?.name}`);
      return toolOk({ content: r.content, truncated: r.truncated, size: r.size });
    },
  };

  const write: Tool = {
    name: 'memory_write',
    description:
      'Write (create or replace) a long-term memory file. Use for durable facts: user preferences, corrections, project conventions, lessons learned. ' +
      'Read the existing file first and merge your update into it — do not create near-duplicate topic files.',
    inputSchema: {
      type: 'object',
      required: ['name', 'content'],
      properties: {
        name: { type: 'string', description: 'Short kebab-case topic name (e.g. user-preferences.md)' },
        content: { type: 'string', description: 'Full markdown content of the file' },
      },
    },
    source: 'builtin',
    permission: 'auto',
    async invoke(input: any) {
      if (typeof input?.content !== 'string' || !input.content.trim()) {
        return toolError('BAD_INPUT', 'content 必须为非空字符串');
      }
      try {
        const w = service.write(String(input?.name ?? ''), input.content);
        return toolOk({ written: w.name, bytes: w.bytes, truncated: w.truncated });
      } catch (err: any) {
        return toolError('BAD_NAME', err?.message ?? '非法文件名', false);
      }
    },
  };

  const search: Tool = {
    name: 'memory_search',
    description:
      'Search long-term memory by keywords (case-insensitive; space-separated terms must all appear on the same line). ' +
      'Search at the start of a task for relevant user preferences or past lessons.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string', description: 'Keyword(s), space-separated (AND)' } },
    },
    source: 'builtin',
    permission: 'auto',
    async invoke(input: any) {
      const query = String(input?.query ?? '').trim();
      if (!query) return toolError('BAD_INPUT', 'query 必填');
      const r = service.search(query);
      return toolOk({
        matches: r.matches,
        scannedFiles: r.scannedFiles,
        truncated: r.truncated,
        note: r.matches.length === 0 ? '无匹配记忆' : undefined,
      });
    },
  };

  return [list, read, write, search];
}

/** 注入 agent 系统提示的记忆使用指引（D18：何时读/写/更新） */
export const MEMORY_GUIDE = `## Long-term memory
You have file-based long-term memory tools (memory_list / memory_read / memory_write / memory_search).
- At the start of a task, run 1-2 memory_search queries with keywords about the user, the project, or the task type — apply what you find.
- When you learn a durable fact (user preference, correction, project convention, useful lesson), record it with memory_write. Read the existing topic file first and merge into it instead of creating near-duplicates.
- Never memorize volatile task details or one-off data. When in doubt, skip writing.`;
