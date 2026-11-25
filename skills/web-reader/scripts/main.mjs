// web-reader — 抓取网页并抽取正文（创新点⑤）
//
// 契约见 ../SKILL.md。要点：
//  · 每个请求自带超时（默认 10s，上限 35s），必须小于脚本的 45s 总超时——不让裸请求拖到整个脚本被杀
//  · 默认桌面浏览器 UA（空 UA / 默认 node UA 是 403 的常见诱因）
//  · 只对可重试错误（连接中断 / 超时 / 5xx）做内部重试；4xx（含 403、429）绝不重试
//  · 失败时整个返回值就是 { error }（技能执行器据此判定为逻辑失败）；error 是一行带 [类型] 的说明
//  · 抓取成功但没识别出正文容器 → 降级为去标签文本（extraction: "raw"），不报错
import { emitProgress, emitLog } from '../../_lib/coral-progress.mjs';
import { extractReadable } from '../../_lib/readability.mjs';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 35_000;
const DEFAULT_RETRIES = 2;
const MAX_RETRIES = 3;
const DEFAULT_MAX_CHARS = 20_000;
const SCRIPT_TIMEOUT_MS = 45_000;

const stdin = await new Promise(resolve => {
  let data = '';
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => resolve(data));
});

let input = {};
try {
  const parsed = JSON.parse(stdin || '{}');
  input = parsed && typeof parsed.input === 'object' ? parsed.input : (parsed ?? {});
} catch {
  input = {};
}

/** stdout 是技能的"返回值"通道：只在最后写一次 JSON */
const out = value => process.stdout.write(JSON.stringify(value));
const hostOf = url => { try { return new URL(url).host; } catch { return url.slice(0, 80); } };
const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const url = String(input.url ?? '').trim();
if (!/^https?:\/\//i.test(url)) {
  out({ error: `[bad_url] 无效 URL: ${url.slice(0, 120)}` });
  process.exit(0);
}

// 超时夹在 [1s, 35s]：上限留足余量，保证"超时 + 抽取"装得进脚本的 45 秒总超时
const timeoutMs = clamp(Math.round(Number(input.timeout_ms) || DEFAULT_TIMEOUT_MS), 1000, MAX_TIMEOUT_MS);
const retries = input.retries === undefined || input.retries === null
  ? DEFAULT_RETRIES
  : clamp(Math.round(Number(input.retries) || 0), 0, MAX_RETRIES);
const maxChars = clamp(Math.round(Number(input.max_chars) || DEFAULT_MAX_CHARS), 500, 50_000);
const includeLinks = input.include_links === true;
const userAgent = typeof input.user_agent === 'string' && input.user_agent.trim() ? input.user_agent.trim() : DEFAULT_UA;

function httpError(status) {
  if (status === 403 || status === 401) {
    return { type: 'blocked', retryable: false, text: `HTTP ${status}: ${url} — 目标站点拒绝访问，不要重打同一 URL；改用替代来源或存档副本` };
  }
  if (status === 408 || status === 429) {
    return { type: 'http_4xx', retryable: false, text: `HTTP ${status}: ${url} — 对方限流 / 请求超时，立刻重试只会更糟；换源或稍后再试` };
  }
  if (status >= 500) {
    return { type: 'http_5xx', retryable: true, text: `HTTP ${status}: ${url} — 服务端临时故障` };
  }
  return { type: 'http_4xx', retryable: false, text: `HTTP ${status}: ${url} — 地址失效或无权访问，换源，勿重试` };
}

function networkError(err) {
  const code = String(err?.cause?.code ?? err?.code ?? '');
  const host = hostOf(url);
  if (err?.name === 'TimeoutError' || /timeout|aborted/i.test(String(err?.message ?? ''))) {
    return { type: 'timeout', retryable: true, text: `请求超时（${timeoutMs}ms）: ${host}` };
  }
  if (/^(ENOTFOUND|EAI_AGAIN)/.test(code) || /getaddrinfo/i.test(String(err?.cause?.message ?? ''))) {
    return { type: 'dns_error', retryable: false, text: `域名无法解析（${code || 'DNS'}）: ${host} — 域名不可达，换源` };
  }
  if (/^(CERT_|ERR_TLS_|SELF_SIGNED|UNABLE_TO_)/.test(code)) {
    return { type: 'network_error', retryable: false, text: `安全连接失败（${code}）: ${host} — 换源或存档副本` };
  }
  return { type: 'network_error', retryable: true, text: `连接失败（${code || String(err?.message ?? err).slice(0, 60)}）: ${host}` };
}

const SUGGESTION = {
  network_error: '瞬时错误；脚本内已带退避重试，调用方最多再调 1 次，仍失败换源',
  timeout: '可再调 1 次并把 timeout_ms 提到 20000–30000；仍失败放弃该源',
  http_5xx: '服务端临时故障；隔一拍再试 1 次，仍失败换源',
};

// 重试的总耗时不能撞上脚本的 45 秒总超时：给抽取留 2 秒，装不下下一次（退避 + 请求超时）就不重试了
const startedAt = Date.now();
let last = null;
let res = null;
for (let attempt = 0; ; attempt++) {
  last = null;
  try {
    emitProgress('fetch', `抓取 ${url}${attempt ? `（第 ${attempt} 次重试）` : ''}`, { percent: 20 });
    res = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) break;
    last = httpError(res.status);
    // 把响应体放掉，别让连接挂着
    await res.body?.cancel().catch(() => {});
    res = null;
  } catch (err) {
    last = networkError(err);
    res = null;
  }
  const backoff = 800 * 2 ** attempt;
  if (!last.retryable || attempt >= retries || Date.now() - startedAt + backoff + timeoutMs > SCRIPT_TIMEOUT_MS - 2000) break;
  emitLog(`抓取失败（${last.type}），${backoff}ms 后第 ${attempt + 1} 次重试`, 'warn');
  await sleep(backoff);
}

if (!res) {
  out({ error: `[${last.type}] ${last.text}${SUGGESTION[last.type] ? ` — ${SUGGESTION[last.type]}` : ''}` });
  process.exit(0);
}

try {
  emitProgress('extract', '抽取正文', { percent: 60 });
  const html = await res.text();
  const article = extractReadable(html);
  // 没识别出正文容器（article/main/常见正文 class）→ 降级：去标签文本，如实标注
  const readable = article.strategy !== 'full-page-fallback';
  const totalChars = article.content.length;
  const content = article.content.slice(0, maxChars);

  emitProgress('done', `正文 ${totalChars} 字符（${readable ? '正文容器' : '降级为去标签文本'}）`, { percent: 100 });
  emitLog(`标题: ${article.title}`);

  out({
    title: article.title,
    content,
    truncated: totalChars > maxChars,
    total_chars: totalChars,
    extraction: readable ? 'readable' : 'raw',
    ...(includeLinks ? { links: article.links } : {}),
  });
} catch (err) {
  out({ error: `[extract_error] 读取响应失败: ${String(err?.message ?? err).slice(0, 120)}` });
}
