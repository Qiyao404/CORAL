import { describe, it, expect } from 'vitest';
import { resolveToolName } from '../alias.js';
import type { Tool } from '../types.js';

const mk = (name: string): Tool => ({
  name,
  description: '',
  inputSchema: { type: 'object' },
  source: 'builtin',
  permission: 'auto',
  invoke: async () => ({ ok: true }),
});

const TOOLS = ['http_fetch', 'fs_list', 'fs_read', 'fs_write', 'fs_edit', 'fs_search', 'docx_read', 'docx_write', 'todo_write', 'agent_spawn', 'memory_list', 'memory_search'].map(mk);

describe('resolveToolName — 工具名自动纠正（M1 打磨）', () => {
  it('精确名直接命中（无纠正）', () => {
    const r = resolveToolName('http_fetch', TOOLS)!;
    expect(r.tool.name).toBe('http_fetch');
    expect(r.correctedFrom).toBeUndefined();
  });

  it('用户实测幻觉名：web_fetch / fetch_url / browse → http_fetch', () => {
    for (const alias of ['web_fetch', 'fetch_url', 'browse', 'open_url']) {
      const r = resolveToolName(alias, TOOLS)!;
      expect(r.tool.name, alias).toBe('http_fetch');
      expect(r.correctedFrom, alias).toBe(alias);
    }
  });

  it('常见读写/清单别名', () => {
    expect(resolveToolName('read_file', TOOLS)!.tool.name).toBe('fs_read');
    expect(resolveToolName('list_files', TOOLS)!.tool.name).toBe('fs_list');
    expect(resolveToolName('grep', TOOLS)!.tool.name).toBe('fs_search');
    expect(resolveToolName('read_docx', TOOLS)!.tool.name).toBe('docx_read');
    expect(resolveToolName('spawn_agent', TOOLS)!.tool.name).toBe('agent_spawn');
  });

  it('拼写错误（编辑距离 ≤2）模糊命中：http_fecth → http_fetch', () => {
    expect(resolveToolName('http_fecth', TOOLS)!.tool.name).toBe('http_fetch');
    expect(resolveToolName('fs_readx', TOOLS)!.tool.name).toBe('fs_read');
  });

  it('无法纠正 → null（走 TOOL_NOT_FOUND 自纠列表）', () => {
    expect(resolveToolName('nuclear_launch', TOOLS)).toBeNull();
    expect(resolveToolName('tool_search', TOOLS)).toBeNull(); // 距离过远且不在别名表
  });

  it('大小写不敏感', () => {
    expect(resolveToolName('Web_Fetch', TOOLS)!.tool.name).toBe('http_fetch');
  });
});
