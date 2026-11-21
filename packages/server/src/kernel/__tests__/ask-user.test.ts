import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * 反问（ask_user，阶段2）：
 *  · 工具校验 + 评测隔离（不挂起，按假设继续）
 *  · 生命周期：ask → waiting_human + question.asked 事件 → 作答 → 恢复运行 → 工具结果携带答案
 *  · 选择题 / 自由补充 / 每 run 上限 3 问 / 取消作废
 *  · 模式 A 数据条件：问答作为工具结果进 checkpoint（fork 重答的基础）
 */

const tmp = mkdtempSync(join(tmpdir(), 'coral-askuser-'));
process.env.DATABASE_PATH = join(tmp, 'aq.db');
process.env.RUN_MAX_STEPS = '20';
process.env.RUN_MAX_TOKENS = '1000000';

const { RunEngine } = await import('../run-engine.js');
const { RunStore } = await import('../../store/run-store.js');
const { RunEventStore } = await import('../../store/run-event-store.js');
const { CheckpointStore } = await import('../../store/checkpoint-store.js');
const { FilesystemSkillRegistry } = await import('../../skill-runtime/filesystem-registry.js');
const { SkillExecutor } = await import('../../skill-runtime/skill-executor.js');
const { closeDb } = await import('../../store/index.js');
const { makeAskUserTool } = await import('../../tools/builtin/ask-user.js');
import type { ChatRequest, ChatResponse } from '../../providers/types.js';

let engine: RunEngine;
let runStore: RunStore;

beforeAll(async () => {
  const skillsDir = join(tmp, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const skillRegistry = new FilesystemSkillRegistry(skillsDir);
  await skillRegistry.reloadAll();
  const skillExecutor = new SkillExecutor(skillRegistry);
  runStore = new RunStore();
  engine = new RunEngine({
    llm: null as any,
    skillRegistry,
    skillExecutor,
    runStore,
    eventStore: new RunEventStore(),
    checkpointStore: new CheckpointStore(),
  });
});
afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function makeLLM(script: Array<(req: ChatRequest, n: number) => Partial<ChatResponse>>) {
  return {
    calls: [] as ChatRequest[],
    async chat(req: ChatRequest): Promise<ChatResponse> {
      this.calls.push(req);
      const r = script[Math.min(this.calls.length - 1, script.length - 1)](req, this.calls.length - 1);
      return {
        content: r.content ?? '', toolCalls: r.toolCalls ?? [],
        usage: r.usage ?? { inputTokens: 10, outputTokens: 5 },
        stopReason: r.stopReason ?? 'end',
      };
    },
    async complete(): Promise<{ content: string }> { return { content: 's' }; },
  };
}

const askCall = (id: string, question: string, options: any[]) => ({
  id, name: 'ask_user', input: { question, options },
});

async function waitFor(runId: string, status: string, maxMs = 20000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setTimeout(r, 100));
    if (runStore.get(runId)?.status === status) return true;
  }
  return false;
}

describe('makeAskUserTool — 校验与评测隔离', () => {
  it('缺 question / 少于 2 个选项 → BAD_INPUT；评测会话 → 不挂起直接返回 unavailable', async () => {
    const asked: any[] = [];
    const tool = makeAskUserTool({ ask: async p => { asked.push(p); return { source: 'choice', answer: 'x' }; }, automationSession: true });
    // 评测隔离：ask 不会被调用
    const r1 = await tool.invoke({ question: '格式?', options: [{ label: 'A' }, { label: 'B' }] }, undefined as any);
    expect(r1.ok).toBe(true);
    expect((r1.data as any).source).toBe('unavailable');
    expect((r1.data as any).note).toContain('自动化');
    expect(asked).toHaveLength(0);
    // 校验
    const r2 = await tool.invoke({ options: [{ label: 'A' }] }, undefined as any);
    expect(r2.ok).toBe(false);
    const r3 = await tool.invoke({ question: 'q', options: [{ label: 'only' }] }, undefined as any);
    expect(r3.ok).toBe(false);
  });
});

describe('RunEngine — 反问生命周期（真实 run）', () => {
  it('ask → waiting_human → 选择题作答 → 恢复 → 终答携带用户选择；问答进 checkpoint（模式A数据条件）', async () => {
    const llm = makeLLM([
      () => ({ stopReason: 'tool_use', toolCalls: [askCall('q1', '输出格式用哪种？', [
        { label: 'Word 文档', description: '正式交付' },
        { label: 'Markdown', recommended: true },
      ])] }),
      () => ({ stopReason: 'end', content: '好的，按 Markdown 输出。Final Answer: Markdown' }),
    ]);
    (engine as any).deps.llm = llm;
    const { runId } = engine.startRun({ goal: '生成报告' });

    expect(await waitFor(runId, 'waiting_human')).toBe(true);
    const qs = engine.listPendingQuestions(runId);
    expect(qs).toHaveLength(1);
    expect(qs[0].question).toContain('输出格式');
    expect(qs[0].options.some(o => o.recommended)).toBe(true);

    // 作答（选择题：选下标 1）
    const r = engine.answerQuestion(runId, qs[0].questionId, { choice: [1] });
    expect(r.ok).toBe(true);

    expect(await waitFor(runId, 'completed', 30000)).toBe(true);
    // 工具结果进入对话：第 2 轮请求含用户答案；事件留痕
    const evs = (engine as any).deps.eventStore.listByRun(runId, 0, 500);
    expect(evs.some(e => e.type === 'question.asked')).toBe(true);
    expect(evs.some(e => e.type === 'question.answered' && (e.payload as any).answer === 'Markdown')).toBe(true);
    const msgs = llm.calls[llm.calls.length - 1].messages;
    expect(JSON.stringify(msgs)).toContain('Markdown');
    // 模式 A 数据条件：问答作为工具结果落 checkpoint → fork 到提问前即可改答重跑
    const cps = engine.checkpoints.listByRun(runId);
    const lastCp = engine.checkpoints.get(runId, cps[cps.length - 1].seq);
    expect(JSON.stringify(lastCp?.messages)).toContain('ask_user');
  });

  it('自由补充作答（free 优先于 choice）', async () => {
    const llm = makeLLM([
      () => ({ stopReason: 'tool_use', toolCalls: [askCall('q2', '范围？', [{ label: 'A' }, { label: 'B' }])] }),
      () => ({ stopReason: 'end', content: 'done' }),
    ]);
    (engine as any).deps.llm = llm;
    const { runId } = engine.startRun({ goal: 'g2' });
    await waitFor(runId, 'waiting_human');
    const qs = engine.listPendingQuestions(runId);
    const r = engine.answerQuestion(runId, qs[0].questionId, { choice: [0], free: '都要，合并成一份' });
    expect(r.ok).toBe(true);
    await waitFor(runId, 'completed', 30000);
    const evs = (engine as any).deps.eventStore.listByRun(runId, 0, 500);
    expect(evs.some(e => e.type === 'question.answered' && (e.payload as any).answer === '都要，合并成一份')).toBe(true);
  });

  it('每 run 上限 3 问：第 4 问直接返回 cap 不挂起', async () => {
    let askedCount = 0;
    const llm = makeLLM([
      () => ({ stopReason: 'tool_use', toolCalls: [askCall('a', 'q1', [{ label: 'A' }, { label: 'B' }])] }),
      () => ({ stopReason: 'tool_use', toolCalls: [askCall('b', 'q2', [{ label: 'A' }, { label: 'B' }])] }),
      () => ({ stopReason: 'tool_use', toolCalls: [askCall('c', 'q3', [{ label: 'A' }, { label: 'B' }])] }),
      () => ({ stopReason: 'tool_use', toolCalls: [askCall('d', 'q4', [{ label: 'A' }, { label: 'B' }])] }),
      () => ({ stopReason: 'end', content: 'done' }),
    ]);
    (engine as any).deps.llm = llm;
    const { runId } = engine.startRun({ goal: 'g3' });
    // 依次作答前 3 问（多问共存：每轮一个 ask，串行等待）
    for (let i = 0; i < 3; i++) {
      expect(await waitFor(runId, 'waiting_human')).toBe(true);
      const qs = engine.listPendingQuestions(runId);
      engine.answerQuestion(runId, qs[0].questionId, { choice: [0] });
      await new Promise(r => setTimeout(r, 300));
    }
    await waitFor(runId, 'completed', 30000);
    // 第 4 问未挂起：全程 waiting_human 期间 pendingQuestions 最多 1（第4问直接 cap 返回）
    const evs = (engine as any).deps.eventStore.listByRun(runId, 0, 500);
    const askedEvents = evs.filter(e => e.type === 'question.asked');
    expect(askedEvents).toHaveLength(3); // 第 4 问没有 question.asked 事件（cap 短路）
  });

  it('取消 run：挂起的问题统一作废（question.answered source=cancelled）', async () => {
    const llm = makeLLM([
      () => ({ stopReason: 'tool_use', toolCalls: [askCall('x', '取消测试？', [{ label: 'A' }, { label: 'B' }])] }),
      () => ({ stopReason: 'end', content: 'never' }),
    ]);
    (engine as any).deps.llm = llm;
    const { runId } = engine.startRun({ goal: 'g4' });
    await waitFor(runId, 'waiting_human');
    engine.cancelRun(runId);
    await new Promise(r => setTimeout(r, 500));
    const evs = (engine as any).deps.eventStore.listByRun(runId, 0, 500);
    expect(evs.some(e => e.type === 'question.answered' && (e.payload as any).source === 'cancelled')).toBe(true);
    expect(engine.listPendingQuestions(runId)).toHaveLength(0);
  });
});
