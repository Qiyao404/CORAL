import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * WebSocket 升级请求的 Origin 校验（REG-31）。
 *
 * 为什么需要：CORS 白名单只约束"浏览器让页面读取的 HTTP 响应"；WebSocket 不受同源
 * 策略约束 — 浏览器照样替任意网页发起跨站连接并带上 Origin 头，接不接由服务器自己定。
 * /ws/events 把全部 run 事件（工具结果预览、最终回答…）推给每一个连上来的客户端：
 * 不校验 = 任何打开着的网页都能连上来旁听。
 *
 * 规则（三条都要满足）：
 *  1. Origin 必须是合法 URL（缺失 = 非浏览器客户端：CLI / 评测脚本 / 本机进程 → 放行；
 *     本机进程不受浏览器同源模型约束，校验对它没有意义；"null" 与畸形值一律拒绝）
 *  2. 同源：Origin 的 host 必须等于请求的 Host
 *  3. Host 必须是本机地址（localhost / 127.0.0.1 / ::1）或白名单源的 host —
 *     防 DNS 重绑定：恶意域名把解析指到 127.0.0.1，页面源与请求 Host 会"同源"地一起变坏
 * 局域网 / 反向代理部署：把页面所在的源加进 CORS_ALLOWED_ORIGINS（与 HTTP 白名单共用一份）。
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface WsOriginVerdict {
  ok: boolean;
  reason?: string;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function isLoopback(hostWithPort: string): boolean {
  const h = hostWithPort.toLowerCase().replace(/:\d+$/, ''); // 去端口（IPv6 的 [::1] 保留方括号）
  return LOOPBACK_HOSTS.has(h);
}

export function isAllowedWsOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowlist: readonly string[] = [],
): WsOriginVerdict {
  if (!origin || !origin.trim()) return { ok: true };
  const originHost = hostOf(origin);
  if (!originHost) return { ok: false, reason: 'Origin 不是合法的源' };
  const requestHost = String(host ?? '').toLowerCase();
  if (originHost !== requestHost) return { ok: false, reason: '跨站连接（Origin 与 Host 不同源）' };
  if (isLoopback(requestHost)) return { ok: true };
  if (allowlist.some(a => hostOf(a) === requestHost)) return { ok: true };
  return { ok: false, reason: 'Host 既不是本机地址也不在白名单里（疑似 DNS 重绑定）' };
}

/**
 * 路由级 preValidation 钩子：校验发生在握手之前，拒绝 = 返回 403，连接不会建立。
 * allowlist 用 getter（CORS 白名单在应用装配时才确定）。
 */
export function makeWsOriginGuard(getAllowlist: () => readonly string[], onReject?: (reason: string) => void) {
  return async function wsOriginGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const headers = request.headers as Record<string, string | string[] | undefined>;
    const rawOrigin = headers.origin;
    const rawHost = headers.host;
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
    const host = Array.isArray(rawHost) ? rawHost[0] : rawHost;
    const verdict = isAllowedWsOrigin(origin, host, getAllowlist());
    if (verdict.ok) return;
    onReject?.(verdict.reason ?? 'origin rejected');
    await reply.code(403).send({ error: 'Forbidden', reason: verdict.reason });
  };
}
