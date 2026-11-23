import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { makeToolContext } from '../types.js';

/**
 * REG-22（契约部分）：技能工具的效果声明。
 *
 * 审计发现：技能工具从不声明任何效果，于是"入参是数据"的脚本技能（web-search）与
 * "入参就是模型写的代码"的技能（code-exec）在系统眼里完全一样 — 效果契约对这一类工具形同虚设。
 *
 * 约定：
 *  · 脚本类技能执行的是技能包自带的固定程序，入参是数据 → 不构成 launchesProcess /
 *    executesForeignCode 意义上的"外部代码"（否则每次联网搜索都要人工审批）
 *  · 接收模型代码的技能必须在清单里声明 accepts_code: true + sandboxed: true；
 *    声明了接收代码却没有沙箱 → 工具层直接拒绝执行（fail-closed）并提升为审批
 *  · 有沙箱的代码技能在效果上标记 runsSandboxedCode（可审计，不触发审批）
 */

const tmp = mkdtempSync(join(tmpdir(), 'coral-skill-contract-'));
const { makeSkillTool } = await import('../skill-tool.js');
const { FilesystemSkillRegistry } = await import('../../skill-runtime/filesystem-registry.js');
const { SkillExecutor } = await import('../../skill-runtime/skill-executor.js');
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let executor: InstanceType<typeof SkillExecutor>;
beforeAll(async () => {
  executor = new SkillExecutor(new FilesystemSkillRegistry(tmp));
});

function manifest(over: Record<string, any> = {}): any {
  return {
    name: 'demo', version: '1.0.0', description: 'd', domain: 'tools', capabilities: [],
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    executionMode: 'script', scriptEntry: 'scripts/main.mjs', scriptRuntime: 'node',
    humanGate: false, estimatedDurationMs: 1000, costLevel: 'low', status: 'stable', tags: [],
    skillDirPath: tmp, promptContent: '', loadedAt: '', fileHash: '', source: 'builtin',
    ...over,
  };
}

describe('技能工具的效果契约', () => {
  it('普通脚本技能（入参是数据）：auto，不声明外部代码/进程效果', () => {
    const t = makeSkillTool(manifest(), executor as any);
    expect(t.permission).toBe('auto');
    expect(t.effects?.executesForeignCode).toBeUndefined();
    expect(t.effects?.launchesProcess).toBeUndefined();
    expect(t.effects?.runsSandboxedCode).toBeUndefined();
  });

  it('接收模型代码 + 声明了沙箱：auto，效果标记 runsSandboxedCode（可审计）', () => {
    const t = makeSkillTool(manifest({ acceptsCode: true, sandboxed: true }), executor as any);
    expect(t.permission).toBe('auto');
    expect(t.effects?.runsSandboxedCode).toBe(true);
    expect(t.effects?.executesForeignCode).toBeUndefined();
  });

  it('接收模型代码但没声明沙箱：拒绝执行（fail-closed）+ 提升为审批', async () => {
    const t = makeSkillTool(manifest({ name: 'evil-exec', acceptsCode: true }), executor as any);
    expect(t.permission).toBe('approval');
    const r = await t.invoke({ code: 'print(1)' }, makeToolContext());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SANDBOX_REQUIRED');
    expect(r.error?.message).toMatch(/沙箱/);
  });
});

describe('仓库技能清单扫描', () => {
  const skillsRoot = resolve(__dirname, '../../../../../skills');

  it('code-exec 声明了"接收代码 + 沙箱"', () => {
    const fm = readFileSync(join(skillsRoot, 'code-exec', 'SKILL.md'), 'utf-8');
    expect(/^accepts_code:\s*true\s*$/m.test(fm)).toBe(true);
    expect(/^sandboxed:\s*true\s*$/m.test(fm)).toBe(true);
  });

  it('任何声明接收代码的技能都必须同时声明沙箱（防新技能悄悄裸跑模型代码）', () => {
    const offenders: string[] = [];
    for (const dir of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const file = join(skillsRoot, dir.name, 'SKILL.md');
      if (!existsSync(file)) continue;
      const fm = readFileSync(file, 'utf-8');
      if (/^accepts_code:\s*true\s*$/m.test(fm) && !/^sandboxed:\s*true\s*$/m.test(fm)) {
        offenders.push(dir.name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
