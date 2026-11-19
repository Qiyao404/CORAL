import { describe, it, expect } from 'vitest';
import { AgentLoop, budgetNudgeText, type LoopEvent } from '../agent-loop.js';
import type { ChatResponse } from '../../providers/types.js';
import type { Tool } from '../../tools/types.js';

/**
 * 渐进预算提醒（分档收敛引导）：
 *  · 有限预算：70% 档 consolidate / 85% 档 converge，各触发一次
 *  · 无上限预算（Infinity）：20/40 绝对步数档
 *  · 提醒文本追加在本步最后一条工具结果末尾（不改系统提示词前缀）
 *  · 事件留痕：loop.budget_nudge { tier, step, ... }
 */

/** 无限连发工具调用的脚本桩：到第 N 步给最终回答 */
class ToolLoopLLM {
  calls = 0;
  constructor(private finalAtStep: number) {}
  async chat(): Promise<ChatResponse> {
    this.calls++;
    if (this.calls >= this.finalAtStep) {
      return { content: 'done', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end' };
    }
    return {
      content: '', toolCalls: [{ id: `c${this.calls}`, name: 'echo', input: {} }],
      usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'tool_use',
    };
  }
}

const echo: Tool = {
  name: 'echo', description: 'echo', inputSchema: { type: 'object' },
  source: 'builtin', permission: 'auto',
  invoke: async () => ({ ok: true, data: { pong: true } }),
};

describe('budgetNudgeText — 阈值计算（单元）', () => {
  it('有限预算：70%/85% 相对阈值，高档优先，各只触发一次', () => {
    const fired = new Set<string>();
    // maxSteps=10 → consolidate@7, converge@8（floor）
    expect(budgetNudgeText(6, { maxSteps: 10, maxTokens: 0 }, fired)).toBeNull();
    const c = budgetNudgeText(7, { maxSteps: 10, maxTokens: 0 }, fired);
    expect(c?.tier).toBe('consolidate');
    expect(c?.detail?.usage).toBe('70%');
    // 同档不重复
    expect(budgetNudgeText(7, { maxSteps: 10, maxTokens: 0 }, fired)).toBeNull();
    const v = budgetNudgeText(8, { maxSteps: 10, maxTokens: 0 }, fired);
    expect(v?.tier).toBe('converge');
    expect(v?.detail?.usage).toBe('80%');
    // 全部触发后静默
    expect(budgetNudgeText(9, { maxSteps: 10, maxTokens: 0 }, fired)).toBeNull();
  });

  it('converge 在预算耗尽前的最后一步不再触发（step < maxSteps）', () => {
    const fired = new Set<string>();
    // maxSteps=4 → consolidate@2, converge@3；step=4 已到预算 → null
    expect(budgetNudgeText(4, { maxSteps: 4, maxTokens: 0 }, fired)).toBeNull();
    // converge@3 可以
    expect(budgetNudgeText(3, { maxSteps: 4, maxTokens: 0 }, fired)?.tier).toBe('converge');
  });

  it('无上限预算（Infinity）：20/40 绝对步数档', () => {
    const fired = new Set<string>();
    const inf = { maxSteps: Infinity, maxTokens: 0 };
    expect(budgetNudgeText(19, inf, fired)).toBeNull();
    expect(budgetNudgeText(20, inf, fired)?.tier).toBe('consolidate');
    expect(budgetNudgeText(40, inf, fired)?.tier).toBe('converge');
    expect(fired).toEqual(new Set(['consolidate', 'converge']));
  });

  it('maxSteps ≤ 0 按无上限兜底（SDK 直连/测试路径）', () => {
    const fired = new Set<string>();
    expect(budgetNudgeText(20, { maxSteps: 0, maxTokens: 0 }, fired)?.tier).toBe('consolidate');
  });
});

describe('AgentLoop — 渐进预算提醒（集成）', () => {
  it('提醒追加在最后一条工具结果末尾并发事件；系统提示词不被改动', async () => {
    const llm = new ToolLoopLLM(7); // 跑 6 个工具轮，第 7 轮终答
    const events: LoopEvent[] = [];
    const systems: string[] = [];
    const orig = llm.chat.bind(llm);
    llm.chat = async (req: any) => { systems.push(req.system); return orig(req); };

    const loop = new AgentLoop(llm as any, {
      runId: 'run-nudge', agentId: 'main', goal: 'test',
      tools: [echo], budget: { maxSteps: 9, maxTokens: 1_000_000 },
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });
    const r = await loop.run();

    // maxSteps=9 → consolidate@6, converge@7；本 run 6 个工具步 → consolidate 触发、converge 未到
    const nudges = events.filter(e => e.type === 'loop.budget_nudge');
    expect(nudges.map(n => n.payload?.tier)).toEqual(['consolidate']);

    // 文本挂在第 6 步（步序 = 消息里第 6 条 tool）的结果末尾
    const toolMsgs = r.messages.filter(m => m.role === 'tool');
    const withNotice = toolMsgs.filter(m => m.content.includes('[runtime notice]'));
    expect(withNotice).toHaveLength(1);
    expect(toolMsgs[toolMsgs.length - 1].content).toContain('Start consolidating');
    // 前面的工具结果未被污染（仍是合法 JSON）
    expect(JSON.parse(toolMsgs[0].content).pong).toBe(true);

    // 系统提示词全程一字未改（KV Cache 前缀稳定的等价断言）
    expect(new Set(systems).size).toBe(1);
  });

  it('短任务（阈值未到）零打扰：无事件、无文本注入', async () => {
    const llm = new ToolLoopLLM(3);
    const events: LoopEvent[] = [];
    const loop = new AgentLoop(llm as any, {
      runId: 'run-short', agentId: 'main', goal: 'test',
      tools: [echo], budget: { maxSteps: 30, maxTokens: 1_000_000 },
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });
    const r = await loop.run();
    expect(events.filter(e => e.type === 'loop.budget_nudge')).toHaveLength(0);
    expect(r.messages.some(m => m.role === 'tool' && m.content.includes('[runtime notice]'))).toBe(false);
  });
});
