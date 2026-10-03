import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-runeng-'));
process.env.DATABASE_PATH = join(tmp, 'runs.db');
process.env.RUN_MAX_STEPS = '10';
process.env.RUN_MAX_TOKENS = '1000000';

const { RunEngine } = await import('../../kernel/run-engine.js');
const { RunStore, newRunId } = await import('../../store/run-store.js');
const { RunEventStore } = await import('../../store/run-event-store.js');
const { CheckpointStore } = await import('../../store/checkpoint-store.js');
const { FilesystemSkillRegistry } = await import('../../skill-runtime/filesystem-registry.js');
const { SkillExecutor } = await import('../../skill-runtime/skill-executor.js');
const { closeDb, taskStore } = await import('../../store/index.js');
const { getDb } = await import('../../store/db.js');
const { eventBus } = await import('../../event/event-bus.js');
import type { ChatRequest, ChatResponse } from '../../providers/types.js';

let engine: RunEngine;
let runStore: RunStore;
let eventStore: RunEventStore;
let checkpointStore: CheckpointStore;

beforeAll(async () => {
  // 空 skills 目录（技能工具为空集，聚焦 run 生命周期）
  const skillsDir = join(tmp, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const skillRegistry = new FilesystemSkillRegistry(skillsDir);
  await skillRegistry.reloadAll();
  const skillExecutor = new SkillExecutor(skillRegistry);

  runStore = new RunStore();
  eventStore = new RunEventStore();
  checkpointStore = new CheckpointStore();
});
afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/** 脚本化 LLM（与 agent-loop 测试同风格） */
function makeLLM(script: Array<Partial<ChatResponse> | Error | ((req: ChatRequest, callNo: number) => Partial<ChatResponse>)>) {
  return {
    calls: [] as ChatRequest[],
    async chat(req: ChatRequest): Promise<ChatResponse> {
      this.calls.push(req);
      const item = script[this.calls.length - 1] ?? { content: '默认回答', stopReason: 'end' };
      if (item instanceof Error) throw item;
      const r = typeof item === 'function' ? item(req, this.calls.length - 1) : item;
      return {
        content: r.content ?? '',
        toolCalls: r.toolCalls ?? [],
        usage: r.usage ?? { inputTokens: 10, outputTokens: 5 },
        stopReason: r.stopReason ?? 'end',
      };
    },
    async complete(messages: any[]): Promise<{ content: string }> {
      return { content: `（测试摘要器）收到 ${messages.length} 条消息` };
    },
  };
}

class HangingLLM {
  async chat(_req: any): Promise<any> {
    await new Promise((_, rej) => {
      const sig = _req.signal;
      const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); };
      if (sig?.aborted) onAbort(); else sig?.addEventListener('abort', onAbort, { once: true });
    });
    throw new Error('unreachable');
  }
  async complete(): Promise<{ content: string }> { return { content: 's' }; }
}

function newEngine(llm: any): RunEngine {
  const skillsDir = join(tmp, 'skills');
  const skillRegistry = new FilesystemSkillRegistry(skillsDir);
  const skillExecutor = new SkillExecutor(skillRegistry);
  return new RunEngine({
    llm,
    skillRegistry,
    skillExecutor,
    runStore,
    eventStore,
    checkpointStore,
  });
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitStatus(runId: string, status: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (runStore.get(runId)?.status === status) return;
    await wait(30);
  }
}
async function waitTerminal(runId: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const run = runStore.get(runId);
    // run 消失（已删除）同样视为收敛
    if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) return;
    await wait(30);
  }
}

describe('RunEngine — Free 模式全链路（M1-5）', () => {
  it('happy path：run 生命周期 + 三表持久化 + 事件总线桥接', async () => {
    const llm = makeLLM([
      { stopReason: 'tool_use', toolCalls: [{ id: 'c1', name: 'todo_write', input: { todos: [{ content: '第一步', status: 'in_progress' }] } }], content: '' },
      { stopReason: 'end', content: '最终回答：一切就绪' },
    ]);
    engine = newEngine(llm);
    const busEvents: any[] = [];
    eventBus.on('*', e => { if (e.taskId?.startsWith('r_')) busEvents.push(e); });

    const { runId } = engine.startRun({ goal: '做点事', sessionId: 'sess-1' });
    await waitTerminal(runId);

    const run = runStore.get(runId)!;
    expect(run.status).toBe('completed');
    expect(run.end_reason).toBe('final_answer');
    expect(run.final_content).toBe('最终回答：一切就绪');
    expect(run.session_id).toBe('sess-1');
    expect(run.tokens_in).toBe(20);
    expect(run.mode).toBe('free');
    expect(run.completed_at).toBeTruthy();

    // 事件表：run.created/started → loop.step_started → tool.call_* → todo.updated → run.completed，seq 单调
    const events = eventStore.listByRun(runId);
    const types = events.map(e => e.type);
    expect(types[0]).toBe('run.created');
    expect(types).toContain('run.started');
    expect(types).toContain('loop.step_started');
    expect(types).toContain('tool.call_completed');
    expect(types).toContain('todo.updated');
    expect(types.at(-1)).toBe('run.completed');
    const seqs = events.map(e => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    // 每步 checkpoint 落库（元数据 + state 可取回）
    const cps = checkpointStore.listByRun(runId);
    expect(cps.length).toBeGreaterThanOrEqual(2);
    expect(cps[0].kind).toBe('loop_step');
    const state = checkpointStore.get(runId, cps[0].seq)!;
    expect(state.messages?.length).toBeGreaterThan(0);

    // 事件总线收到桥接（taskId=runId 路由）
    expect(busEvents.some(e => e.type === 'run.completed' && e.taskId === runId)).toBe(true);

    // 预算默认来自配置（RUN_MAX_STEPS=10）
    expect(run.budget?.maxSteps).toBe(10);
  });

  it('预算耗尽：maxSteps=1 → completed + end_reason budget_exceeded + 事件', async () => {
    const toolRound = () => ({ stopReason: 'tool_use' as const, toolCalls: [{ id: 'c', name: 'todo_write', input: { todos: [{ content: 'x', status: 'pending' }] } }], content: '' });
    const llm = makeLLM([toolRound(), { stopReason: 'end', content: '预算总结' }]);
    engine = newEngine(llm);

    const { runId } = engine.startRun({ goal: 'g', budget: { maxSteps: 1 } });
    await waitTerminal(runId);

    const run = runStore.get(runId)!;
    expect(run.status).toBe('completed');
    expect(run.end_reason).toBe('budget_exceeded');
    expect(run.final_content).toBe('预算总结');
    expect(eventStore.listByRun(runId).map(e => e.type)).toContain('run.budget_exceeded');
  });

  it('取消：挂起中的 run 被 cancelRun 中止 → cancelled + run.cancelled 事件', async () => {
    const llm = makeLLM([
      new Promise(() => {}) as any, // 永不返回（挂起）— 不会被消费到
      { stopReason: 'end', content: 'x' },
    ]);
    // 用「等待取消信号」的实现替代
    llm.chat = async (req: any) => {
      await new Promise((_, rej) => {
        req.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          rej(e);
        });
      });
      throw new Error('unreachable');
    };
    engine = newEngine(llm);

    const { runId } = engine.startRun({ goal: '长任务' });
    await wait(100); // 等 running
    expect(runStore.get(runId)!.status).toBe('running');

    const r = engine.cancelRun(runId);
    expect(r.ok).toBe(true);
    await waitTerminal(runId);

    const run = runStore.get(runId)!;
    expect(run.status).toBe('cancelled');
    expect(run.end_reason).toBe('cancelled');
    const types = eventStore.listByRun(runId).map(e => e.type);
    expect(types).toContain('run.cancelled');
    expect(types).not.toContain('run.failed');

    // 幂等：再次取消返回终态提示
    expect(engine.cancelRun(runId).message).toContain('终态');
  });

  it('goal 校验与 session 过滤 / afterSeq 增量分页', async () => {
    engine = newEngine(makeLLM([{ stopReason: 'end', content: 'ok' }]));

    expect(() => engine.startRun({ goal: '' })).toThrow(/缺少 goal/);
    expect(() => engine.startRun({ goal: 'x'.repeat(10001) })).toThrow(/过长/);

    const { runId } = engine.startRun({ goal: 'sess 查询', sessionId: 'sess-A' });
    await waitTerminal(runId);
    const { runId: r2 } = engine.startRun({ goal: '另一个', sessionId: 'sess-B' });
    await waitTerminal(r2);

    const inA = runStore.list({ sessionId: 'sess-A' });
    expect(inA.total).toBe(1);
    expect(inA.items[0].id).toBe(runId);

    // afterSeq 游标：先拿全量，再从中间拉
    const all = eventStore.listByRun(runId);
    const half = Math.floor(all.length / 2);
    const after = eventStore.listByRun(runId, all[half].seq);
    expect(after[0].seq).toBe(all[half].seq + 1);
    expect(after.length).toBe(all.length - half - 1);
  });

  it('删除 run / 删除会话：事件与检查点级联清除（用户反馈 #1）', async () => {
    engine = newEngine(makeLLM([{ stopReason: 'end', content: 'ok' }]));
    const { runId } = engine.startRun({ goal: '待删除', sessionId: 'sess-del' });
    await waitTerminal(runId);
    expect(eventStore.countByRun(runId)).toBeGreaterThan(0);

    expect(engine.deleteRun(runId).ok).toBe(true);
    expect(runStore.get(runId)).toBeNull();
    expect(eventStore.countByRun(runId)).toBe(0);       // 级联清空
    expect(checkpointStore.listByRun(runId)).toHaveLength(0);

    // 会话级删除
    const a = engine.startRun({ goal: '会话任务1', sessionId: 'sess-del2' });
    const b = engine.startRun({ goal: '会话任务2', sessionId: 'sess-del2' });
    await waitTerminal(a.runId);
    await waitTerminal(b.runId);
    expect(engine.deleteSession('sess-del2')).toBe(2);
    expect(runStore.get(a.runId)).toBeNull();
    expect(runStore.get(b.runId)).toBeNull();

    // 运行中的 run 删除 → 先取消再删
    engine = newEngine(new HangingLLM());
    const { runId: hangId } = engine.startRun({ goal: '挂起' });
    await waitStatus(hangId, 'running');
    expect(engine.deleteRun(hangId).ok).toBe(true);
    await waitTerminal(hangId);
    expect(runStore.get(hangId)).toBeNull();
  });

  it('getRunDetail：run + events + checkpoints 组合', async () => {
    engine = newEngine(makeLLM([{ stopReason: 'end', content: 'detail' }]));
    const { runId } = engine.startRun({ goal: '详情' });
    await waitTerminal(runId);

    const detail = engine.getRunDetail(runId)!;
    expect(detail.run.id).toBe(runId);
    expect(detail.events.length).toBeGreaterThan(0);
    expect(detail.checkpoints.length).toBeGreaterThan(0);
    expect(engine.getRunDetail(newRunId())).toBeNull();
  });
});
