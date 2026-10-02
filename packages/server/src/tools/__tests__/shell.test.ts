import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeShellTool } from '../builtin/shell.js';
import { makeToolContext } from '../types.js';

const tmp = mkdtempSync(join(tmpdir(), 'coral-shell-'));
const ws = join(tmp, 'ws');
beforeAll(() => mkdirSync(ws, { recursive: true }));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('shell_run 工具（M1-2 / D13）', () => {
  it('echo 命令 → 成功返回 stdout 与退出码（跨平台 sh/cmd 通吃）', async () => {
    const tool = makeShellTool();
    const r = await tool.invoke({ command: 'echo coral-shell-ok' }, makeToolContext({ workspaceDir: ws }));
    expect(r.ok).toBe(true);
    expect((r.data as any).exitCode).toBe(0);
    expect(((r.data as any).stdout as string).trim()).toBe('coral-shell-ok');
  }, 15000);

  it('超时 → 进程树强杀 + SHELL_TIMEOUT', async () => {
    const tool = makeShellTool();
    const r = await tool.invoke(
      { command: 'node -e "setTimeout(()=>{},30000)"', timeout_ms: 800 },
      makeToolContext({ workspaceDir: ws })
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SHELL_TIMEOUT');
  }, 15000);

  it('取消信号 → CANCELLED', async () => {
    const tool = makeShellTool();
    const c = new AbortController();
    setTimeout(() => c.abort(), 300);
    const r = await tool.invoke(
      { command: 'node -e "setTimeout(()=>{},30000)"', timeout_ms: 30000 },
      makeToolContext({ workspaceDir: ws, signal: c.signal })
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('CANCELLED');
  }, 15000);

  it('空命令 → BAD_INPUT；cwd 越界 → PATH_ESCAPE', async () => {
    const tool = makeShellTool();
    const empty = await tool.invoke({ command: '   ' }, makeToolContext({ workspaceDir: ws }));
    expect(empty.error?.code).toBe('BAD_INPUT');

    const escape = await tool.invoke({ command: 'echo x', cwd: '../..' }, makeToolContext({ workspaceDir: ws }));
    expect(escape.error?.code).toBe('PATH_ESCAPE');
  });

  it('权限位为 approval（每次执行需审批）', () => {
    expect(makeShellTool().permission).toBe('approval');
  });
});
