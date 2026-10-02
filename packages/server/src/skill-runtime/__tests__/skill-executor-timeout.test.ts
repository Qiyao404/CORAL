import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-exec-timeout-'));
// 必须在首次 import（→ event-bus → store → config）之前设置，隔离真实库
process.env.DATABASE_PATH = join(tmp, 'exec.db');

const { FilesystemSkillRegistry } = await import('../filesystem-registry.js');
const { SkillExecutor } = await import('../skill-executor.js');
const { closeDb } = await import('../../store/index.js');

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/** 在临时 skills 目录里造两个脚本技能：一个睡 30s（超时），一个立即返回（正常） */
async function setupRegistry() {
  const skillsDir = join(tmp, 'skills');

  const slowDir = join(skillsDir, 't-slow-skill');
  mkdirSync(join(slowDir, 'scripts'), { recursive: true });
  writeFileSync(join(slowDir, 'SKILL.md'), [
    '---',
    'name: t-slow-skill',
    'version: "1.0.0"',
    'description: "sleeps forever, used to test script timeout"',
    'execution_mode: script',
    'script_entry: scripts/main.js',
    'script_runtime: node',
    'script_timeout_ms: 600',
    '---',
    '',
    '# slow skill',
    '',
  ].join('\n'), 'utf-8');
  writeFileSync(join(slowDir, 'scripts', 'main.js'),
    'setTimeout(() => process.stdout.write(JSON.stringify({ ok: true })), 30000);', 'utf-8');

  const fastDir = join(skillsDir, 't-fast-skill');
  mkdirSync(join(fastDir, 'scripts'), { recursive: true });
  writeFileSync(join(fastDir, 'SKILL.md'), [
    '---',
    'name: t-fast-skill',
    'version: "1.0.0"',
    'description: "returns immediately"',
    'execution_mode: script',
    'script_entry: scripts/main.js',
    'script_runtime: node',
    'script_timeout_ms: 30000',
    '---',
    '',
    '# fast skill',
    '',
  ].join('\n'), 'utf-8');
  writeFileSync(join(fastDir, 'scripts', 'main.js'),
    'process.stdout.write(JSON.stringify({ ok: true }));', 'utf-8');

  // M0-6（A13）：真实子进程中验证环境变量白名单
  const envDir = join(skillsDir, 't-env-skill');
  mkdirSync(join(envDir, 'scripts'), { recursive: true });
  writeFileSync(join(envDir, 'SKILL.md'), [
    '---',
    'name: t-env-skill',
    'version: "1.0.0"',
    'description: "reports which env vars are visible"',
    'execution_mode: script',
    'script_entry: scripts/main.js',
    'script_runtime: node',
    'script_timeout_ms: 30000',
    '---',
    '',
    '# env skill',
    '',
  ].join('\n'), 'utf-8');
  writeFileSync(join(envDir, 'scripts', 'main.js'),
    'process.stdout.write(JSON.stringify({ hasLlmKey: !!process.env.LLM_API_KEY, hasPath: !!process.env.PATH, coralSkill: process.env.CORAL_SKILL_NAME }));', 'utf-8');

  const registry = new FilesystemSkillRegistry(skillsDir);
  await registry.reloadAll();
  return new SkillExecutor(registry);
}

describe('SkillExecutor 脚本级超时（M0-3 / A11 修复）', () => {
  it(
    '睡 30s 的脚本在 600ms 超时被进程树强杀 → SCRIPT_TIMEOUT',
    async () => {
      const executor = await setupRegistry();
      const t0 = Date.now();
      const result = await executor.execute({
        skillName: 't-slow-skill',
        input: {},
        context: { taskId: 't-exec-timeout', agentId: 'a1' },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SCRIPT_TIMEOUT');
      expect(result.error?.message).toContain('600');
      // 远小于脚本的 30s（强杀生效），留足 spawn 启动与 kill 的余量
      expect(Date.now() - t0).toBeLessThan(10000);
    },
    15000
  );

  it(
    '正常脚本不受影响：立即返回 success',
    async () => {
      const executor = await setupRegistry();
      const result = await executor.execute({
        skillName: 't-fast-skill',
        input: {},
        context: { taskId: 't-exec-timeout', agentId: 'a2' },
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ ok: true });
    },
    15000
  );

  it(
    'M0-6（A13）：子进程看不到宿主 LLM_API_KEY，能看到白名单 PATH 与 CORAL_* 注入',
    async () => {
      const executor = await setupRegistry();
      const result = await executor.execute({
        skillName: 't-env-skill',
        input: {},
        context: { taskId: 't-exec-timeout', agentId: 'a3' },
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        hasLlmKey: false,   // 机密不泄漏（测试进程经 dotenv 载入了 .env 的真实 key）
        hasPath: true,      // 运行时必需项保留
        coralSkill: 't-env-skill',
      });
    },
    15000
  );
});
