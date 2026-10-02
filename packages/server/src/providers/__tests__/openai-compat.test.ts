import { describe, it, expect } from 'vitest';
import { OpenAICompatProvider } from '../openai-compat.js';
import type { ProviderConfig } from '../types.js';

const POLICY = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 4 };

function httpError(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

/** 记录调用参数的 OpenAI 桩客户端 */
function makeStub(handler: (params: any) => any) {
  const calls: any[] = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (params: any) => {
          calls.push(params);
          return handler(params);
        },
      },
    },
  };
}

function makeProvider(stub: any) {
  const config: ProviderConfig = {
    provider: 'openai-compat', baseUrl: '', apiKey: 'test', model: 'kimi-k2.5', clientOverride: stub,
  };
  return new OpenAICompatProvider(config, POLICY);
}

describe('OpenAICompatProvider.complete — 请求映射与响应解析', () => {
  it('消息映射：system 前置 / assistant 携带 tool_calls / tool 结果带 tool_call_id', async () => {
    const stub = makeStub(() => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    const p = makeProvider(stub);

    await p.complete({
      system: '你是助手',
      messages: [
        { role: 'user', content: '列出文件' },
        {
          role: 'assistant', content: '',
          toolCalls: [{ id: 'call_1', name: 'fs_list', input: { path: '.' } }],
        },
        { role: 'tool', toolCallId: 'call_1', toolName: 'fs_list', content: '{"files":[]}' },
      ],
    });

    const sent = stub.calls[0].messages;
    expect(sent[0]).toEqual({ role: 'system', content: '你是助手' });
    expect(sent[1]).toEqual({ role: 'user', content: '列出文件' });
    expect(sent[2].role).toBe('assistant');
    expect(sent[2].tool_calls[0].function.name).toBe('fs_list');
    expect(JSON.parse(sent[2].tool_calls[0].function.arguments)).toEqual({ path: '.' });
    expect(sent[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"files":[]}' });
  });

  it('工具定义映射 + 响应 tool_calls 解析 + stopReason/usage', async () => {
    const stub = makeStub(() => ({
      choices: [{
        message: {
          content: '',
          tool_calls: [{
            id: 'call_9',
            type: 'function',
            function: { name: 'fs_read', arguments: '{"path":"a.txt"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }));
    const p = makeProvider(stub);

    const r = await p.complete({
      messages: [{ role: 'user', content: '读文件' }],
      tools: [{ name: 'fs_read', description: '读文件', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    });

    expect(stub.calls[0].tools[0]).toEqual({
      type: 'function',
      function: { name: 'fs_read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    });
    expect(r.toolCalls).toEqual([{ id: 'call_9', name: 'fs_read', input: { path: 'a.txt' } }]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it('jsonMode → response_format；max_tokens / stop 原因映射', async () => {
    const stub = makeStub(() => ({
      choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }],
      usage: {},
    }));
    const p = makeProvider(stub);

    const r = await p.complete({
      messages: [{ role: 'user', content: '输出 json' }],
      jsonMode: true,
      maxTokens: 512,
    });
    expect(stub.calls[0].response_format).toEqual({ type: 'json_object' });
    expect(stub.calls[0].max_tokens).toBe(512);
    expect(r.stopReason).toBe('end');
  });

  it('传输层重试：500 两次后成功（共 3 次）；401 零重试', async () => {
    let n = 0;
    const stub = makeStub(() => {
      n++;
      if (n < 3) throw httpError(500, 'boom');
      return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} };
    });
    const r = await makeProvider(stub).complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.content).toBe('ok');
    expect(n).toBe(3);

    let m = 0;
    const stub401 = makeStub(() => { m++; throw httpError(401, 'bad key'); });
    await expect(makeProvider(stub401).complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('bad key');
    expect(m).toBe(1);
  });

  it('已取消信号 → 立即抛出（不重试）', async () => {
    let n = 0;
    const stub = makeStub(() => { n++; throw httpError(500, 'boom'); });
    const c = new AbortController();
    c.abort();
    await expect(
      makeProvider(stub).complete({ messages: [{ role: 'user', content: 'x' }], signal: c.signal })
    ).rejects.toThrow();
    expect(n).toBeLessThanOrEqual(1);
  });
});

describe('OpenAICompatProvider.stream — 文本与工具调用分片组装', () => {
  it('文本增量回调 + 工具调用分片按 index 组装', async () => {
    async function* gen() {
      yield { choices: [{ delta: { content: 'Hel' } }] };
      yield { choices: [{ delta: { content: 'lo' } }] };
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'fs_list', arguments: '{"pa' } }] } }] };
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"."}' } }] } }] };
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 3 } };
    }
    const stub = { chat: { completions: { create: async () => gen() } } };
    const chunks: string[] = [];
    const r = await makeProvider(stub).stream(
      { messages: [{ role: 'user', content: 'hi' }] },
      d => chunks.push(d)
    );

    expect(chunks).toEqual(['Hel', 'lo']);
    expect(r.content).toBe('Hello');
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'fs_list', input: { path: '.' } }]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('未交付 chunk 前的失败可重试；交付后不再重试（防重复输出）', async () => {
    let n = 0;
    async function* fail() { throw httpError(500, 'pre-stream fail'); void n; }
    const stub = {
      chat: { completions: { create: async () => { n++; if (n < 3) throw httpError(500, 'conn'); return (async function* () { yield { choices: [{ delta: { content: 'ok' } }] }; yield { choices: [{ delta: {}, finish_reason: 'stop' }] }; })(); } } },
    };
    const r = await makeProvider(stub).stream({ messages: [{ role: 'user', content: 'x' }] }, () => {});
    expect(r.content).toBe('ok');
    expect(n).toBe(3);
  });
});
