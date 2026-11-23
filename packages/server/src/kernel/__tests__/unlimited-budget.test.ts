import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ChatRequest, ChatResponse } from '../../providers/types.js';

/**
 * REG-34：平台预算设为 0（语义 = 无上限）时，派生预算与团队看门狗失效。
 *
 * 主循环把 0 翻译成 Infinity；但团队 token 看门狗拿原始的 0 比较（0 < 0 为假 → 永远拒绝开队友），
 * 子代理预算按"平台预算 ÷ 3 / ÷ 2"派生（0 一除 → 上限只剩 5 步 / 1 万 token，推理模型一两步就用完）。
 */

process.env.DATABASE_PATH = join(tmpdir(), `coral-unlimited-${process.pid}.db`);
process.env.SKILLS_DIR = join(tmpdir(), `coral-unlimited-skills-${process.pid}`);
process.env.RUN_MAX_STEPS = '0';
process.env.RUN_MAX_TOKENS = '0';
mkdirSync(process.env.SKILLS_DIR!, { recursive: true });

const { RunEngine } = await import('../run-engine.js');
const { TeamService } = await import('../team-service.js');
const { RunStore } = await import('../../store/run-store.js');
const { RunEventStore } = await import('../../store/run-event-store.js');
const { CheckpointStore } = await import('../../store/checkpoint-store.js');
const { FilesystemSkillRegistry } = await import('../../skill-runtime/filesystem-registry.js');
const { SkillExecutor } = await import('../../skill-runtime/skill-executor.js');
const { platformConfig } = await import('../../services/config.js');
const { closeDb } = await import('../../store/index.js');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error('waitUntil 超时');
}

function makeLLM(route: (req: ChatRequest) => any) {
  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const r = route(req) ?? {};
      return {
        content: r.content ?? '', toolCalls: r.toolCalls ?? [],
        usage: r.usage ?? { inputTokens: 10, outputTokens: 5 },
        stopReason: r.stopReason ?? (r.toolCalls?.length ? 'tool_use' : 'end'),
      } as ChatResponse;
    },
    async complete() { return { content: 'ok' }; },
    isDemoMode: () => false,
  };
}

let skillRegistry: InstanceType<typeof FilesystemSkillRegistry>;
let skillExecutor: InstanceType<typeof SkillExecutor>;
beforeAll(async () => {
  skillRegistry = new FilesystemSkillRegistry(process.env.SKILLS_DIR!);
  await skillRegistry.reloadAll();
  skillExecutor = new SkillExecutor(skillRegistry);
});
afterAll(() => {
  closeDb();
  rmSync(process.env.SKILLS_DIR!, { recursive: true, force: true });
});

describe('REG-34 · 预算 0（无上限）下的团队与子代理预算', () => {
  it('前提：本测试环境确实是"无上限"配置', () => {
    expect(platformConfig.runMaxSteps).toBe(0);
    expect(platformConfig.runMaxTokens).toBe(0);
  });

  it('团队 token 看门狗：无上限配置下可以开队友（此前 0 / 0 直接判"预算已耗尽"）', () => {
    const team = new TeamService('r-team', () => {}, platformConfig.runMaxTokens);
    expect(team.checkSpawnTokens().ok).toBe(true);
    expect(team.teamUsage().budgetTokens).toBe(Infinity);
    // 非法值同样按"不限"处理，而不是变成一个 0 的硬上限
    expect(new TeamService('r-nan', () => {}, NaN).checkSpawnTokens().ok).toBe(true);
    // 正数上限的行为不变：耗尽即拒
    const capped = new TeamService('r-cap', () => {}, 1000);
    capped.registerTeammate('a', 'mate-a');
    expect(capped.checkSpawnTokens().ok).toBe(true);
    capped.settleTeammate('a', 'completed', { status: 'completed', finalContent: '', tokensIn: 900, tokensOut: 200 });
    expect(capped.checkSpawnTokens().ok).toBe(false);
  });

  it('子代理预算按"名义预算"派生，而不是把 0 除成一个没用的上限', async () => {
    let mainCalls = 0;
    const engine = new RunEngine({
      llm: makeLLM(req => {
        if (String(req.system ?? '').includes('You are a SUB-AGENT')) return { content: '子任务完成' };
        mainCalls++;
        return mainCalls === 1
          ? { toolCalls: [{ id: 'c1', name: 'agent_spawn', input: { goal: '算一下 1+1' } }] }
          : { content: '主任务完成' };
      }) as any,
      skillRegistry, skillExecutor,
      runStore: new RunStore(), eventStore: new RunEventStore(), checkpointStore: new CheckpointStore(),
    });
    const { tools } = (engine as any).buildTools('r-ub', null) as { tools: Array<any> };
    const spawn = tools.find(t => t.name === 'agent_spawn');
    const maxSteps = Number(/max (\d+)\)/.exec(spawn.inputSchema.properties.max_steps.description)?.[1]);
    const maxTokens = Number(/max (\d+)\)/.exec(spawn.inputSchema.properties.max_tokens.description)?.[1]);
    expect(maxSteps).toBeGreaterThanOrEqual(50); // 修复前：5
    expect(maxTokens).toBeGreaterThanOrEqual(1_000_000); // 修复前：10000

    // 真正派生一个子代理：它拿到的默认预算
    const { runId } = engine.startRun({ goal: '主任务' });
    await waitUntil(() => engine.store.get(runId)!.status === 'completed');
    const started = engine.events.listByRun(runId, 0, 500).find(e => e.type === 'subagent.started')!;
    expect(started, '应当派生了一个子代理').toBeTruthy();
    const budget = (started.payload as any).budget;
    expect(budget.maxSteps).toBeGreaterThanOrEqual(30); // 修复前：3
    expect(budget.maxTokens).toBeGreaterThanOrEqual(1_000_000); // 修复前：5000
  });
});
