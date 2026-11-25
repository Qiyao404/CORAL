import { describe, it, expect } from 'vitest';
import { FetchHealth, FETCH_HEALTH, classifyNetworkError, describeNetworkError } from '../builtin/fetch-health.js';

function netError(code: string, message = 'fetch failed'): Error {
  const err = new TypeError(message);
  (err as any).cause = Object.assign(new Error(message.toLowerCase()), { code });
  return err;
}

describe('FetchHealth · 运行级网络状态', () => {
  it('连续 10 次、≥3 个站点网络层失败 → 判定网络不可用；冷却期内不再发请求', () => {
    const h = new FetchHealth();
    const t0 = 1_000_000;
    for (let i = 0; i < 9; i++) h.record({ host: `h${i % 3}`, ok: false, network: true }, t0 + i);
    expect(h.dead).toBe(false);
    h.record({ host: 'h0', ok: false, network: true }, t0 + 9);
    expect(h.dead).toBe(true);
    expect(h.shouldAttempt(t0 + 9 + FETCH_HEALTH.PROBE_AFTER_MS - 1)).toBe(false);
    expect(h.shouldAttempt(t0 + 9 + FETCH_HEALTH.PROBE_AFTER_MS)).toBe(true);
    expect(h.note()).toContain('网络不可用');
    expect(h.note()).toContain('10 次');
    expect(h.note()).toContain('3 个不同站点');
  });

  it('只对一个站点连续失败 10 次 → 不判定（可能只是这个站点挂了）', () => {
    const h = new FetchHealth();
    for (let i = 0; i < 20; i++) h.record({ host: 'only', ok: false, network: true });
    expect(h.dead).toBe(false);
  });

  it('收到了服务器响应（哪怕 403 / 404）就清零连续计数', () => {
    const h = new FetchHealth();
    for (let i = 0; i < 9; i++) h.record({ host: `h${i % 3}`, ok: false, network: true });
    h.record({ host: 'x', ok: false, network: false }); // 403
    for (let i = 0; i < 9; i++) h.record({ host: `h${i % 3}`, ok: false, network: true });
    expect(h.dead).toBe(false);
  });

  it('探测成功 → 判定复位；探测失败 → 继续不可用并顺延', () => {
    const t0 = 1_000_000;
    const ok = new FetchHealth();
    for (let i = 0; i < 10; i++) ok.record({ host: `h${i % 3}`, ok: false, network: true }, t0 + i);
    ok.record({ host: 'h0', ok: true, network: false }, t0 + 70_000);
    expect(ok.dead).toBe(false);
    expect(ok.attemptsWhileDead).toBe(0);
    // 刚恢复：不再"不可用"，但最近一段确实很不稳 — 如实提示
    expect(ok.note()).toContain('网络不稳定');
    for (let i = 0; i < 9; i++) ok.record({ host: 'h0', ok: true, network: false }, t0 + 80_000 + i);
    expect(ok.note()).toBeNull();

    const bad = new FetchHealth();
    for (let i = 0; i < 10; i++) bad.record({ host: `h${i % 3}`, ok: false, network: true }, t0 + i);
    bad.record({ host: 'h0', ok: false, network: true }, t0 + 70_000);
    expect(bad.dead).toBe(true);
    expect(bad.attemptsWhileDead).toBe(1);
    expect(bad.shouldAttempt(t0 + 70_000 + 59_999)).toBe(false);
    expect(bad.shouldAttempt(t0 + 70_000 + 60_000)).toBe(true);
  });

  it('网络不可用期间的快速失败计入"仍在抓取"；网络正常时忽略', () => {
    const h = new FetchHealth();
    h.markFastFail();
    expect(h.attemptsWhileDead).toBe(0);
    for (let i = 0; i < 10; i++) h.record({ host: `h${i % 3}`, ok: false, network: true });
    h.markFastFail();
    h.markFastFail();
    expect(h.attemptsWhileDead).toBe(2);
    expect(h.snapshot()).toMatchObject({ dead: true, streakAtDead: 10, hostsAtDead: 3 });
  });

  it('网络不稳（最近 12 次里 ≥9 次失败）→ 提示，但不拦请求', () => {
    const h = new FetchHealth();
    for (let i = 0; i < 12; i++) h.record({ host: `h${i % 2}`, ok: i === 11, network: i !== 11 });
    // 12 次里 11 次网络层失败，但最后一次成功把连续计数清零（没到"连续 10 次"）→ 不算不可用，只是不稳
    expect(h.dead).toBe(false);
    expect(h.note()).toContain('网络不稳定');
    expect(h.note()).toContain('11 次');
    expect(h.shouldAttempt()).toBe(true);
  });

  it('状态基本正常时不打扰（note 为 null）', () => {
    const h = new FetchHealth();
    for (let i = 0; i < 12; i++) h.record({ host: 'h', ok: i % 4 !== 0, network: i % 4 === 0 });
    expect(h.note()).toBeNull();
  });
});

describe('classifyNetworkError · 底层错误分类', () => {
  it('瞬时（可重试）：连接被中断类', () => {
    for (const code of ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ERR_SOCKET_CONNECTION_TIMEOUT']) {
      expect(classifyNetworkError(netError(code))).toMatchObject({ kind: 'reset', transient: true, network: true, code });
    }
    // 只有 "fetch failed" 没有具体码：也按瞬时处理
    expect(classifyNetworkError(netError(''))).toMatchObject({ kind: 'reset', transient: true, network: true });
  });

  it('不可重试：域名解析 / 证书 / 被拒绝 / 超时', () => {
    expect(classifyNetworkError(netError('ENOTFOUND'))).toMatchObject({ kind: 'dns', transient: false, network: true });
    expect(classifyNetworkError(netError('CERT_HAS_EXPIRED'))).toMatchObject({ kind: 'tls', transient: false });
    expect(classifyNetworkError(netError('ECONNREFUSED'))).toMatchObject({ kind: 'refused', transient: false });
    expect(classifyNetworkError(netError('UND_ERR_CONNECT_TIMEOUT'))).toMatchObject({ kind: 'timeout', transient: false });
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    expect(classifyNetworkError(timeout)).toMatchObject({ kind: 'timeout', network: true });
  });

  it('取消不是网络错误；与网络无关的异常不算网络失败', () => {
    const c = new AbortController();
    c.abort();
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    expect(classifyNetworkError(aborted, c.signal)).toMatchObject({ kind: 'cancelled', network: false });
    expect(classifyNetworkError(new Error('Headers.append: "x" is an invalid header value'))).toMatchObject({ kind: 'unknown', network: false });
  });
});

describe('describeNetworkError · 给模型看的说法', () => {
  it('带底层错误码与下一步建议；配置了代理时点明可能是代理的问题', () => {
    expect(describeNetworkError('dns', 'ENOTFOUND', 'nope.example.com', false)).toContain('ENOTFOUND');
    expect(describeNetworkError('dns', 'ENOTFOUND', 'nope.example.com', false)).toContain('不要重试同一地址');
    expect(describeNetworkError('refused', 'ECONNREFUSED', 'x.example.com', true)).toContain('代理');
    expect(describeNetworkError('reset', 'ECONNRESET', 'x.example.com', false)).toContain('瞬时');
    expect(describeNetworkError('unknown', '', 'x.example.com', false)).toContain('x.example.com');
  });
});
