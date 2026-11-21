import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * 运行中用户补充（阶段1）：
 *  · 发送 → 注入邮箱 → 下一**步边界**送达模型（与 teammate 消息同门，不打断当前步骤）
 *  · 注入自带"大改先重排 todo"引导；多条按序；终态 run 拒绝（前端走排队→续接）
 */

const tmp = mkdtempSync(join(tmpdir(), 'coral-userinput-'));
process.env.DATABASE_PATH = join(tmp, 'ui.db');
process.env.RUN_MAX_STEPS = '20';
process.env.RUN_MAX_TOKENS = '1000000';

const { AgentLoop } = await import('../agent-loop.js');
const { RunEngine } = await import('../run-engine.js');
const { RunStore } = await import('../../store/run-store.js');
const { RunEventStore } = await import('../../store/run-event-store.js');
const { CheckpointStore } = await import('../../store/checkpoint-store.js');
const { FilesystemSkillRegistry } = await import('../../skill-runtime/filesystem-registry.js');
const { SkillExecutor } = await import('../../skill-runtime/skill-executor.js');
const { closeDb } = await import('../../store/index.js');
import type { ChatRequest, ChatResponse } from '../../providers/types.js';
import type { LoopEvent } from '../agent-loop.js';

let engine: RunEngine;

beforeAll(async () => {
  const skillsDir = join(tmp, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const skillRegistry = new FilesystemSkillRegistry(skillsDir);
  await skillRegistry.reloadAll();
  const skillExecutor = new SkillExecutor(skillRegistry);
  engine = new RunEngine({
    llm: null as any,
    skillRegistry,
    skillExecutor,
    runStore: new RunStore(),
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
        content: r.content ?? '',
        toolCalls: r.toolCalls ?? [],
        usage: r.usage ?? { inputTokens: 10, outputTokens: 5 },
        stopReason: r.stopReason ?? 'end',
      };
    },
    async complete(): Promise<{ content: string }> { return { content: 'sum' }; },
  };
}

describe('AgentLoop — 用户补充注入（步边界）', () => {
  it('kind=user 的邮箱消息以 [user follow-up] 注入下一轮请求，事件留痕', async () => {
    const inbox: Array<{ from: string; content: string; kind?: 'user' }> = [];
    const llm = makeLLM([
      () => {
        // 第 1 轮返回的瞬间用户补充到达邮箱（工具执行期间 — 第 2 轮边界注入，确定顺序）
        inbox.push({ from: 'user', kind: 'user', content: '顺便也查一下 B' });
        return { stopReason: 'tool_use', toolCalls: [{ id: 'c1', name: 'todo_write', input: { todos: [] } }] };
      },
      () => ({ stopReason: 'end', content: '完成' }),
    ]);
    const events: LoopEvent[] = [];
    const loop = new AgentLoop(llm as any, {
      runId: 'r-ui', agentId: 'main', goal: '任务',
      tools: [{ name: 'todo_write', description: 't', inputSchema: { type: 'object' }, source: 'builtin', permission: 'auto', invoke: async () => ({ ok: true, data: {} }) }],
      budget: { maxSteps: 10, maxTokens: 1_000_000 },
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
      pollInbox: () => [...inbox.splice(0)], // 排空语义
    });
    const r = await loop.run();

    expect(r.status).toBe('completed');
    const msgs2 = llm.calls[1].messages;
    const injected = msgs2.find((m: any) => (m.content ?? '').includes('[user follow-up]'));
    expect(injected).toBeTruthy();
    expect(injected!.content).toContain('顺便也查一下 B');
    expect(events.some(e => e.type === 'run.user_input_injected')).toBe(true);
    // teammate 消息保持原格式（向后兼容）
    expect(msgs2.some((m: any) => (m.content ?? '').includes('[teammate message from'))).toBe(false);
  });
});

describe('RunEngine.injectUserInput — 校验与送达', () => {
  it('running run：接收 → 下一步边界进入模型请求（含重排引导）', async () => {
    const llm = makeLLM([
      () => ({ stopReason: 'tool_use', toolCalls: [{ id: 'c1', name: 'todo_write', input: { todos: [] } }] }),
      () => ({ stopReason: 'end', content: '收到补充，完成' }),
    ]);
    (engine as any).deps.llm = llm;
    const { runId } = engine.startRun({ goal: '做 A 调研' });
    // run 异步启动：立即补充（第 1 轮 LLM 进行中/工具执行中到达 — 第 2 轮边界注入）
    const inj = engine.injectUserInput(runId, '范围改为 B 方向');
    expect(inj.ok).toBe(true);
    expect(inj.queued).toBe(1);

    // 等终态
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 200));
      const st = (engine as any).deps.runStore.get(runId).status;
      if (['completed', 'failed'].includes(st)) break;
    }
    const status = (engine as any).deps.runStore.get(runId).status;
    expect(status).toBe('completed');
    // 第 2 轮请求包含注入（前缀 + 内容 + 重排引导）
    const msgs = llm.calls[llm.calls.length - 1].messages;
    const injected = msgs.find((m: any) => (m.content ?? '').includes('[user follow-up]'));
    expect(injected?.content).toContain('范围改为 B 方向');
    expect(injected?.content).toContain('rewrite your todo list FIRST');
    // 事件留痕：received + injected
    const evs = (engine as any).deps.eventStore.listByRun(runId, 0, 500);
    expect(evs.some(e => e.type === 'run.user_input_received')).toBe(true);
    expect(evs.some(e => e.type === 'run.user_input_injected')).toBe(true);
  });

  it('多条按序注入；空内容/超长拒绝', async () => {
    const llm = makeLLM([
      () => ({ stopReason: 'tool_use', toolCalls: [{ id: 'c1', name: 'todo_write', input: { todos: [] } }] }),
      () => ({ stopReason: 'end', content: 'done' }),
    ]);
    (engine as any).deps.llm = llm;
    const { runId } = engine.startRun({ goal: 'g' });
    expect(engine.injectUserInput(runId, '第一条').ok).toBe(true);
    expect(engine.injectUserInput(runId, '第二条').ok).toBe(true);
    expect(engine.injectUserInput(runId, '   ').ok).toBe(false); // 空
    expect(engine.injectUserInput(runId, 'x'.repeat(9000)).ok).toBe(false); // 超长

    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 200));
      const st = (engine as any).deps.runStore.get(runId).status;
      if (['completed', 'failed'].includes(st)) break;
    }
    const msgs = llm.calls[llm.calls.length - 1].messages;
    const idx1 = msgs.findIndex((m: any) => (m.content ?? '').includes('第一条'));
    const idx2 = msgs.findIndex((m: any) => (m.content ?? '').includes('第二条'));
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1); // 按序
  });

  it('终态 run：拒绝并引导走下一轮续接', async () => {
    const llm = makeLLM([() => ({ stopReason: 'end', content: 'ok' })]);
    (engine as any).deps.llm = llm;
    const { runId } = engine.startRun({ goal: 'quick' });
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 200));
      const st = (engine as any).deps.runStore.get(runId).status;
      if (['completed', 'failed'].includes(st)) break;
    }
    const r = engine.injectUserInput(runId, '补充');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('终态');
  });
});
