import { describe, it, expect } from 'vitest';
import { AgentLoop, type LoopEvent } from '../agent-loop.js';
import type { ChatRequest, ChatResponse } from '../../providers/types.js';
import type { Tool } from '../../tools/types.js';
import { toolOk } from '../../tools/types.js';

/** 脚本化 LLM：第 1 轮调工具，第 2 轮给最终回答 */
class ScriptedLLM {
  calls: ChatRequest[] = [];
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    if (this.calls.length === 1) {
      return { content: '', toolCalls: [{ id: 'c1', name: 'demo', input: { x: 1 } }], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'tool_use' };
    }
    return { content: 'done', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end' };
  }
}

describe('工具结果双通道分离（display）', () => {
  it('display 进事件流（tool.result_preview），不进模型上下文（tool 消息只含 data）', async () => {
    const llm = new ScriptedLLM();
    const events: LoopEvent[] = [];
    const tool: Tool = {
      name: 'demo',
      description: 'demo tool',
      inputSchema: { type: 'object' },
      source: 'builtin',
      permission: 'auto',
      invoke: async () => toolOk({ payload: 'raw-data', size: 123 }, '✓ 摘要：处理完成（123 字节）'),
    };
    const loop = new AgentLoop(llm, {
      runId: 'run-d', agentId: 'main', goal: 'g', tools: [tool],
      budget: { maxSteps: 4, maxTokens: 100_000 },
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });
    await loop.run();

    // 事件通道：display 优先于 data 的 JSON 预览
    const preview = events.find(e => e.type === 'tool.result_preview');
    expect(preview?.payload?.preview).toBe('✓ 摘要：处理完成（123 字节）');
    expect(preview?.payload?.display).toBe('✓ 摘要：处理完成（123 字节）');

    // 模型上下文：第二轮请求里的 tool 消息只含 data，display 不泄漏
    const toolMsg = llm.calls[1].messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    expect(String(toolMsg?.content)).toContain('raw-data');
    expect(String(toolMsg?.content)).not.toContain('摘要');
  });

  it('未提供 display 时回退到 data 的 JSON 预览（向后兼容）', async () => {
    const llm = new ScriptedLLM();
    const events: LoopEvent[] = [];
    const tool: Tool = {
      name: 'demo',
      description: 'demo tool',
      inputSchema: { type: 'object' },
      source: 'builtin',
      permission: 'auto',
      invoke: async () => toolOk({ payload: 'plain' }),
    };
    const loop = new AgentLoop(llm, {
      runId: 'run-d2', agentId: 'main', goal: 'g', tools: [tool],
      budget: { maxSteps: 4, maxTokens: 100_000 },
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });
    await loop.run();

    const preview = events.find(e => e.type === 'tool.result_preview');
    expect(String(preview?.payload?.preview)).toContain('plain');
    expect(preview?.payload?.display).toBeUndefined();
  });
});
