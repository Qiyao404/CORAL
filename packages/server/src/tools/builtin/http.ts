import type { Tool, ToolContext, ToolResult } from '../types.js';
import { toolOk, toolError } from '../types.js';

/**
 * M1-2：内置 http_fetch 工具 — agent 自主抓取网页/接口。
 * 只读、无副作用 → permission: auto。
 * 防护：协议白名单（http/https）、响应体 2MB 截断、二进制嗅探、超时与取消贯穿。
 */

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export const httpFetchTool: Tool = {
  name: 'http_fetch',
  description:
    'Fetch a URL over HTTP/HTTPS and return status, headers and the response body as text. ' +
    'Supports optional method/headers/body and timeout_ms. Large responses (>2MB) are truncated.',
  inputSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL to fetch' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP method (default GET)' },
      headers: { type: 'object', description: 'Additional request headers (string values)' },
      body: { type: 'string', description: 'Request body (string, e.g. JSON text)' },
      timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default 30000, max 120000)' },
    },
  },
  source: 'builtin',
  permission: 'auto',

  async invoke(input: any, ctx: ToolContext): Promise<ToolResult> {
    const url = String(input?.url ?? '');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return toolError('BAD_URL', `无效 URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return toolError('BAD_PROTOCOL', `仅支持 http/https，收到: ${parsed.protocol}`);
    }

    const method = String(input?.method ?? 'GET').toUpperCase();
    const timeoutMs = Math.min(Math.max(Number(input?.timeout_ms) || 30000, 1000), 120000);

    const headers: Record<string, string> = {
      'User-Agent': 'CORAL-Agent/2.0 (personal agent runtime)',
      ...(plainStringValues(input?.headers)),
    };
    const hasBody = typeof input?.body === 'string' && input.body.length > 0;
    if (hasBody && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    try {
      const response = await fetch(parsed.toString(), {
        method,
        headers,
        body: hasBody ? input.body : undefined,
        redirect: 'follow',
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]),
      });

      const contentType = response.headers.get('content-type') ?? '';
      let bodyText = '';
      let truncated = false;
      let byteLength = 0;
      if (method !== 'HEAD' && response.body) {
        // 审查 P2：流式读取 + 超限即断（原 response.text() 先全量进内存，大响应 OOM）
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        const onParentAbort = () => { void reader.cancel().catch(() => {}); };
        ctx.signal.addEventListener('abort', onParentAbort, { once: true });
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            byteLength += value.byteLength;
            if (total + value.byteLength <= MAX_BODY_BYTES) {
              chunks.push(value);
              total += value.byteLength;
            } else {
              truncated = true;
              const room = MAX_BODY_BYTES - total;
              if (room > 0) { chunks.push(value.slice(0, room)); total += room; }
              await reader.cancel().catch(() => {});
              break;
            }
            // 二进制嗅探：首块前 8KB 出现 NUL 即判二进制
            if (chunks.length === 1) {
              const head = Buffer.from(chunks[0].slice(0, 8192)).toString('utf-8');
              if (head.includes('\0')) {
                await reader.cancel().catch(() => {});
                return toolOk({
                  status: response.status,
                  ok: response.ok,
                  url: response.url,
                  contentType,
                  binary: true,
                  byteLength,
                  note: '二进制响应体未回传（可用 shell_run + curl 落盘处理）',
                });
              }
            }
          }
        } finally {
          ctx.signal.removeEventListener('abort', onParentAbort);
        }
        bodyText = chunks.length ? Buffer.concat(chunks).toString('utf-8') : '';
      } else if (method !== 'HEAD') {
        bodyText = await response.text();
        byteLength = bodyText.length;
        if (byteLength > MAX_BODY_BYTES) { bodyText = bodyText.slice(0, MAX_BODY_BYTES); truncated = true; }
      }

      return toolOk({
        status: response.status,
        ok: response.ok,
        url: response.url,
        contentType,
        body: bodyText,
        truncated,
        byteLength,
      });
    } catch (err: any) {
      if (ctx.signal.aborted) {
        return toolError('CANCELLED', '请求已取消', false);
      }
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      if (isTimeout) {
        return toolError('HTTP_TIMEOUT', `请求超时（${timeoutMs}ms）: ${url}`, true);
      }
      return toolError('HTTP_FAILED', `请求失败: ${err?.message ?? err}`, true);
    }
  },
};

function plainStringValues(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        out[k] = String(val);
      }
    }
  }
  return out;
}
