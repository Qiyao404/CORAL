import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveWorkspacePath } from '../workspace-path.js';

const tmp = mkdtempSync(join(tmpdir(), 'coral-wspath-'));
const ws = join(tmp, 'ws');
const outside = join(tmp, 'outside');
beforeAll(() => {
  mkdirSync(join(ws, 'sub'), { recursive: true });
  writeFileSync(join(ws, 'a.txt'), 'x', 'utf-8');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 's', 'utf-8');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('resolveWorkspacePath — 三层守卫（M1-2）', () => {
  it('未绑定工作区 → NO_WORKSPACE', () => {
    const r = resolveWorkspacePath(undefined, 'a.txt');
    expect(r.ok).toBe(false);
    expect((r as any).code).toBe('NO_WORKSPACE');
  });

  it('正常相对路径与根本身 → 放行', () => {
    expect(resolveWorkspacePath(ws, 'a.txt').ok).toBe(true);
    expect(resolveWorkspacePath(ws, 'sub/../a.txt').ok).toBe(true);
    expect(resolveWorkspacePath(ws, '.').ok).toBe(true);
  });

  it('词法穿越 → PATH_ESCAPE（含同前缀兄弟目录）', () => {
    for (const evil of ['../outside/secret.txt', '..\\outside\\secret.txt', join(outside, 'secret.txt'), 'sub/../../outside/x']) {
      const r = resolveWorkspacePath(ws, evil);
      expect(r.ok, evil).toBe(false);
      expect((r as any).code, evil).toBe('PATH_ESCAPE');
    }
    // 兄弟目录前缀攻击：ws-outside 与 ws 同前缀
    mkdirSync(ws + '-sibling', { recursive: true });
    const r = resolveWorkspacePath(ws, join(ws + '-sibling', 'x.txt'));
    expect(r.ok).toBe(false);
  });

  it('符号链接逃逸 → SYMLINK_ESCAPE（目录 junction 指向工作区外）', () => {
    const link = join(ws, 'escape-link');
    let linkCreated = false;
    try {
      // Windows 无需管理员权限的目录连接（junction）；POSIX 为普通符号链接
      symlinkSync(outside, link, 'junction');
      linkCreated = true;
    } catch {
      linkCreated = false; // 环境不支持则跳过该用例主体
    }
    if (!linkCreated) return;

    const r = resolveWorkspacePath(ws, 'escape-link/secret.txt');
    expect(r.ok).toBe(false);
    expect((r as any).code).toBe('SYMLINK_ESCAPE');
  });

  it('写入不存在文件：经已存在祖先目录做软链检查', () => {
    // sub 存在且真实 → sub/new.txt 通过
    const ok = resolveWorkspacePath(ws, 'sub/brand-new.txt');
    expect(ok.ok).toBe(true);
  });
});
