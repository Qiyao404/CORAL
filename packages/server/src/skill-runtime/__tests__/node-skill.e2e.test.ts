import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-nodeskill-'));
process.env.DATABASE_PATH = join(tmp, 'exec.db');

const { FilesystemSkillRegistry } = await import('../filesystem-registry.js');
const { SkillExecutor } = await import('../skill-executor.js');
const { closeDb } = await import('../../store/index.js');
const { eventBus } = await import('../../event/event-bus.js');

// 真实仓库的 _lib SDK 复制进临时 skills 目录（技能脚本按相对路径导入）
const REPO_LIB = resolve(process.cwd(), '..', '..', 'skills', '_lib', 'coral-progress.mjs');

beforeAll(() => {
  const skillsDir = join(tmp, 'skills');
  mkdirSync(join(skillsDir, '_lib'), { recursive: true });
  copyFileSync(REPO_LIB, join(skillsDir, '_lib', 'coral-progress.mjs'));

  const dir = join(skillsDir, 't-node-skill');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), [
    '---',
    'name: t-node-skill',
    'version: "1.0.0"',
    'description: "node skill using progress SDK"',
    'execution_mode: script',
    'script_entry: scripts/main.mjs',
    'script_runtime: node',
    'script_timeout_ms: 30000',
    '---',
    '',
    '# node skill',
  ].join('\n'), 'utf-8');

  // Node 技能约定 .mjs 入口（ESM 明确，不受外部 package.json 影响）
  writeFileSync(join(dir, 'scripts', 'main.mjs'), `
import { emitProgress, emitLog, emitArtifact } from '../../_lib/coral-progress.mjs';

const stdin = await new Promise(resolve => {
  let data = '';
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => resolve(data));
});
const { input } = JSON.parse(stdin || '{}');

emitProgress('init', '开始处理', { percent: 10, detail: { n: input.n } });
emitLog('一条普通日志');
emitProgress('work', '处理中', { step: 1, total: 2, percent: 60 });
emitArtifact('结果文件', 'output/result.md', 'markdown');
emitProgress('done', '完成', { percent: 100 });
process.stdout.write(JSON.stringify({ ok: true, doubled: input.n * 2 }));
`, 'utf-8');
});

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('Node 脚本技能端到端（M1-7：script_runtime: node + _lib SDK）', () => {
  it(
    '执行 + 进度协议 + 手动产物事件（detail._artifact → skill.artifact）',
    async () => {
      const registry = new FilesystemSkillRegistry(join(tmp, 'skills'));
      await registry.reloadAll();
      const executor = new SkillExecutor(registry);

      const result = await executor.execute({
        skillName: 't-node-skill',
        input: { n: 21 },
        context: { taskId: 't-node', agentId: 'a1' },
      });

      // 脚本成功 + stdin JSON 输入 + stdout JSON 结果
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ ok: true, doubled: 42 });

      // 进度事件（SDK → stderr 协议 → 解析器 → 事件流）
      const progress = eventBus
        .history({ taskId: 't-node' })
        .filter(e => e.type === 'skill.progress');
      const phases = progress.map(e => e.payload.phase);
      expect(phases).toEqual(['init', 'work', 'artifact', 'done']);
      expect(progress[0].payload.percent).toBe(10);
      expect(progress[0].payload.detail).toEqual({ n: 21 });
      expect(progress[1].payload.step).toBe(1);

      // 普通日志（emitLog 无前缀 → info 级 skill.log）
      const logs = eventBus.history({ taskId: 't-node' }).filter(e => e.type === 'skill.log');
      expect(logs.some(e => e.payload.message === '一条普通日志')).toBe(true);

      // M1-7 协议缝隙修复：手动声明的产物 → skill.artifact 事件
      const artifacts = eventBus.history({ taskId: 't-node' }).filter(e => e.type === 'skill.artifact');
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].payload.artifact).toMatchObject({
        name: '结果文件',
        path: 'output/result.md',
        type: 'markdown',
      });
    },
    20000
  );
});
