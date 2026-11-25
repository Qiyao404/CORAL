import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ChatProvider, ChatRequest, ChatResponse } from '../../providers/types.js';
import type { LoopEvent } from '../agent-loop.js';
import type { Tool } from '../../tools/types.js';

/**
 * 思考过程直播（2026-11-24 性能体检落地）：
 * 推理模型先思考几十秒才吐第一个字（实测首字中位 14.8 秒、p90 49 秒），期间界面只有一个转圈。
 * 把推理增量从接口层一路传到前端：provider → loop（loop.reasoning 事件）→ SSE。
 * 这条流只直播不落库：一次长思考可能上万 token，落库只会把事件表撑大，断线重连后也不需要回放。
 */

const POLICY = { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 } as const;

describe('接口层 · 推理增量转发给 onReasoning，不计入 content', () => {
  it('兼容端点：delta.reasoning_content / delta.reasoning 都转发；content 照常', async () => {
    const { OpenAICompatProvider } = await import('../../providers/openai-compat.js');
    async function* gen() {
      yield { choices: [{ delta: { reasoning_content: '先想一下' } }] };
      yield { choices: [{ delta: { reasoning: '…再想一下' } }] };
      yield { choices: [{ delta: { content: '回答' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 5 } };
    }
    const p = new OpenAICompatProvider(
      { provider: 'openai-compat', baseUrl: '', apiKey: 'x', model: 'm', clientOverride: { chat: { completions: { create: async () => gen() } } } },
      POLICY
    );
    const reasoning: string[] = [];
    const text: string[] = [];
    const r = await p.stream({ messages: [{ role: 'user', content: 'hi' }] }, d => text.push(d), d => reasoning.push(d));
    expect(reasoning).toEqual(['先想一下', '…再想一下']);
    expect(text).toEqual(['回答']);
    expect(r.content).toBe('回答');
  });

  it('兼容端点：不传 onReasoning 时照常工作（老调用方不受影响）；消费者抛错不打断流', async () => {
    const { OpenAICompatProvider } = await import('../../providers/openai-compat.js');
    async function* gen() {
      yield { choices: [{ delta: { reasoning_content: '思考' } }] };
      yield { choices: [{ delta: { content: '答' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: {} };
    }
    const make = () => new OpenAICompatProvider(
      { provider: 'openai-compat', baseUrl: '', apiKey: 'x', model: 'm', clientOverride: { chat: { completions: { create: async () => gen() } } } },
      POLICY
    );
    const text: string[] = [];
    expect((await make().stream({ messages: [{ role: 'user', content: 'hi' }] }, d => text.push(d))).content).toBe('答');
    const boom = () => { throw new Error('消费者炸了'); };
    expect((await make().stream({ messages: [{ role: 'user', content: 'hi' }] }, () => {}, boom)).content).toBe('答');
  });

  it('另一类端点：thinking_delta 转发；text_delta 照常', async () => {
    const { AnthropicProvider } = await import('../../providers/anthropic.js');
    async function* gen() {
      yield { type: 'message_start', message: { usage: { input_tokens: 4 } } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '嗯' } };
      yield { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '好' } };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } };
    }
    const p = new AnthropicProvider(
      { provider: 'anthropic', baseUrl: '', apiKey: 'x', model: 'm', clientOverride: { messages: { create: async () => gen() } } },
      POLICY
    );
    const reasoning: string[] = [];
    const r: ChatResponse = await p.stream({ messages: [{ role: 'user', content: 'hi' }] }, () => {}, d => reasoning.push(d));
    expect(reasoning).toEqual(['嗯']);
    expect(r.content).toBe('好');
  });
});

// ─── 循环与运行引擎 ───────────────────────────────────────────────────────

process.env.DATABASE_PATH = join(tmpdir(), `coral-reasoning-${process.pid}.db`);
process.env.SKILLS_DIR = join(tmpdir(), `coral-reasoning-skills-${process.pid}`);
mkdirSync(process.env.SKILLS_DIR!, { recursive: true });

const { AgentLoop } = await import('../agent-loop.js');
const { RunEngine } = await import('../run-engine.js');
const { RunStore } = await import('../../store/run-store.js');
const { RunEventStore } = await import('../../store/run-event-store.js');
const { CheckpointStore } = await import('../../store/checkpoint-store.js');
const { FilesystemSkillRegistry } = await import('../../skill-runtime/filesystem-registry.js');
const { SkillExecutor } = await import('../../skill-runtime/skill-executor.js');
const { eventBus } = await import('../../event/event-bus.js');
const { closeDb } = await import('../../store/index.js');

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

describe('循环层 · loop.reasoning 事件（只直播不落库的标记）', () => {
  it('流式接口的推理增量聚合成 loop.reasoning，带 __transient；正文增量照常是 loop.delta', async () => {
    const events: LoopEvent[] = [];
    const llm = {
      async chat(): Promise<ChatResponse> { return { content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end' }; },
      async chatStream(_req: ChatRequest, onDelta: (d: string) => void, onReasoning?: (d: string) => void): Promise<ChatResponse> {
        onReasoning?.('先想');
        onReasoning?.('一想');
        onDelta('回');
        onDelta('答');
        return { content: '回答', toolCalls: [], usage: { inputTokens: 3, outputTokens: 4 }, stopReason: 'end' };
      },
    };
    const loop = new AgentLoop(llm as any, {
      runId: 'run-rs', agentId: 'main', goal: '任务', tools: [] as Tool[],
      budget: { maxSteps: 5, maxTokens: 100_000 }, signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });
    const result = await loop.run();
    expect(result.finalContent).toBe('回答');
    const reasoning = events.filter(e => e.type === 'loop.reasoning');
    expect(reasoning.length).toBeGreaterThan(0);
    expect(reasoning.every(e => e.payload?.__transient === true && e.payload?.agentId === 'main')).toBe(true);
    expect(reasoning.map(e => e.payload?.delta).join('')).toBe('先想一想');
    // 正文增量不带 transient 标记（它们照常落库，供断线重连回放）
    const deltas = events.filter(e => e.type === 'loop.delta');
    expect(deltas.map(e => e.payload?.delta).join('')).toBe('回答');
    expect(deltas.every(e => e.payload?.__transient === undefined)).toBe(true);
  });
});

describe('运行引擎 · 推理事件只上 SSE、不进事件表', () => {
  it('跑一个带思考的任务：事件表里没有 loop.reasoning，总线订阅者能收到', async () => {
    const seen: any[] = [];
    const handler = (ev: any) => { if (ev.type === 'loop.reasoning') seen.push(ev); };
    eventBus.on('loop.reasoning', handler);
    const engine = new RunEngine({
      llm: {
        async chat(): Promise<ChatResponse> { return { content: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' }; },
        async chatStream(_req: ChatRequest, onDelta: (d: string) => void, onReasoning?: (d: string) => void): Promise<ChatResponse> {
          onReasoning?.('让我想想');
          onDelta('好了');
          return { content: '好了', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' };
        },
        async complete() { return { content: 'ok' }; },
        isDemoMode: () => false,
      } as any,
      skillRegistry, skillExecutor,
      runStore: new RunStore(), eventStore: new RunEventStore(), checkpointStore: new CheckpointStore(),
    } as any);
    try {
      const { runId } = engine.startRun({ goal: '想一下再回答' });
      const until = Date.now() + 8000;
      while (Date.now() < until && engine.store.get(runId)!.status === 'running') await new Promise(r => setTimeout(r, 25));
      expect(engine.store.get(runId)!.status).toBe('completed');

      const types = engine.events.listByRun(runId, 0, 500).map(e => e.type);
      expect(types).not.toContain('loop.reasoning');
      expect(types).toContain('loop.delta');
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toMatchObject({ taskId: runId, payload: { runId, delta: '让我想想', __transient: true } });
    } finally {
      eventBus.off('loop.reasoning', handler);
    }
  });
});

describe('事件总线 · __transient 的事件只走订阅者', () => {
  it('不进 ring buffer、不上全局 WebSocket，但按类型的订阅者能收到', () => {
    const got: any[] = [];
    const ws: any[] = [];
    const handler = (ev: any) => got.push(ev);
    const sender = (ev: any) => ws.push(ev);
    eventBus.on('loop.reasoning', handler);
    eventBus.addWsClient(sender);
    try {
      eventBus.emit('loop.reasoning' as any, { taskId: 'r-t', __transient: true, delta: 'x' });
      eventBus.emit('loop.delta' as any, { taskId: 'r-t', delta: 'y' });
      expect(got.map(e => e.payload.delta)).toEqual(['x']);
      expect(ws.map(e => e.type)).toEqual(['loop.delta']);
      expect(eventBus.history({ taskId: 'r-t' }).map(e => e.type)).toEqual(['loop.delta']);
    } finally {
      eventBus.off('loop.reasoning', handler);
      eventBus.removeWsClient(sender);
    }
  });
});
