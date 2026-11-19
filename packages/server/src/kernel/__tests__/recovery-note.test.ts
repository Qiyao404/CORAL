import { describe, it, expect } from 'vitest';
import { AgentLoop, RECOVERY_NOTE_TEXT, type AgentLoopOptions, type LoopEvent } from '../agent-loop.js';
import type { ChatRequest, ChatResponse } from '../../providers/types.js';

/**
 * 恢复指令（Recovery Note，B6）：带历史恢复执行的 run（fork 回放/会话续接）
 * 在 goal 后注入"副作用前先核对真实状态"指令 — 历史是快照不是现实。
 */

class ScriptedLLM {
  calls: ChatRequest[] = [];
  constructor(private script: Array<Partial<ChatResponse>>) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    // 快照捕获（messages 数组是引用 — loop 后续 push 会污染捕获值）
    this.calls.push({ ...req, messages: req.messages.map(m => ({ ...m })) });
    const item = this.script[Math.min(this.calls.length - 1, this.script.length - 1)];
    return {
      content: item?.content ?? 'done',
      toolCalls: item?.toolCalls ?? [],
      usage: item?.usage ?? { inputTokens: 10, outputTokens: 5 },
      stopReason: item?.stopReason ?? 'end',
    };
  }
}

function opts(over: Partial<AgentLoopOptions>): AgentLoopOptions {
  return {
    runId: 'run-rec', agentId: 'main', goal: '新目标',
    tools: [], budget: { maxSteps: 5, maxTokens: 1_000_000 },
    signal: new AbortController().signal,
    onEvent: () => {},
    ...over,
  } as AgentLoopOptions;
}

describe('Recovery Note — 恢复执行注入', () => {
  it('recoveryNote=true：goal 后注入指令（首次 LLM 请求可见），事件留痕', async () => {
    const llm = new ScriptedLLM([{ content: '已完成' }]);
    const events: LoopEvent[] = [];
    const r = await new AgentLoop(llm, opts({
      initialHistory: [{ role: 'user', content: '旧对话' }],
      recoveryNote: true,
      onEvent: e => events.push(e),
    })).run();

    expect(r.status).toBe('completed');
    // 首次请求的消息序列：旧历史 → goal → recovery note
    const msgs = llm.calls[0].messages;
    expect(msgs.map(m => m.role)).toEqual(['user', 'user', 'user']);
    expect(msgs[1].content).toBe('新目标');
    expect(msgs[2].content).toContain('SNAPSHOT, not the present');
    expect(msgs[2].content).toContain('verify the current real state');
    // 事件留痕（可观测）
    expect(events.some(e => e.type === 'loop.recovery_note')).toBe(true);
  });

  it('recoveryNote 缺省：零注入（普通 run 不受影响）', async () => {
    const llm = new ScriptedLLM([{ content: 'done' }]);
    const r = await new AgentLoop(llm, opts({})).run();
    expect(r.status).toBe('completed');
    expect(llm.calls[0].messages).toHaveLength(1);
    expect(r.messages.some(m => m.content.includes('SNAPSHOT'))).toBe(false);
  });

  it('指令随 checkpoint 持久化（fork 再重放也不丢）', async () => {
    const llm = new ScriptedLLM([{ content: 'ok' }]);
    const cps: any[] = [];
    await new AgentLoop(llm, opts({
      recoveryNote: true,
      saveCheckpoint: cp => cps.push(cp),
    })).run();
    expect(cps.length).toBeGreaterThan(0);
    // 终态 checkpoint 的消息含恢复指令（从 checkpoint 续接/fork 时模型仍能看到）
    const flat = cps[cps.length - 1].state.messages.map((m: any) => m.content).join('\n');
    expect(flat).toContain(RECOVERY_NOTE_TEXT.slice(0, 30));
  });
});
