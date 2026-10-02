import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-facade-'));
// 隔离真实库 + 加速（facade 层不做重试，重试在 provider 内部，见 providers/__tests__）
process.env.DATABASE_PATH = join(tmp, 'llm.db');
process.env.LLM_RETRY_BASE_DELAY_MS = '5';
process.env.LLM_MAX_RETRIES = '2';

const { llmClient } = await import('../../services/llm-client.js');
const { closeDb } = await import('../../store/index.js');

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/** 替换 llmClient 内部的 provider（M1-1 起 facade 持有 provider，重试已在 provider 层发生） */
function stubProvider(handler: () => Promise<any>): { attempts: () => number } {
  let attempts = 0;
  (llmClient as any).provider = {
    id: 'openai-compat',
    complete: async () => { attempts++; return handler(); },
    stream: async () => { attempts++; return handler(); },
  };
  return { attempts: () => attempts };
}

function httpError(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

describe('LLMClient facade — 错误归一化（M1-1：重试已下沉 provider 层）', () => {
  it('provider 成功 → complete 返回内容与 token 合计', async () => {
    const stub = stubProvider(async () => ({
      content: 'hello', toolCalls: [],
      usage: { inputTokens: 7, outputTokens: 3 }, stopReason: 'end',
    }));
    const r = await llmClient.complete([{ role: 'user', content: 'hi' }]);
    expect(r.content).toBe('hello');
    expect(r.tokensUsed).toBe(10);
    expect(stub.attempts()).toBe(1);
  });

  it('429（provider 已重试耗尽后上抛）→ 原样抛出，绝不 mock', async () => {
    stubProvider(async () => { throw httpError(429, 'rate limited'); });
    await expect(llmClient.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow('rate limited');
  });

  it('402 配额 → 友好报错（指向设置页）', async () => {
    stubProvider(async () => { throw httpError(402, 'insufficient balance'); });
    await expect(llmClient.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/配额不足.*设置/u);
  });

  it('取消信号 → AbortError', async () => {
    stubProvider(async () => { throw new Error('should not matter'); });
    const c = new AbortController();
    c.abort();
    await expect(
      llmClient.complete([{ role: 'user', content: 'hi' }], { signal: c.signal })
    ).rejects.toThrow();
  });

  it('chat()：完整能力透传（工具调用 / usage / stopReason 原样返回）', async () => {
    stubProvider(async () => ({
      content: '',
      toolCalls: [{ id: 'c1', name: 'fs_list', input: { path: '.' } }],
      usage: { inputTokens: 5, outputTokens: 2 },
      stopReason: 'tool_use',
    }));
    const r = await llmClient.chat({ messages: [{ role: 'user', content: 'list' }] });
    expect(r.stopReason).toBe('tool_use');
    expect(r.toolCalls[0].name).toBe('fs_list');
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  it('completeStream：流式路径透传 provider.stream 并转 CompleteResult', async () => {
    stubProvider(async () => ({
      content: 'streamed', toolCalls: [],
      usage: { inputTokens: 4, outputTokens: 6 }, stopReason: 'end',
    }));
    const r = await llmClient.completeStream([{ role: 'user', content: 'hi' }], () => {});
    expect(r.content).toBe('streamed');
    expect(r.tokensUsed).toBe(10);
  });
});
