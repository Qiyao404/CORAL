import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-skilltool-'));
process.env.DATABASE_PATH = join(tmp, 'tools.db');

const { ToolRegistry, createDefaultToolRegistry } = await import('../registry.js');
const { FilesystemSkillRegistry } = await import('../../skill-runtime/filesystem-registry.js');
const { SkillExecutor } = await import('../../skill-runtime/skill-executor.js');
const { closeDb } = await import('../../store/index.js');
import type { SkillExecutionResult } from '../../types/index.js';
import { makeToolContext } from '../types.js';

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/** 记录请求的假 SkillExecutor */
class RecordingExecutor {
  requests: any[] = [];
  behavior: (skillName: string) => SkillExecutionResult;
  constructor(behavior?: (skillName: string) => SkillExecutionResult) {
    this.behavior = behavior ?? (() => ({
      success: true,
      data: { done: true },
      meta: { durationMs: 1, skillVersion: '1', executionMode: 'llm_only', sandboxUsed: false },
    }));
  }
  async execute(request: any): Promise<SkillExecutionResult> {
    this.requests.push(request);
    return this.behavior(request.skillName);
  }
}

async function setupSkills() {
  const skillsDir = join(tmp, 'skills');
  const dir = join(skillsDir, 'demo-skill');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), [
    '---',
    'name: demo-skill',
    'version: "1.0.0"',
    'description: "演示技能：双倍数字"',
    'execution_mode: script',
    'script_entry: scripts/main.js',
    'script_runtime: node',
    'input_schema:',
    '  type: object',
    '  required: [n]',
    '  properties:',
    '    n: { type: integer }',
    '---',
    '',
    '# demo',
  ].join('\n'), 'utf-8');
  const registry = new FilesystemSkillRegistry(skillsDir);
  await registry.reloadAll();
  return registry;
}

describe('skill-tool 适配器（M1-2）', () => {
  it('manifest → Tool：命名空间前缀 / schema / 描述裁剪 / 权限位', async () => {
    const skillRegistry = await setupSkills();
    const executor = new RecordingExecutor();
    const registry = new ToolRegistry();
    const n = registry.syncSkillTools(skillRegistry, executor as any);
    expect(n).toBe(1);

    const tool = registry.get('skill_demo-skill')!;
    expect(tool).not.toBeNull();
    expect(tool.source).toBe('skill');
    expect(tool.permission).toBe('auto');
    expect(tool.description).toBe('演示技能：双倍数字');
    expect(tool.inputSchema.required).toEqual(['n']);
  });

  it('invoke：输入/上下文映射（runId→taskId、signal 贯穿）、成功与失败映射', async () => {
    const skillRegistry = await setupSkills();
    const executor = new RecordingExecutor((skillName) => ({
      success: false,
      error: { code: 'SCRIPT_EXIT_NONZERO', message: '退出码 1', retryable: true },
      meta: { durationMs: 2, skillVersion: '1', executionMode: 'script', sandboxUsed: true },
    }));
    const registry = new ToolRegistry();
    registry.syncSkillTools(skillRegistry, executor as any);

    const c = new AbortController();
    const ok = await registry.invoke('skill_demo-skill', { n: 5 }, makeToolContext({ runId: 'run-x', agentId: 'ag-x', signal: c.signal }));
    expect(ok.ok).toBe(false);
    expect(ok.error?.code).toBe('SCRIPT_EXIT_NONZERO');
    expect(ok.error?.retryable).toBe(false); // 工具层不重试

    // 上下文映射验证
    expect(executor.requests[0].skillName).toBe('demo-skill');
    expect(executor.requests[0].context.taskId).toBe('run-x');
    expect(executor.requests[0].context.agentId).toBe('ag-x');
    expect(executor.requests[0].context.abortSignal).toBe(c.signal);
  });

  it('技能下线后 sync 摘除对应工具（热重载语义）', async () => {
    const skillRegistry = await setupSkills();
    const registry = new ToolRegistry();
    registry.syncSkillTools(skillRegistry, new RecordingExecutor() as any);
    expect(registry.get('skill_demo-skill')).not.toBeNull();

    // 模拟 watcher 的下线路径：物理删除 + registry.removeSkill
    // （reloadAll 不清缓存是 v1 既有语义 — 删除由 watcher 负责通知）
    rmSync(join(skillRegistry.getSkillsDir(), 'demo-skill'), { recursive: true, force: true });
    skillRegistry.removeSkill('demo-skill');
    registry.syncSkillTools(skillRegistry, new RecordingExecutor() as any);
    expect(registry.get('skill_demo-skill')).toBeNull();
  });
});

describe('ToolRegistry + 默认工厂（M1-2）', () => {
  it('非法名 / 重名冲突抛错；未知工具 invoke → TOOL_NOT_FOUND', async () => {
    const registry = new ToolRegistry();
    expect(() => registry.register({ name: '非法名', description: '', inputSchema: {}, source: 'builtin', permission: 'auto', invoke: async () => ({ ok: true }) })).toThrow(/非法工具名/);
    const t = { name: 'dup_tool', description: '', inputSchema: {}, source: 'builtin' as const, permission: 'auto' as const, invoke: async () => ({ ok: true }) };
    registry.register(t);
    expect(() => registry.register(t)).toThrow(/冲突/);

    const r = await registry.invoke('ghost', {}, makeToolContext());
    expect(r.error?.code).toBe('TOOL_NOT_FOUND');
  });

  it('createDefaultToolRegistry：内置 + 技能 + shell 默认关闭', async () => {
    const skillRegistry = await setupSkills();
    const registry = createDefaultToolRegistry({
      skillRegistry,
      skillExecutor: new RecordingExecutor() as any,
    });
    const names = registry.list().map(t => t.name);
    expect(names).toContain('http_fetch');
    expect(names).toContain('fs_list');
    expect(names).toContain('fs_write');
    expect(names).toContain('skill_demo-skill');
    expect(names).not.toContain('shell_run'); // D13 默认关闭

    const withShell = createDefaultToolRegistry({
      skillRegistry,
      skillExecutor: new RecordingExecutor() as any,
      enableShell: true,
    });
    expect(withShell.list().map(t => t.name)).toContain('shell_run');

    // 权限位抽查：写类 approval，读类 auto
    expect(registry.get('fs_write')!.permission).toBe('approval');
    expect(registry.get('fs_read')!.permission).toBe('auto');
    expect(registry.get('http_fetch')!.permission).toBe('auto');
    expect(withShell.get('shell_run')!.permission).toBe('approval');

    // listDefinitions 形状（供 function calling）
    const defs = registry.listDefinitions();
    expect(defs.find(d => d.name === 'http_fetch')?.inputSchema.required).toEqual(['url']);
  });

  it('invoke 预检查取消信号：已中止直接抛 AbortError', async () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'noop_tool', description: '', inputSchema: {}, source: 'builtin', permission: 'auto', invoke: async () => ({ ok: true }) });
    const c = new AbortController();
    c.abort();
    await expect(
      registry.invoke('noop_tool', {}, makeToolContext({ signal: c.signal }))
    ).rejects.toThrow();
  });
});
