import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ChatRequest, ChatResponse } from '../../providers/types.js';
import type { LoopEvent } from '../agent-loop.js';
import type { Tool, ToolContext } from '../../tools/types.js';
import { toolOk, toolError } from '../../tools/types.js';
import { FetchHealth } from '../../tools/builtin/fetch-health.js';

/**
 * 循环纪律补遗（2026-11-24 性能体检落地）：
 *  · 思考溢出（stopReason=max_tokens 且正文为空）：重询"加码不减码"——照常带工具、放大输出额度、
 *    提示语只说继续；服务端不接受放大值时退回常态值
 *  · 网络不可用后的收尾节奏：提醒一步 → 仍抓取才收尾；探测成功自动复位
 *  · 工具侧部分存档（ctx.saveEvidence）与运行级草稿本（ctx.runState）的接线
 */

const { AgentLoop } = await import('../agent-loop.js');
const { EvidenceStore } = await import('../evidence.js');

type Step = Partial<ChatResponse> | ((n: number, req: ChatRequest) => Partial<ChatResponse> | Promise<Partial<ChatResponse>>);

function makeLLM(script: Step[]) {
  const calls: ChatRequest[] = [];
  let n = 0;
  const llm = {
    calls,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      // 快照：循环会继续往同一个 messages 数组里追加，事后断言必须看调用当时的样子
      calls.push({ ...req, messages: req.messages.map(m => ({ ...m })), tools: req.tools?.map(t => ({ ...t })) });
      const step = script[Math.min(n, script.length - 1)];
      const r = typeof step === 'function' ? await step(n, req) : step;
      n++;
      return {
        content: r.content ?? '',
        toolCalls: (r.toolCalls ?? []) as ChatResponse['toolCalls'],
        usage: r.usage ?? { inputTokens: 10, outputTokens: 5 },
        stopReason: r.stopReason ?? (r.toolCalls?.length ? 'tool_use' : 'end'),
      } as ChatResponse;
    },
    async complete() { return { content: 's' }; },
  };
  return llm;
}

function makeTool(name: string, invoke: Tool['invoke'], over: Partial<Tool> = {}): Tool {
  return { name, description: name, inputSchema: { type: 'object' }, source: 'builtin', permission: 'auto', effects: { idempotent: true }, invoke, ...over };
}
const call = (id: string, name: string, input: Record<string, any> = {}) => ({ id, name, input });

function runLoop(llm: any, tools: Tool[], over: Record<string, any> = {}) {
  const events: LoopEvent[] = [];
  const controller = new AbortController();
  const loop = new AgentLoop(llm as any, {
    runId: 'run-perf', agentId: 'main', goal: '任务', tools,
    budget: { maxSteps: 200, maxTokens: 100_000_000 },
    signal: controller.signal,
    onEvent: e => events.push(e),
    ...over,
  } as any);
  return { run: () => loop.run(), events, controller };
}

const fetchCalls = (n: number, count = 1) =>
  Array.from({ length: count }, (_, k) => call(`f${n}-${k}`, 'http_fetch', { url: `https://h${(n + k) % 3}.example.com/p${n}-${k}` }));

describe('思考溢出的空回答：重询加码不减码', () => {
  it('stopReason=max_tokens 且正文为空 → 重询照常带工具、输出额度放大、提示语只说"继续"', async () => {
    const llm = makeLLM([
      { content: '', stopReason: 'max_tokens', usage: { inputTokens: 20, outputTokens: 16384 } },
      { toolCalls: fetchCalls(1) },
      { content: '做完了' },
    ]);
    const seen: string[] = [];
    const { run, events } = runLoop(llm, [makeTool('http_fetch', async () => { seen.push('tool'); return toolOk({ ok: true }); })]);
    const result = await run();

    expect(result.status).toBe('completed');
    expect(result.finalContent).toBe('做完了');
    expect(seen).toEqual(['tool']); // 工具没被拿掉：第二步照常执行了工具调用
    // 首次调用用常态额度，重询那一次用放大额度，再下一次回到常态
    expect(llm.calls[0].maxTokens).toBe(16384);
    expect(llm.calls[1].maxTokens).toBe(32768);
    expect(llm.calls[2].maxTokens).toBe(16384);
    expect(llm.calls[1].tools?.length).toBe(1);
    const note = String(llm.calls[1].messages[llm.calls[1].messages.length - 1].content);
    expect(note).toContain('NOT a request to wrap up');
    expect(note).not.toContain('write the actual final answer');
    const rejected = events.find(e => e.type === 'loop.empty_answer_rejected');
    expect(rejected?.payload).toMatchObject({ overflow: true, continues: 1 });
  });

  it('其余空回答（非输出上限）：沿用"请写出最终回答"的重询，额度不变', async () => {
    const llm = makeLLM([
      { content: '', stopReason: 'end' },
      { content: '这是回答' },
    ]);
    const { run } = runLoop(llm, []);
    const result = await run();
    expect(result.finalContent).toBe('这是回答');
    expect(llm.calls[1].maxTokens).toBe(16384);
    const note = String(llm.calls[1].messages[llm.calls[1].messages.length - 1].content);
    expect(note).toContain('write the actual final answer');
  });

  it('被截断的工具调用 / 回答续写：下一轮同样用放大额度', async () => {
    const llm = makeLLM([
      { content: '', stopReason: 'max_tokens', toolCalls: [{ id: 'cut', name: 'http_fetch', input: { url: 'https://a.example.com/' } }] },
      { toolCalls: fetchCalls(1) },
      { content: '前半段', stopReason: 'max_tokens' },
      { content: '后半段' },
    ]);
    let executed = 0;
    const { run } = runLoop(llm, [makeTool('http_fetch', async () => { executed++; return toolOk({ ok: true }); })]);
    const result = await run();
    // 半截参数的那次没有执行（REG-30），只有重发的那次执行了
    expect(executed).toBe(1);
    expect(result.finalContent).toBe('前半段后半段');
    expect(llm.calls[1].maxTokens).toBe(32768);
    expect(llm.calls[3].maxTokens).toBe(32768);
  });

  it('服务端不接受放大额度 → 退回常态值重发，任务不受影响', async () => {
    const llm = makeLLM([
      { content: '', stopReason: 'max_tokens' },
      (n, req) => {
        if (req.maxTokens === 32768) throw Object.assign(new Error('invalid param: max_tokens must be <= 16384'), { status: 400 });
        return { content: '正常回答' };
      },
    ]);
    const { run, events } = runLoop(llm, []);
    const result = await run();
    expect(result.status).toBe('completed');
    expect(result.finalContent).toBe('正常回答');
    expect(events.some(e => e.type === 'loop.output_limit_clamped')).toBe(true);
  });

  it('放大额度被拒但原因是别的（与输出上限无关）→ 不吞错，任务如实失败', async () => {
    const llm = makeLLM([
      { content: '', stopReason: 'max_tokens' },
      () => { throw Object.assign(new Error('messages: role user must alternate'), { status: 400 }); },
    ]);
    const { run } = runLoop(llm, []);
    const result = await run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('alternate');
  });

  it('连续三次思考溢出 → 仍走原有的无工具兜底（不无限重询）', async () => {
    const llm = makeLLM([
      { content: '', stopReason: 'max_tokens' },
      { content: '', stopReason: 'max_tokens' },
      { content: '', stopReason: 'max_tokens' },
      { content: '兜底回答' },
    ]);
    const { run, events } = runLoop(llm, []);
    const result = await run();
    expect(result.status).toBe('completed');
    expect(result.finalContent).toBe('兜底回答');
    // 兜底调用不带工具
    expect(llm.calls[3].tools ?? []).toHaveLength(0);
    expect(events.filter(e => e.type === 'loop.empty_answer_rejected')).toHaveLength(2);
    expect(events.some(e => e.type === 'loop.empty_answer_fallback')).toBe(true);
  });
});

describe('网络不可用后的收尾节奏', () => {
  /** 与 http_fetch 同一套状态机的替身：不发网络请求，直接驱动运行级 FetchHealth（站点取自入参 URL） */
  function fetchStandIn(mode: { recoverAtStep?: number } = {}) {
    let n = 0;
    return makeTool('http_fetch', async (input, ctx) => {
      n++;
      const state = ctx.runState!;
      let h = state.get('fetchHealth') as FetchHealth | undefined;
      if (!(h instanceof FetchHealth)) { h = new FetchHealth(); state.set('fetchHealth', h); }
      const host = new URL(String((input as any)?.url ?? 'https://h0.example.com/')).hostname;
      if (mode.recoverAtStep !== undefined && n >= mode.recoverAtStep) {
        h.record({ host, ok: true, network: false });
        return toolOk({ ok: true });
      }
      if (h.dead) { h.markFastFail(); return toolError('NETWORK_DOWN', '网络不可用', false); }
      h.record({ host, ok: false, network: true });
      return toolError('HTTP_FAILED', '连接被中断（ECONNRESET）', true);
    });
  }

  it('网络挂了、模型仍在抓取：提醒一步 → 第二步仍抓取才强制收尾（可续跑）', async () => {
    const llm = makeLLM([
      ...Array.from({ length: 12 }, (_, n) => ({ toolCalls: fetchCalls(n) })),
      { content: '基于已核实内容的回答' },
    ]);
    const { run, events } = runLoop(llm, [fetchStandIn()]);
    const result = await run();

    expect(result.status).toBe('network_down');
    expect(result.finalContent).toBe('基于已核实内容的回答');
    // 收尾那次调用不带工具，提示语说明网络不可用并要求列出未核实项
    const wrap = llm.calls[llm.calls.length - 1];
    expect(wrap.tools ?? []).toHaveLength(0);
    expect(String(wrap.messages[wrap.messages.length - 1].content)).toContain('The network is unavailable');
    const ev = events.find(e => e.type === 'loop.network_down');
    expect(ev?.payload).toMatchObject({ dead: true, attempts: 2, streakAtDead: 10, hostsAtDead: 3 });
  });

  it('网络挂了、模型不再抓取 → 正常完成，不打扰', async () => {
    const llm = makeLLM([
      ...Array.from({ length: 10 }, (_, n) => ({ toolCalls: fetchCalls(n) })),
      { content: '用手头资料作答' },
    ]);
    const { run, events } = runLoop(llm, [fetchStandIn()]);
    const result = await run();
    expect(result.status).toBe('completed');
    expect(events.some(e => e.type === 'loop.network_down')).toBe(false);
  });

  it('判定不可用的那一步里还有排队的抓取：只算一次提醒，下一步仍给模型机会', async () => {
    // 第 10 步：模型一口气发了 4 个抓取 —— 第 1 个是第 10 次失败（触发判定），后 3 个直接快速失败
    const llm = makeLLM([
      ...Array.from({ length: 9 }, (_, n) => ({ toolCalls: fetchCalls(n) })),
      { toolCalls: fetchCalls(9, 4) },
      { content: '看到提示了，直接作答' },
    ]);
    const { run, events } = runLoop(llm, [fetchStandIn()]);
    const result = await run();
    expect(result.status).toBe('completed');
    expect(result.finalContent).toBe('看到提示了，直接作答');
    expect(events.some(e => e.type === 'loop.network_down')).toBe(false);
  });

  it('冷却期的探测成功 → 判定复位，任务继续，不收尾', async () => {
    // 前 11 次失败（第 11 次是判定后的快速失败 = 提醒），第 12 次是成功的探测
    const llm = makeLLM([
      ...Array.from({ length: 12 }, (_, n) => ({ toolCalls: fetchCalls(n) })),
      { content: '网络恢复了，完整回答' },
    ]);
    const { run, events } = runLoop(llm, [fetchStandIn({ recoverAtStep: 12 })]);
    const result = await run();
    expect(result.status).toBe('completed');
    expect(result.finalContent).toBe('网络恢复了，完整回答');
    expect(events.some(e => e.type === 'loop.network_down')).toBe(false);
  });

  it('原地打转熔断优先于网络收尾（同一步两者都触发时只走熔断）', async () => {
    // 同一个调用重复 15 次（同一 URL → 同一站点）：先触发打转熔断，而网络判定需要 ≥3 个站点
    const same = { toolCalls: [call('same', 'http_fetch', { url: 'https://one.example.com/same' })] };
    const llm = makeLLM([...Array.from({ length: 20 }, () => same), { content: 'x' }]);
    const { run } = runLoop(llm, [fetchStandIn()]);
    const result = await run();
    expect(result.status).toBe('stalled');
  });
});

describe('工具侧部分存档与运行级草稿本的接线', () => {
  it('ctx.saveEvidence 把完整内容存进证据层并返回 ID；内联结果很小、不会再被整体存档', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coral-save-evidence-'));
    try {
      const store = new EvidenceStore(dir);
      const ids: string[] = [];
      const tool = makeTool('big_page', async (_input, ctx) => {
        expect(ctx.runState).toBeInstanceOf(Map);
        const id = ctx.saveEvidence!(JSON.stringify({ text: 'x'.repeat(50_000) }));
        ids.push(id);
        return toolOk({ preview: 'x'.repeat(500), evidenceId: id });
      }, { maxResultSizeChars: 30_000 });
      const llm = makeLLM([{ toolCalls: [call('a', 'big_page', {})] }, { content: 'done' }]);
      const { run, events } = runLoop(llm, [tool], { evidenceStore: store });
      const result = await run();

      expect(result.status).toBe('completed');
      expect(ids).toHaveLength(1);
      const rec = store.read('run-perf', ids[0]);
      expect(rec?.record.chars).toBeGreaterThan(50_000);
      // 工具返回的内联结果没有超预算：主循环没有再存一份、也没有 evidence_saved 事件
      expect(JSON.stringify(result.messages.find(m => m.role === 'tool')?.content).length).toBeLessThan(2000);
      expect(events.some(e => e.type === 'tool.evidence_saved')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('没有证据层时 ctx.saveEvidence 为 undefined（工具自行截断）', async () => {
    let seen: ToolContext | undefined;
    const tool = makeTool('t', async (_input, ctx) => { seen = ctx; return toolOk({ ok: true }); });
    const llm = makeLLM([{ toolCalls: [call('a', 't', {})] }, { content: 'done' }]);
    const { run } = runLoop(llm, [tool]);
    await run();
    expect(seen?.saveEvidence).toBeUndefined();
    expect(seen?.runState).toBeInstanceOf(Map);
  });
});
