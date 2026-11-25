import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify from 'fastify';

/**
 * 运行列表给每个运行带上"是否属于自动化会话"的标记（automation_session）。
 * 对话页据此决定打开时自动选中哪个会话：评测 / 基准共用一个会话，若被自动选中，
 * 用户接着输入的新任务会按"续接"发起——把最近一道评测题的完整过程带进新任务。
 * 规则只有服务端一个出处（与"评测会话不写记忆"同一条判定），前端不另写一份。
 */

const tmp = mkdtempSync(join(tmpdir(), 'coral-runs-list-'));
process.env.DATABASE_PATH = join(tmp, 'runs.db');
process.env.RUN_MAX_STEPS = '10';
process.env.RUN_MAX_TOKENS = '1000000';

const { RunEngine } = await import('../../kernel/run-engine.js');
const { RunStore } = await import('../../store/run-store.js');
const { RunEventStore } = await import('../../store/run-event-store.js');
const { CheckpointStore } = await import('../../store/checkpoint-store.js');
const { FilesystemSkillRegistry } = await import('../../skill-runtime/filesystem-registry.js');
const { SkillExecutor } = await import('../../skill-runtime/skill-executor.js');
const { closeDb } = await import('../../store/index.js');
const { registerRunRoutes } = await import('../run.routes.js');

const llm = {
  async chat() { return { content: '回答', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end' }; },
  async complete() { return { content: '（测试摘要器）无' }; },
};

const skillsDir = join(tmp, 'skills');
mkdirSync(skillsDir, { recursive: true });
const skillRegistry = new FilesystemSkillRegistry(skillsDir);
await skillRegistry.reloadAll();
const engine = new RunEngine({
  llm,
  skillRegistry,
  skillExecutor: new SkillExecutor(skillRegistry),
  runStore: new RunStore(),
  eventStore: new RunEventStore(),
  checkpointStore: new CheckpointStore(),
});
const app = Fastify();
registerRunRoutes(app, engine);
await app.ready();

// 三个自动化会话、一个普通会话、一个没有会话的运行
const started = [
  engine.startRun({ goal: '评测题', sessionId: 'gaia-eval-session' }),
  engine.startRun({ goal: '另一批评测', sessionId: 'eval-batch-2' }),
  engine.startRun({ goal: '基准题', sessionId: 'benchmark-run' }),
  engine.startRun({ goal: '用户自己的对话', sessionId: 'sess_normal' }),
  engine.startRun({ goal: '没有会话的运行' }),
];
const store = (engine as any).store;
for (const s of started) {
  for (let i = 0; i < 200 && !['completed', 'failed', 'cancelled'].includes(store.get(s.runId)?.status); i++) {
    await new Promise(r => setTimeout(r, 20));
  }
}

const collect = async (url: string) => {
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  return res.json().items as any[];
};

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('运行列表 · 自动化会话标记', () => {
  it('hasSession=true：评测 / 基准会话标 true，普通会话标 false，没有会话的运行不出现', async () => {
    const items = await collect('/api/runs?hasSession=true');
    const byGoal = new Map(items.map((x: any) => [x.goal, x]));
    expect([...byGoal.keys()].sort()).toEqual(['用户自己的对话', '另一批评测', '基准题', '评测题'].sort());
    expect(byGoal.get('评测题')?.automation_session).toBe(true);
    expect(byGoal.get('另一批评测')?.automation_session).toBe(true);
    expect(byGoal.get('基准题')?.automation_session).toBe(true);
    expect(byGoal.get('用户自己的对话')?.automation_session).toBe(false);
  });

  it('不带过滤时同样带标记（没有会话的运行不算自动化会话）', async () => {
    const items = await collect('/api/runs?limit=50');
    const byGoal = new Map(items.map((x: any) => [x.goal, x]));
    expect(byGoal.get('没有会话的运行')?.automation_session).toBe(false);
    expect(byGoal.get('用户自己的对话')?.automation_session).toBe(false);
    expect(byGoal.get('评测题')?.automation_session).toBe(true);
  });

  it('判定规则与"评测会话不写记忆"是同一条', () => {
    expect(engine.isAutomationSession('gaia-eval-session')).toBe(true);
    expect(engine.isAutomationSession('pawbench-abc')).toBe(true);
    expect(engine.isAutomationSession('sess_normal')).toBe(false);
    expect(engine.isAutomationSession(undefined)).toBe(false);
  });
});
