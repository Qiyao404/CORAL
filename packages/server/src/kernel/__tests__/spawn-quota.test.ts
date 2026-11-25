import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import type { ChatRequest, ChatResponse } from '../../providers/types.js';
import { makeToolContext } from '../../tools/types.js';

/**
 * 派生额度（2026-11-24 性能体检落地）：
 *  · agent_spawn 与 team_spawn 共用一个计数器。此前 run-engine 给两者各发了一个 { count: 0 }——
 *    报错信息写着"共用计数、上限 8"，实际各算各的（一个任务最多派生 16 个）
 *  · 额度可由用户在设置里调（默认 16 = 修复前实际可用的总量）；设为 0 时工具不提供给模型
 *  · 工具描述里写明额度与超限做法；被拒时说清楚"之后都会被拒、该怎么继续"
 *    （实测：有任务撞上限后被拒 27～30 次，每次白跑一步）
 */

process.env.DATABASE_PATH = join(tmpdir(), `coral-spawn-quota-${process.pid}.db`);
process.env.SKILLS_DIR = join(tmpdir(), `coral-spawn-quota-skills-${process.pid}`);
mkdirSync(process.env.SKILLS_DIR!, { recursive: true });

const { RunEngine } = await import('../run-engine.js');
const { RunStore } = await import('../../store/run-store.js');
const { RunEventStore } = await import('../../store/run-event-store.js');
const { CheckpointStore } = await import('../../store/checkpoint-store.js');
const { FilesystemSkillRegistry } = await import('../../skill-runtime/filesystem-registry.js');
const { SkillExecutor } = await import('../../skill-runtime/skill-executor.js');
const { RunBudgetSettingsService, DEFAULT_MAX_SPAWNS } = await import('../../services/run-budget-settings.js');
const { platformConfig } = await import('../../services/config.js');
const { closeDb } = await import('../../store/index.js');

const settings = new RunBudgetSettingsService(dirname(platformConfig.databasePath));

function makeLLM() {
  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const sub = String(req.system ?? '').includes('You are a SUB-AGENT');
      return {
        content: sub ? '子任务完成' : '主任务完成',
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'end',
      } as ChatResponse;
    },
    async complete() { return { content: 'ok' }; },
    isDemoMode: () => false,
  };
}

let skillRegistry: InstanceType<typeof FilesystemSkillRegistry>;
let skillExecutor: InstanceType<typeof SkillExecutor>;
let engine: InstanceType<typeof RunEngine>;

beforeAll(async () => {
  skillRegistry = new FilesystemSkillRegistry(process.env.SKILLS_DIR!);
  await skillRegistry.reloadAll();
  skillExecutor = new SkillExecutor(skillRegistry);
  engine = new RunEngine({
    llm: makeLLM() as any,
    skillRegistry, skillExecutor,
    runStore: new RunStore(), eventStore: new RunEventStore(), checkpointStore: new CheckpointStore(),
  } as any);
});
afterAll(() => {
  closeDb();
  rmSync(process.env.SKILLS_DIR!, { recursive: true, force: true });
});

const toolsFor = (runId: string) => ((engine as any).buildTools(runId, null) as { tools: Array<any> }).tools;
const ctx = () => makeToolContext({ runId: 'r-quota', emit: () => {} });

describe('派生额度 · 两个派生工具共用一个计数器', () => {
  it('默认额度 16；工具描述里写明额度与超限做法', () => {
    settings.set({ maxSpawns: null });
    const tools = toolsFor('r-desc');
    const spawn = tools.find(t => t.name === 'agent_spawn');
    const teamSpawn = tools.find(t => t.name === 'team_spawn');
    expect(spawn.description).toContain(`at most ${DEFAULT_MAX_SPAWNS} sub-agents/teammates in total`);
    expect(teamSpawn.description).toContain('agent_spawn and team_spawn share it');
    expect(spawn.description).toContain('group several items into one subtask');
  });

  it('agent_spawn 用完额度后，team_spawn 也被拒（修复前各算各的）', async () => {
    settings.set({ maxSpawns: 2 });
    try {
      const tools = toolsFor('r-shared');
      const spawn = tools.find(t => t.name === 'agent_spawn');
      const teamSpawn = tools.find(t => t.name === 'team_spawn');
      const first = await spawn.invoke({ goal: '子任务一' }, ctx());
      const second = await spawn.invoke({ goal: '子任务二' }, ctx());
      expect(first.ok, JSON.stringify(first.error)).toBe(true);
      expect(second.ok, JSON.stringify(second.error)).toBe(true);

      const third = await spawn.invoke({ goal: '子任务三' }, ctx());
      expect(third.ok).toBe(false);
      expect(third.error?.code).toBe('SPAWN_LIMIT');
      expect(third.error?.message).toContain('最多可派生 2 个');
      expect(third.error?.message).toContain('不要再尝试派生');

      const teammate = await teamSpawn.invoke({ name: 'worker', goal: '后台子任务' }, ctx());
      expect(teammate.ok).toBe(false);
      expect(teammate.error?.code).toBe('SPAWN_LIMIT');
      expect(teammate.error?.message).toContain('team_send');
    } finally {
      settings.set({ maxSpawns: null });
    }
  });

  it('额度设为 0：派生类工具不提供给模型（而不是给一个永远被拒的工具）', () => {
    settings.set({ maxSpawns: 0 });
    try {
      const names = toolsFor('r-zero').map(t => t.name);
      expect(names).not.toContain('agent_spawn');
      expect(names).not.toContain('team_spawn');
      expect(names).not.toContain('team_wait');
      // 与派生无关的工具照常
      expect(names).toContain('http_fetch');
      expect(names).toContain('evidence_read');
    } finally {
      settings.set({ maxSpawns: null });
    }
  });

  it('额度设大：比默认值更多的派生也能通过', async () => {
    settings.set({ maxSpawns: 3 });
    try {
      const tools = toolsFor('r-big');
      const spawn = tools.find(t => t.name === 'agent_spawn');
      const results = [];
      for (let i = 0; i < 3; i++) results.push(await spawn.invoke({ goal: `子任务 ${i}` }, ctx()));
      expect(results.every(r => r.ok)).toBe(true);
      expect((await spawn.invoke({ goal: '超额' }, ctx())).error?.code).toBe('SPAWN_LIMIT');
    } finally {
      settings.set({ maxSpawns: null });
    }
  });
});
