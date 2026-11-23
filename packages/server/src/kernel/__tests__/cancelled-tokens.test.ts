import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ChatRequest, ChatResponse } from '../../providers/types.js';
import type { Tool } from '../../tools/types.js';
import { toolOk } from '../../tools/types.js';

/**
 * REG-41：被取消的 run 在库里永远记 0 token。
 *
 * 主循环返回后先判"是否已取消"，是就直接返回 — 已经花掉的 token（可能是几百万）不写库。
 * 花掉的成本是真实发生的，取消只是"不再继续"，不是"没花过"。
 */

const tmp = mkdtempSync(join(tmpdir(), 'coral-cancel-tokens-'));
process.env.DATABASE_PATH = join(tmp, 'fix.db');
process.env.MEMORY_DIR = join(tmp, 'memory');
process.env.SKILLS_DIR = join(tmp, 'skills');
mkdirSync(process.env.MEMORY_DIR!, { recursive: true });
mkdirSync(process.env.SKILLS_DIR!, { recursive: true });

const { RunEngine } = await import('../run-engine.js');
const { RunStore } = await import('../../store/run-store.js');
const { RunEventStore } = await import('../../store/run-event-store.js');
const { CheckpointStore } = await import('../../store/checkpoint-store.js');
const { FilesystemSkillRegistry } = await import('../../skill-runtime/filesystem-registry.js');
const { SkillExecutor } = await import('../../skill-runtime/skill-executor.js');
const { closeDb } = await import('../../store/index.js');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** 等到 run 进入终态，再留一小段时间让收尾逻辑（记账等）跑完 */
async function waitTerminal(engine: InstanceType<typeof RunEngine>, runId: string, status: string, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await sleep(20);
    if (engine.store.get(runId)!.status === status) {
      await sleep(150);
      return;
    }
  }
  throw new Error(`run 未进入 ${status} 终态（当前 ${engine.store.get(runId)!.status}）`);
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
  rmSync(tmp, { recursive: true, force: true });
});

function makeEngine(route: (req: ChatRequest, n: number) => any, extraTools: Tool[]) {
  let n = 0;
  return new RunEngine({
    llm: {
      async chat(req: ChatRequest): Promise<ChatResponse> {
        const r = route(req, n++) ?? {};
        return {
          content: r.content ?? '',
          toolCalls: r.toolCalls ?? [],
          usage: r.usage ?? { inputTokens: 1000, outputTokens: 500 },
          stopReason: r.stopReason ?? (r.toolCalls?.length ? 'tool_use' : 'end'),
        } as ChatResponse;
      },
      async complete() { return { content: 'ok' }; },
      isDemoMode: () => false,
    } as any,
    skillRegistry, skillExecutor,
    runStore: new RunStore(), eventStore: new RunEventStore(), checkpointStore: new CheckpointStore(),
    mcpTools: () => extraTools,
  });
}

describe('REG-41 · 取消的 run 也要记下已经花掉的 token', () => {
  it('执行途中被取消：主循环、子代理已花掉的 token 都记入 run 总账', async () => {
    let engine!: InstanceType<typeof RunEngine>;
    let runId = '';
    let neverRan = false;
    const extraTools: Tool[] = [
      {
        name: 'cancel_now', description: '触发取消', inputSchema: { type: 'object' }, source: 'builtin', permission: 'auto',
        invoke: async () => { engine.cancelRun(runId); return toolOk({ cancelled: true }); },
      },
      {
        name: 'never_tool', description: '不应执行', inputSchema: { type: 'object' }, source: 'builtin', permission: 'auto',
        invoke: async () => { neverRan = true; return toolOk({}); },
      },
    ];
    // ① todo_write（主 1200/600）② 派一个子代理（主 800/400，子 300/200）③ [cancel_now, never_tool]（主 500/300）
    engine = makeEngine((req, n) => {
      if (String(req.system ?? '').includes('You are a SUB-AGENT')) return { content: '子任务完成', usage: { inputTokens: 300, outputTokens: 200 } };
      if (n === 0) return { toolCalls: [{ id: 'c1', name: 'todo_write', input: { todos: [] } }], usage: { inputTokens: 1200, outputTokens: 600 } };
      if (n === 1) return { toolCalls: [{ id: 'c2', name: 'agent_spawn', input: { goal: '子任务' } }], usage: { inputTokens: 800, outputTokens: 400 } };
      return { toolCalls: [{ id: 'c3', name: 'cancel_now', input: {} }, { id: 'c4', name: 'never_tool', input: {} }], usage: { inputTokens: 500, outputTokens: 300 } };
    }, extraTools);
    runId = engine.startRun({ goal: '会被取消的任务' }).runId;
    await waitTerminal(engine, runId, 'cancelled');

    expect(neverRan).toBe(false); // 取消后同批的后续工具不再执行（REG-24）
    const run = engine.store.get(runId) as any;
    expect(run.status).toBe('cancelled');
    // 修复前：tokens_in / tokens_out 都是 0
    expect(run.tokens_in).toBe(1200 + 800 + 300 + 500);
    expect(run.tokens_out).toBe(600 + 400 + 200 + 300);
  });

  it('正常完成的 run 记账不变（对照）', async () => {
    const engine = makeEngine((_req, n) => (n === 0
      ? { toolCalls: [{ id: 'c1', name: 'todo_write', input: { todos: [] } }], usage: { inputTokens: 100, outputTokens: 50 } }
      : { content: '完成', usage: { inputTokens: 70, outputTokens: 30 } }), []);
    const { runId } = engine.startRun({ goal: '正常任务' });
    await waitTerminal(engine, runId, 'completed');
    const run = engine.store.get(runId) as any;
    expect(run.tokens_in).toBe(170);
    expect(run.tokens_out).toBe(80);
  });
});
