import { describe, it, expect } from 'vitest';
import { AnthropicProvider } from '../anthropic.js';
import type { ProviderConfig } from '../types.js';

const POLICY = { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 };

function makeProvider(over: Partial<ProviderConfig> & { clientOverride: any }) {
  return new AnthropicProvider(
    { provider: 'anthropic', baseUrl: '', apiKey: 'test', model: 'claude-sonnet-4-5', ...over },
    POLICY
  );
}

function captureClient(responder: (params: any) => any) {
  const calls: any[] = [];
  return {
    calls,
    messages: {
      create: async (params: any) => { calls.push(params); return responder(params); },
    },
  };
}

describe('AnthropicProvider — 请求映射（D15 缓存默认开 / 角色交替 / system 抽取）', () => {
  it('system 抽取为独立参数，cache_control 默认开启（D15）', async () => {
    const stub = captureClient(() => ({
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }));
    await makeProvider({ clientOverride: stub }).complete({
      system: '你是助手',
      messages: [{ role: 'system', content: '补充规则' }, { role: 'user', content: 'hi' }],
    });

    const params = stub.calls[0];
    // system 参数 = [{type:'text', text: 合并文本, cache_control}]
    expect(Array.isArray(params.system)).toBe(true);
    expect(params.system[0].text).toContain('你是助手');
    expect(params.system[0].text).toContain('补充规则');
    expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' });
    // 消息数组中不再含 system 角色
    expect(params.messages.every((m: any) => m.role !== 'system')).toBe(true);
  });

  it('promptCaching: false → system 为纯字符串、工具不带 cache_control', async () => {
    const stub = captureClient(() => ({
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {},
    }));
    await makeProvider({ clientOverride: stub, promptCaching: false }).complete({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 't1', description: 'd', inputSchema: { type: 'object' } }],
    });
    const params = stub.calls[0];
    expect(typeof params.system).toBe('string');
    expect(params.tools[0].cache_control).toBeUndefined();
  });

  it('工具定义映射为 input_schema，最后一个工具带 cache_control（缓存整段前缀）', async () => {
    const stub = captureClient(() => ({
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {},
    }));
    await makeProvider({ clientOverride: stub }).complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { name: 'a', description: 'da', inputSchema: { type: 'object' } },
        { name: 'b', description: 'db', inputSchema: { type: 'object' } },
      ],
    });
    const tools = stub.calls[0].tools;
    expect(tools.map((t: any) => t.name)).toEqual(['a', 'b']);
    expect(tools[0].input_schema).toEqual({ type: 'object' });
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('角色交替合并：user → assistant(tool_use) → 连续两条 tool 结果合并为单条 user', async () => {
    const stub = captureClient(() => ({
      content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: {},
    }));
    await makeProvider({ clientOverride: stub }).complete({
      messages: [
        { role: 'user', content: '两件事' },
        { role: 'assistant', content: '', toolCalls: [
          { id: 'tu_1', name: 'fs_list', input: {} },
          { id: 'tu_2', name: 'fs_read', input: { path: 'a' } },
        ]},
        { role: 'tool', toolCallId: 'tu_1', toolName: 'fs_list', content: '[]' },
        { role: 'tool', toolCallId: 'tu_2', toolName: 'fs_read', content: 'text' },
      ],
    });

    const messages = stub.calls[0].messages;
    expect(messages).toHaveLength(3);
    // assistant: 空 text 省略，只有两个 tool_use 块
    expect(messages[1].content).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'fs_list', input: {} },
      { type: 'tool_use', id: 'tu_2', name: 'fs_read', input: { path: 'a' } },
    ]);
    // 两条 tool 结果合并进一条 user 消息（角色交替要求）
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_1', content: '[]' },
      { type: 'tool_result', tool_use_id: 'tu_2', content: 'text' },
    ]);
  });

  it('maxTokens 缺省 4096（anthropic 必填）；jsonMode 追加系统指令', async () => {
    const stub = captureClient(() => ({
      content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: {},
    }));
    await makeProvider({ clientOverride: stub }).complete({
      messages: [{ role: 'user', content: 'json please' }],
      jsonMode: true,
    });
    const params = stub.calls[0];
    expect(params.max_tokens).toBe(4096);
    expect(params.system[0].text).toContain('valid JSON');
  });
});

describe('AnthropicProvider — 响应解析与流式', () => {
  it('tool_use 块 → toolCalls；stop_reason / usage 归一', async () => {
    const stub = captureClient(() => ({
      content: [
        { type: 'text', text: '正在读取' },
        { type: 'tool_use', id: 'tu_9', name: 'fs_read', input: { path: 'x' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 50, output_tokens: 25 },
    }));
    const r = await makeProvider({ clientOverride: stub }).complete({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.content).toBe('正在读取');
    expect(r.toolCalls).toEqual([{ id: 'tu_9', name: 'fs_read', input: { path: 'x' } }]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toEqual({ inputTokens: 50, outputTokens: 25 });
  });

  it('max_tokens / end_turn 停止原因映射', async () => {
    const stub = captureClient(() => ({
      content: [{ type: 'text', text: '截断' }], stop_reason: 'max_tokens', usage: {},
    }));
    const r = await makeProvider({ clientOverride: stub }).complete({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.stopReason).toBe('max_tokens');
  });

  it('流式事件：文本增量回调 + input_json_delta 组装工具入参 + usage/stop 汇总', async () => {
    async function* events() {
      yield { type: 'message_start', message: { usage: { input_tokens: 11 } } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'He' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'y' } };
      yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_s', name: 'fs_list' } };
      yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path"' } };
      yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ': "."}' } };
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } };
    }
    const stub = { messages: { create: async () => events() } };
    const chunks: string[] = [];
    const r = await makeProvider({ clientOverride: stub }).stream(
      { messages: [{ role: 'user', content: 'hi' }] },
      d => chunks.push(d)
    );

    expect(chunks).toEqual(['He', 'y']);
    expect(r.content).toBe('Hey');
    expect(r.toolCalls).toEqual([{ id: 'tu_s', name: 'fs_list', input: { path: '.' } }]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 6 });
  });
});
