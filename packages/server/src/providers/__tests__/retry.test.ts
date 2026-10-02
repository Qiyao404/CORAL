import { describe, it, expect } from 'vitest';
import {
  classifyProviderError,
  withRetry,
  jitterDelayMs,
  type RetryPolicy,
} from '../retry.js';

const POLICY: RetryPolicy = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 8 };

function httpError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

describe('classifyProviderError — 错误分类学（M0-4 / A5）', () => {
  it('429 / 408 / 5xx → transient（可重试）', () => {
    expect(classifyProviderError(httpError(429))).toBe('transient');
    expect(classifyProviderError(httpError(408))).toBe('transient');
    expect(classifyProviderError(httpError(500))).toBe('transient');
    expect(classifyProviderError(httpError(503, 'service unavailable'))).toBe('transient');
  });

  it('401 / 402 / 400 / 404 / 422 → permanent（不可重试）', () => {
    for (const s of [400, 401, 402, 403, 404, 422]) {
      expect(classifyProviderError(httpError(s))).toBe('permanent');
    }
  });

  it('网络层错误（无 status）→ transient', () => {
    expect(classifyProviderError(new Error('Connection error.'))).toBe('transient');
    expect(classifyProviderError(new Error('fetch failed'))).toBe('transient');
    const e: any = new Error('socket hang up');
    e.code = 'ECONNRESET';
    expect(classifyProviderError(e)).toBe('transient');
  });

  it('abort 最优先：signal 已取消时无论错误类型都判 abort', () => {
    const controller = new AbortController();
    controller.abort();
    expect(classifyProviderError(httpError(500), controller.signal)).toBe('abort');
    expect(classifyProviderError(new Error('whatever'), controller.signal)).toBe('abort');
  });

  it('AbortError / APIUserAbortError 名称识别', () => {
    const e = new Error('LLM 调用已取消');
    e.name = 'AbortError';
    expect(classifyProviderError(e)).toBe('abort');
    const fake = new Error('Request was aborted.');
    Object.defineProperty(fake, 'constructor', { value: function APIUserAbortError() {} });
    expect(classifyProviderError(fake)).toBe('abort');
  });

  it('未知错误保守按 permanent（不对确定性错误空转）', () => {
    expect(classifyProviderError(new Error('weird stuff'))).toBe('permanent');
    expect(classifyProviderError(undefined)).toBe('permanent');
  });
});

describe('jitterDelayMs — 指数退避 + 抖动', () => {
  it('延迟在计算值的 50%~100% 之间，且不超过 maxDelayMs', () => {
    const policy: RetryPolicy = { maxRetries: 5, baseDelayMs: 100, maxDelayMs: 800 };
    for (let attempt = 0; attempt < 10; attempt++) {
      for (let i = 0; i < 20; i++) {
        const exp = Math.min(800, 100 * 2 ** attempt);
        const d = jitterDelayMs(attempt, policy);
        expect(d).toBeGreaterThanOrEqual(Math.floor(exp * 0.5));
        expect(d).toBeLessThanOrEqual(exp);
      }
    }
    // 封顶：第 5 次重试的指数值 3200 → 封顶 800
    expect(jitterDelayMs(5, policy)).toBeLessThanOrEqual(800);
  });
});

describe('withRetry — 通用重试执行器', () => {
  it('transient 失败 N 次后成功 → 返回成功值', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw httpError(503);
        return 'ok';
      },
      POLICY,
      { isRetryable: err => classifyProviderError(err) === 'transient' }
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('permanent 错误立即抛出（零重试）', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw httpError(401);
        },
        POLICY,
        { isRetryable: err => classifyProviderError(err) === 'transient' }
      )
    ).rejects.toThrow('401');
    expect(attempts).toBe(1);
  });

  it('abort 错误立即抛出（零重试）', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          const e = new Error('LLM 调用已取消');
          e.name = 'AbortError';
          throw e;
        },
        POLICY,
        { isRetryable: err => classifyProviderError(err) === 'transient' }
      )
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it('重试耗尽 → 抛出最后一个错误', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw httpError(429, 'rate limited');
        },
        POLICY,
        { isRetryable: err => classifyProviderError(err) === 'transient' }
      )
    ).rejects.toThrow('rate limited');
    expect(attempts).toBe(4); // 首次 + 3 次重试
  });

  it('onRetry 回调收到尝试序号与延迟', async () => {
    const calls: Array<{ attempt: number; delay: number }> = [];
    let attempts = 0;
    await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) throw httpError(500);
        return 42;
      },
      POLICY,
      {
        isRetryable: () => true,
        onRetry: (attempt, delay) => calls.push({ attempt, delay }),
      }
    );
    expect(calls).toEqual([{ attempt: 1, delay: expect.any(Number) }]);
  });
});
