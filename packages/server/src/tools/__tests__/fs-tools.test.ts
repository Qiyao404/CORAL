import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fsListTool, fsReadTool, fsWriteTool, fsEditTool } from '../builtin/fs.js';
import { makeToolContext } from '../types.js';

const tmp = mkdtempSync(join(tmpdir(), 'coral-fstools-'));
const ws = join(tmp, 'ws');
beforeAll(() => {
  mkdirSync(join(ws, 'docs'), { recursive: true });
  writeFileSync(join(ws, 'readme.md'), '# Title\n\nhello world\n', 'utf-8');
  writeFileSync(join(ws, 'docs', 'a.txt'), 'alpha\nbeta\ngamma\n', 'utf-8');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ctx = () => makeToolContext({ workspaceDir: ws });

describe('fs_list / fs_read（auto 权限）', () => {
  it('fs_list 根目录与递归', async () => {
    const r = await fsListTool.invoke({}, ctx());
    expect(r.ok).toBe(true);
    const names = (r.data as any).entries.map((e: any) => e.path);
    expect(names).toContain('readme.md');
    expect(names).toContain('docs');

    const rec = await fsListTool.invoke({ recursive: true }, ctx());
    const recNames = (rec.data as any).entries.map((e: any) => e.path);
    expect(recNames).toContain('docs/a.txt');
  });

  it('fs_read 正常读取与截断标记', async () => {
    const r = await fsReadTool.invoke({ path: 'docs/a.txt' }, ctx());
    expect(r.ok).toBe(true);
    expect((r.data as any).content).toContain('alpha');

    const big = 'y'.repeat(300 * 1024);
    await fsWriteTool.invoke({ path: 'big.txt', content: big }, ctx());
    const trunc = await fsReadTool.invoke({ path: 'big.txt' }, ctx());
    expect((trunc.data as any).truncated).toBe(true);
  });

  it('fs_read 二进制 → binary 标记', async () => {
    writeFileSync(join(ws, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const r = await fsReadTool.invoke({ path: 'bin.dat' }, ctx());
    expect(r.ok).toBe(true);
    expect((r.data as any).binary).toBe(true);
  });

  it('未绑定工作区 → NO_WORKSPACE；越界 → PATH_ESCAPE', async () => {
    const noWs = await fsListTool.invoke({}, makeToolContext());
    expect(noWs.error?.code).toBe('NO_WORKSPACE');

    const escape = await fsReadTool.invoke({ path: '../../etc/passwd' }, ctx());
    expect(escape.error?.code).toBe('PATH_ESCAPE');
  });
});

describe('fs_write / fs_edit（approval 权限 + diff 产出）', () => {
  it('新建文件 → created:true 无 diff', async () => {
    const r = await fsWriteTool.invoke({ path: 'notes/new.md', content: 'first\n' }, ctx());
    expect(r.ok).toBe(true);
    expect((r.data as any).created).toBe(true);
    expect((r.data as any).diff).toBe('');
  });

  it('覆盖已有文件 → 产出 unified diff', async () => {
    const r = await fsWriteTool.invoke(
      { path: 'readme.md', content: '# Title\n\nhello CORAL\n' },
      ctx()
    );
    expect(r.ok).toBe(true);
    expect((r.data as any).created).toBe(false);
    const diff = (r.data as any).diff as string;
    expect(diff).toContain('-hello world');
    expect(diff).toContain('+hello CORAL');
  });

  it('fs_edit 唯一匹配替换 + diff；多处匹配需 replace_all', async () => {
    writeFileSync(join(ws, 'multi.txt'), 'x\nFOO\ny\nFOO\nz\n', 'utf-8');
    const amb = await fsEditTool.invoke({ path: 'multi.txt', old_text: 'FOO', new_text: 'BAR' }, ctx());
    expect(amb.error?.code).toBe('MATCH_AMBIGUOUS');

    const ok = await fsEditTool.invoke(
      { path: 'multi.txt', old_text: 'FOO', new_text: 'BAR', replace_all: true },
      ctx()
    );
    expect(ok.ok).toBe(true);
    expect((ok.data as any).replacements).toBe(2);
    expect((ok.data as any).diff).toContain('+BAR');

    const single = await fsEditTool.invoke(
      { path: 'docs/a.txt', old_text: 'beta', new_text: 'BETA' },
      ctx()
    );
    expect(single.ok).toBe(true);
    expect((single.data as any).replacements).toBe(1);
  });

  it('fs_edit 未命中 → MATCH_NOT_FOUND；空 old_text → BAD_INPUT', async () => {
    const miss = await fsEditTool.invoke({ path: 'readme.md', old_text: 'nope', new_text: 'x' }, ctx());
    expect(miss.error?.code).toBe('MATCH_NOT_FOUND');

    const empty = await fsEditTool.invoke({ path: 'readme.md', old_text: '', new_text: 'x' }, ctx());
    expect(empty.error?.code).toBe('BAD_INPUT');
  });

  it('写入路径越界被守卫拦截', async () => {
    const r = await fsWriteTool.invoke({ path: '../evil.txt', content: 'x' }, ctx());
    expect(r.error?.code).toBe('PATH_ESCAPE');
  });
});
