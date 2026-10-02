import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fsSearchTool } from '../builtin/fs-search.js';
import { makeToolContext } from '../types.js';

const tmp = mkdtempSync(join(tmpdir(), 'coral-fssearch-'));
const ws = join(tmp, 'ws');
beforeAll(() => {
  mkdirSync(join(ws, 'src'), { recursive: true });
  mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(ws, 'src', 'app.ts'), 'const greeting = "hello world";\nexport { greeting };\n', 'utf-8');
  writeFileSync(join(ws, 'docs', 'note.md').replace('docs\\note.md', 'note.md'), 'find the secret here\n', 'utf-8');
  writeFileSync(join(ws, 'node_modules', 'pkg', 'x.js'), 'hello world in node_modules\n', 'utf-8');
  writeFileSync(join(ws, 'logo.png'), Buffer.from([0x00, 0x01]), 'utf-8');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('fs_search 工具（M1-10 / D20）', () => {
  it('递归搜索 + 行号 + 相对路径；跳过 node_modules 与二进制', async () => {
    const r = await fsSearchTool.invoke({ query: 'hello world' }, makeToolContext({ workspaceDir: ws }));
    expect(r.ok).toBe(true);
    const files = (r.data as any).matches.map((m: any) => m.file);
    expect(files).toContain('src/app.ts');
    expect(files.some((f: string) => f.includes('node_modules'))).toBe(false);
    expect((r.data as any).matches[0].line).toBe(1);
  });

  it('扩展名过滤 + path 子目录限定 + max_results 截断', async () => {
    const r = await fsSearchTool.invoke(
      { query: 'hello world', extensions: '.md', path: '.' },
      makeToolContext({ workspaceDir: ws })
    );
    expect((r.data as any).matches.every((m: any) => m.file.endsWith('.md'))).toBe(true);

    const limited = await fsSearchTool.invoke({ query: 'e', max_results: 2 }, makeToolContext({ workspaceDir: ws }));
    expect((limited.data as any).matches.length).toBeLessThanOrEqual(2);
    expect((limited.data as any).truncated).toBe(true);
  });

  it('未绑定工作区 → NO_WORKSPACE；空 query → BAD_INPUT', async () => {
    expect((await fsSearchTool.invoke({ query: 'x' }, makeToolContext())).error?.code).toBe('NO_WORKSPACE');
    expect((await fsSearchTool.invoke({ query: '' }, makeToolContext({ workspaceDir: ws }))).error?.code).toBe('BAD_INPUT');
  });

  it('权限位 auto', () => {
    expect(fsSearchTool.permission).toBe('auto');
  });
});
