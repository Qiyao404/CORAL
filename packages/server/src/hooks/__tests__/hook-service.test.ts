import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { HookService } from '../hook-service.js';

/**
 * 外部命令守卫测试 — 跑真子进程（node 脚本文件，避开 shell 转义地狱）。
 * Windows 的 cmd 对嵌套引号极不友好，测试 hook 一律落为 .mjs 脚本文件再以
 * `node <file>` 调用（这也正是推荐用户书写 hooks 的方式）。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coral-hooks-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const nodeBin = process.execPath.replace(/\\/g, '/');

function writeHelper(name: string, code: string): string {
  const p = join(dir, name).replace(/\\/g, '/');
  writeFileSync(p, code, 'utf-8');
  return `${nodeBin} ${p}`;
}

function svcWith(hooks: Record<string, unknown[]>): HookService {
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks }), 'utf-8');
  return new HookService(dir);
}

describe('HookService — 命令守卫契约', () => {
  it('无配置/无命中 → 零开销放行', async () => {
    const svc = new HookService(dir); // 目录里没有 hooks.json
    const r = await svc.run('pre_tool_use', { tool: 'fs_write' });
    expect(r.decision).toBe('allow');
    expect(r.matched).toBe(0);
  });

  it('退出码 2 + stderr = 拒绝（原因回传）', async () => {
    const denyCmd = writeHelper('deny.mjs',
      `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d);` +
      `if(p.tool==='fs_write'&&String(p.toolInput.path).endsWith('.env')){process.stderr.write('禁止写 .env');process.exit(2);}` +
      `process.stdout.write(JSON.stringify({decision:'allow'}));});`
    );
    const svc = svcWith({ pre_tool_use: [{ matcher: 'fs_write', command: denyCmd, timeout: 20 }] });

    const denied = await svc.run('pre_tool_use', { tool: 'fs_write', toolInput: { path: 'config/.env' } });
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toContain('禁止写 .env');

    const allowed = await svc.run('pre_tool_use', { tool: 'fs_write', toolInput: { path: 'notes.md' } });
    expect(allowed.decision).toBe('allow');
  });

  it('stdout JSON：deny / ask / updatedInput / additionalContext 全语义', async () => {
    const jsonCmd = writeHelper('json.mjs',
      `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d);` +
      `if(p.toolInput&&p.toolInput.path==='rewrite.me'){process.stdout.write(JSON.stringify({decision:'allow',updatedInput:{content:'由守卫改写'}}));}` +
      `else if(p.goal==='需要补充'){process.stdout.write(JSON.stringify({decision:'allow',additionalContext:'背景补充：X=1'}));}` +
      `else{process.stdout.write(JSON.stringify({decision:'ask',reason:'这个我不确定'}));}});`
    );
    const svc = svcWith({
      pre_tool_use: [{ command: jsonCmd, timeout: 20 }],
      user_prompt_submit: [{ command: jsonCmd, timeout: 20 }],
    });

    const rewritten = await svc.run('pre_tool_use', { tool: 'fs_write', toolInput: { path: 'rewrite.me', content: '原始' } });
    expect(rewritten.decision).toBe('allow');
    expect(rewritten.updatedInput).toEqual({ content: '由守卫改写' });

    const ctx = await svc.run('user_prompt_submit', { goal: '需要补充' });
    expect(ctx.additionalContext).toContain('X=1');

    const ask = await svc.run('pre_tool_use', { tool: 'fs_write', toolInput: { path: 'other.md' } });
    expect(ask.decision).toBe('ask');
  });

  it('超时 → fail-closed 拒绝（pre_tool_use 语义）', async () => {
    const slowCmd = writeHelper('slow.mjs', `setTimeout(()=>{}, 8000);`);
    const svc = svcWith({ pre_tool_use: [{ command: slowCmd, timeout: 1 }] });
    const r = await svc.run('pre_tool_use', { tool: 'fs_write', toolInput: {} });
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('超时');
    expect(r.failed).toBe(1);
  }, 15_000);

  it('多条命中并行执行，deny 优先合并', async () => {
    const okCmd = writeHelper('ok.mjs', `process.stdout.write('{"decision":"allow"}');`);
    const denyCmd = writeHelper('deny2.mjs', `process.exit(2);`);
    const svc = svcWith({
      pre_tool_use: [
        { matcher: 'fs_.*', command: okCmd, timeout: 20 },
        { command: denyCmd, timeout: 20 },
      ],
    });
    const r = await svc.run('pre_tool_use', { tool: 'fs_write', toolInput: {} });
    expect(r.matched).toBe(2);
    expect(r.decision).toBe('deny');
  });

  it('matcher 不命中零开销；stop 事件的 deny 映射为 block', async () => {
    const denyCmd = writeHelper('deny3.mjs', `process.exit(2);`);
    const svc = svcWith({
      pre_tool_use: [{ matcher: '^docx_write$', command: denyCmd, timeout: 20 }],
      stop: [{ command: denyCmd, timeout: 20 }],
    });
    const miss = await svc.run('pre_tool_use', { tool: 'fs_write', toolInput: {} });
    expect(miss.matched).toBe(0);
    expect(miss.decision).toBe('allow');

    const stopped = await svc.run('stop', { finalContentPreview: 'x' });
    expect(stopped.decision).toBe('block');
  });

  it('配置损坏 → 按空配置处理（观察面不伤执行面）', async () => {
    writeFileSync(join(dir, 'hooks.json'), '{broken json!!', 'utf-8');
    const svc = new HookService(dir);
    const r = await svc.run('stop', {});
    expect(r.decision).toBe('allow');
    expect(r.matched).toBe(0);
  });
});
