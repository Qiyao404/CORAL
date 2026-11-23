import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

/**
 * REG-31：WebSocket 事件通道的 Origin 校验。
 *
 * CORS 白名单只管"浏览器让页面读到的 HTTP 响应"；WebSocket 不受同源策略约束 —
 * 任何打开着的网页都能连上 /ws/events 旁听全部 run 事件（工具结果预览、最终回答…）。
 * 校验必须发生在握手之前（路由的 preValidation 钩子）。
 */

const require = createRequire(import.meta.url);
const Fastify = require('fastify');
const websocket = require('@fastify/websocket');
const WebSocket = require('ws');

const { isAllowedWsOrigin, makeWsOriginGuard } = await import('../ws-origin.js');

describe('isAllowedWsOrigin（纯函数）', () => {
  const allow = ['http://localhost:3001', 'http://127.0.0.1:3001', 'https://coral.example.dev'];

  it('同源（Origin 的 host == 请求的 Host）且 Host 是本机地址 → 放行', () => {
    expect(isAllowedWsOrigin('http://127.0.0.1:3001', '127.0.0.1:3001', allow).ok).toBe(true);
    expect(isAllowedWsOrigin('http://localhost:3001', 'localhost:3001', allow).ok).toBe(true);
    expect(isAllowedWsOrigin('http://[::1]:3001', '[::1]:3001', allow).ok).toBe(true);
  });

  it('跨站（别的网站的页面连过来）→ 拒绝', () => {
    const v = isAllowedWsOrigin('http://evil.example.com', '127.0.0.1:3001', allow);
    expect(v.ok).toBe(false);
    expect(isAllowedWsOrigin('https://sub.127.0.0.1.evil.com:3001', '127.0.0.1:3001', allow).ok).toBe(false);
  });

  it('DNS 重绑定：Origin 与 Host "同源"但 Host 不是本机/白名单地址 → 拒绝', () => {
    // 恶意域名把解析指到 127.0.0.1：页面源 http://evil.test:3001，请求头 Host: evil.test:3001
    const v = isAllowedWsOrigin('http://evil.test:3001', 'evil.test:3001', allow);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('Host');
  });

  it('畸形 / "null" Origin → 拒绝（不猜）', () => {
    expect(isAllowedWsOrigin('null', '127.0.0.1:3001', allow).ok).toBe(false);
    expect(isAllowedWsOrigin('not a url', '127.0.0.1:3001', allow).ok).toBe(false);
  });

  it('非浏览器客户端（不带 Origin）→ 放行', () => {
    expect(isAllowedWsOrigin(undefined, '127.0.0.1:3001', allow).ok).toBe(true);
    expect(isAllowedWsOrigin('', '127.0.0.1:3001', allow).ok).toBe(true);
  });

  it('白名单里的显式源（如局域网/反代部署）→ 放行', () => {
    expect(isAllowedWsOrigin('https://coral.example.dev', 'coral.example.dev', allow).ok).toBe(true);
  });
});

describe('握手前拒绝（真实 WebSocket 客户端走完整 HTTP 升级）', () => {
  const app = Fastify();
  const clients = new Set<any>();
  let port = 0;
  const allow = ['http://127.0.0.1:3001', 'http://localhost:3001'];
  const allowSelf = (origin: string) => [...allow, origin];

  beforeAll(async () => {
    await app.register(websocket);
    await app.get('/ws/events', { websocket: true, preValidation: makeWsOriginGuard(() => allowSelf(`http://127.0.0.1:${port}`)) }, (socket: any) => {
      clients.add(socket);
      socket.on('close', () => clients.delete(socket));
      socket.send(JSON.stringify({ type: 'secret', preview: '用户合同第 3 页内容…' }));
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.server.address() as any).port;
  });
  afterAll(async () => {
    for (const c of clients) c.close();
    await app.close();
  });

  function dial(opts: { origin?: string; headers?: Record<string, string> }) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, opts as any);
    return new Promise<{ opened: boolean; got: string | null }>(resolve => {
      let settled = false;
      const done = (opened: boolean, got: string | null = null) => { if (!settled) { settled = true; try { ws.close(); } catch { /* */ } resolve({ opened, got }); } };
      ws.on('open', () => {
        ws.on('message', (d: any) => done(true, String(d)));
        setTimeout(() => done(true, null), 800);
      });
      ws.on('unexpected-response', (_req: any, res: any) => { res.resume(); done(false); });
      ws.on('error', () => done(false));
      setTimeout(() => done(false), 2500);
    });
  }

  it('恶意网页的源 → 握手被拒，收不到任何事件', async () => {
    const r = await dial({ origin: 'http://evil.example.com' });
    expect(r.opened).toBe(false);
  });

  it('DNS 重绑定形态（Origin 与 Host 一起伪装成外部域名）→ 握手被拒', async () => {
    const r = await dial({ origin: `http://evil.test:${port}`, headers: { host: `evil.test:${port}` } });
    expect(r.opened).toBe(false);
  });

  it('页面自己的源 / 不带 Origin 的本机客户端 → 正常连接并收到事件', async () => {
    const same = await dial({ origin: `http://127.0.0.1:${port}` });
    expect(same.opened).toBe(true);
    expect(same.got).toContain('secret');
    const local = await dial({});
    expect(local.opened).toBe(true);
  });
});
