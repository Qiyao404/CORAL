import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { HookService } from '../hook-service.js';

/** 管理页能力：saveConfig 校验与落盘 / enabled 停用 / 命中环形缓冲 / test() 样例执行 */

let dir: string;
let allowCmd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coral-hooks-mgmt-'));
  const allowFile = join(dir, 'allow.mjs').replace(/\\/g, '/');
  writeFileSync(allowFile, `process.stdout.write(JSON.stringify({decision:'allow',reason:'ok'}));`, 'utf-8');
  allowCmd = `${process.execPath.replace(/\\/g, '/')} ${allowFile}`;
});

describe('HookService — 管理页能力', () => {
  it('saveConfig：合法配置原子落盘并立即生效', async () => {
    const svc = new HookService(dir);
    expect(existsSync(join(dir, 'hooks.json'))).toBe(false);

    const r = svc.saveConfig({ pre_tool_use: [{ matcher: '^fs_write$', command: `${allowCmd}`, timeout: 20 }] });
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, 'hooks.json'))).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf-8'));
    expect(onDisk.hooks.pre_tool_use[0].matcher).toBe('^fs_write$');

    // 保存后无需等 mtime 失效检查 — 立即可触发
    expect(svc.has('pre_tool_use')).toBe(true);
    const out = await svc.run('pre_tool_use', { tool: 'fs_write' });
    expect(out.decision).toBe('allow');
    expect(out.matched).toBe(1);
  });

  it('saveConfig 校验：未知事件 / 空 command / 坏正则 / 非数组 → 明确报错且不落盘', () => {
    const svc = new HookService(dir);
    expect(svc.saveConfig({ unknown_event: [{ command: 'x' }] }).ok).toBe(false);
    expect(svc.saveConfig({ pre_tool_use: [{ command: '  ' }] }).ok).toBe(false);
    expect(svc.saveConfig({ pre_tool_use: [{ command: 'x', matcher: '([bad' }] }).ok).toBe(false);
    expect(svc.saveConfig({ pre_tool_use: 'not-array' }).ok).toBe(false);
    expect(existsSync(join(dir, 'hooks.json'))).toBe(false); // 失败不产生脏文件
  });

  it('enabled=false：配置保留但不触发（管理页停用）', async () => {
    const svc = new HookService(dir);
    svc.saveConfig({ pre_tool_use: [{ command: `${allowCmd}`, enabled: false }] });
    expect(svc.listConfig().pre_tool_use[0].enabled).toBe(false);
    const out = await svc.run('pre_tool_use', { tool: 'fs_write' });
    expect(out.decision).toBe('allow');
    expect(out.matched).toBe(0); // 停用 = 未命中（零开销直通）
  });

  it('recentFirings：run() 命中后进入环形缓冲（含决策与耗时）', async () => {
    const svc = new HookService(dir);
    svc.saveConfig({ pre_tool_use: [{ command: `${allowCmd}`, timeout: 20 }] });
    await svc.run('pre_tool_use', { tool: 'fs_write' });
    const recent = svc.recentFirings();
    expect(recent.length).toBe(1);
    expect(recent[0].event).toBe('pre_tool_use');
    expect(recent[0].tool).toBe('fs_write');
    expect(recent[0].decision).toBe('allow');
    expect(recent[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('test()：样例载荷真实执行，返回决策解析与原始输出截尾', async () => {
    const svc = new HookService(dir);
    const result = await svc.test('pre_tool_use', `${allowCmd}`, 10, { toolInput: { path: 'a.md' } });
    expect(result.decision).toBe('allow');
    expect(result.exitCode).toBe(0);
    expect(result.stdoutTail).toContain('allow');
    expect(result.timedOut).toBe(false);
  });

  it('test()：exit 2 的命令 → decision=deny', async () => {
    const denyFile = join(dir, 'deny.mjs').replace(/\\/g, '/');
    writeFileSync(denyFile, `process.stderr.write('no .env');process.exit(2);`, 'utf-8');
    const svc = new HookService(dir);
    const result = await svc.test('pre_tool_use', `${process.execPath.replace(/\\/g, '/')} ${denyFile}`, 10);
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('no .env');
  });
});
