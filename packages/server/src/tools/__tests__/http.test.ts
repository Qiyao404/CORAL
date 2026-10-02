import { describe, it, expect, afterEach } from 'vitest';
import { httpFetchTool } from '../builtin/http.js';
import { makeToolContext } from '../types.js';

function fakeFetch(handler: (url: string, init: any) => Promise<any>) {
  return handler as unknown as typeof fetch;
}

afterEach(() => {
  // vi.unstubAllGlobals 的手动版：还原 fetch
  (globalThis as any).fetch = (globalThis as any).__realFetch ?? (globalThis as any).fetch;
});

function stubFetch(handler: (url: string, init: any) => Promise<any>) {
  if (!(globalThis as any).__realFetch) (globalThis as any).__realFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = fakeFetch(handler);
}

describe('http_fetch 工具（M1-2）', () => {
  it('成功 GET：返回 status/body/headers', async () => {
    stubFetch(async () => new Response('<h1>hi</h1>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    const r = await httpFetchTool.invoke({ url: 'https://example.com' }, makeToolContext());
    expect(r.ok).toBe(true);
    expect((r.data as any).status).toBe(200);
    expect((r.data as any).body).toContain('<h1>');
    expect((r.data as any).contentType).toBe('text/html');
  });

  it('非 http(s) 协议 → BAD_PROTOCOL', async () => {
    const r = await httpFetchTool.invoke({ url: 'file:///etc/passwd' }, makeToolContext());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('BAD_PROTOCOL');
  });

  it('无效 URL → BAD_URL', async () => {
    const r = await httpFetchTool.invoke({ url: 'not a url' }, makeToolContext());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('BAD_URL');
  });

  it('超时 → HTTP_TIMEOUT（可重试标记）', async () => {
    stubFetch((_url, init) => new Promise((_res, rej) => {
      // 模拟超时中止：直接用 init.signal 触发的 AbortError/TimeoutError
      init.signal?.addEventListener('abort', () => {
        const e = new Error('timeout');
        e.name = 'TimeoutError';
        rej(e);
      });
    }));
    const r = await httpFetchTool.invoke(
      { url: 'https://slow.example.com', timeout_ms: 1000 },
      makeToolContext()
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('HTTP_TIMEOUT');
    expect(r.error?.retryable).toBe(true);
  });

  it('取消信号 → CANCELLED', async () => {
    const c = new AbortController();
    c.abort();
    const r = await httpFetchTool.invoke({ url: 'https://x.example.com' }, makeToolContext({ signal: c.signal }));
    // fetch 未被调用即抛（fetch 对已 abort 的 signal 直接 reject AbortError）
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('CANCELLED');
  });

  it('二进制响应 → binary:true 且不回传内容', async () => {
    const bin = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]);
    stubFetch(async () => new Response(bin, { headers: { 'content-type': 'image/png' } }));
    const r = await httpFetchTool.invoke({ url: 'https://x.example.com/a.png' }, makeToolContext());
    expect(r.ok).toBe(true);
    expect((r.data as any).binary).toBe(true);
    expect((r.data as any).body).toBeUndefined();
  });

  it('超长响应 → 截断标记', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024);
    stubFetch(async () => new Response(big, { headers: { 'content-type': 'text/plain' } }));
    const r = await httpFetchTool.invoke({ url: 'https://x.example.com/big' }, makeToolContext());
    expect(r.ok).toBe(true);
    expect((r.data as any).truncated).toBe(true);
    expect((r.data as any).body.length).toBe(2 * 1024 * 1024);
  });

  it('POST：method/headers/body 透传', async () => {
    let captured: any = null;
    stubFetch(async (url, init) => {
      captured = { url, init };
      return new Response('{"ok":true}', { status: 201 });
    });
    const r = await httpFetchTool.invoke(
      { url: 'https://api.example.com/v1/x', method: 'POST', body: '{"a":1}', headers: { Authorization: 'Bearer t' } },
      makeToolContext()
    );
    expect(r.ok).toBe(true);
    expect(captured.init.method).toBe('POST');
    expect(captured.init.body).toBe('{"a":1}');
    expect(captured.init.headers.Authorization).toBe('Bearer t');
    expect(captured.init.headers['Content-Type']).toBe('application/json');
  });
});
