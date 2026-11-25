import type { Tool, ToolContext, ToolResult } from '../types.js';
import { toolOk, toolError } from '../types.js';
import {
  extractHtml, looksLikeHtml, listSections, pickExcerpts,
  type ExtractedPage, type PageImage, type PageLink,
} from './html-text.js';
import { FETCH_HEALTH, FetchHealth, classifyNetworkError, describeNetworkError } from './fetch-health.js';

/**
 * M1-2：内置 http_fetch 工具 — agent 自主抓取网页/接口。
 * 只读、无副作用 → permission: auto。
 * 防护：协议白名单（http/https）、响应体 2MB 截断、二进制嗅探、超时与取消贯穿。
 *
 * 网页默认转成可读内容（title / text / links / images / meta / 结构化数据）：
 * 实测抓取失败之外最大的一块浪费是"网页源码原样进上下文"——超过 3 万字符就整篇存档、
 * 只留 1300 字预览，模型为了看正文只能一页页翻（占全部步骤的 15%）。需要源码时传 raw:true。
 *
 * 长页面（"带着问题读页面"）：
 *  · sections — 标题目录（节名 + 在全文里的偏移），模型按偏移直接跳到某一节
 *  · focus   — 关注点；正文超出内联上限时，开头之外再给出与关注点最相关的几段（excerpts，带全文偏移）
 *  全文始终在证据记录里，目录与片段只是"路标"，不改写、不概括。
 *
 * 代理支持（GAIA 评测实测发现）：Node.js 原生 fetch 不读系统代理设置，
 * 中国网络环境下维基百科等境外源全部 fetch failed——浏览器走代理能打开
 * 但 CORAL 直连出境。修复：设置 HTTP(S)_PROXY / CORAL_HTTP_PROXY 时走代理。
 *
 * 注意：undici 的 zstd 依赖在 Node 20 上不可用（CI 实测 ubuntu-node20 崩），
 * 用 createRequire + try/catch 延迟加载（仅 Node 22+ 且配了代理时才生效）。
 */
const PROXY_URL = process.env.CORAL_HTTP_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (PROXY_URL && parseInt(process.versions.node.split('.')[0]) >= 22) {
  try {
    // 延迟 require：undici 在 Node 20 上 import 即崩（zstd 缺失），Node 22+ 才加载
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const { ProxyAgent, setGlobalDispatcher } = req('undici');
    setGlobalDispatcher(new ProxyAgent(PROXY_URL));
  } catch { /* undici 不可用或代理 URL 无效 — 静默退回直连 */ }
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_UA = 'CORAL-Agent/2.0 (personal agent runtime)';

/** 网页正文的内联上限：超出部分整体存为证据记录，这里只留开头 */
export const INLINE_TEXT_CHARS = 16_000;
/** 内联链接的条数上限（只是防极端页面；平时起作用的是字符预算） */
const INLINE_LINKS = 400;
/** 链接的字符预算：下限保底；目录页 / 列表页按实际体量放宽到上限（这类页面的价值就是链接） */
const LINKS_BUDGET_CHARS = 5_000;
const LINKS_MAX_CHARS = 14_000;
/**
 * 链接放不下时，正文链接和链接列表最多占预算的这个比例，其余留给导航容器里的站点菜单 —
 * 站内分类、翻页链接也带 list / nav 标记，实测被点开的链接里三分之一是它们，不能一点不给；
 * 菜单用不完的部分照样还给前面的链接。比例由历史轨迹回放选定。
 */
const CONTENT_LINK_SHARE = 0.85;
/** 正文开头至少留这么多：链接再多也要看得出这一页在讲什么 */
const MIN_TEXT_CHARS = 6_000;
/** 提示文字的预留量（各条 notes 合计的上限附近） */
const NOTES_RESERVE_CHARS = 900;
/** 点缀信息各自的体量上限：不能挤占正文、链接和片段 */
const INLINE_IMAGES = 30;
const IMAGES_BUDGET_CHARS = 1_500;
const INLINE_META = 14;
const META_BUDGET_CHARS = 1_500;
const META_VALUE_CHARS = 300;
const INLINE_JSON_LD = 2;
const JSON_LD_BUDGET_CHARS = 1_200;
/** 单段结构化数据的截断长度 */
const JSON_LD_CHARS = 1_500;
const TRUNCATED_MARK = '…（已截断）';
/** 内联结果的总预算：给工具的结果预算（3 万）留出余量，保证不会被主循环再整体存档一次 */
const INLINE_TOTAL_BUDGET = 27_500;
const EXCERPT_BUDGET = 5_000;
const SECTIONS_BUDGET = 1_800;
/** 元信息优先级：与"这篇东西是什么、什么时候发的"直接相关的先留 */
const PRIORITY_META = [
  'title', 'description', 'og:title', 'og:description', 'article:published_time', 'article:modified_time',
  'date', 'pubdate', 'publishdate', 'author', 'og:type', 'og:url', 'og:site_name', 'og:image',
];

export const httpFetchTool: Tool = {
  name: 'http_fetch',
  description:
    'Fetch a URL over HTTP/HTTPS. HTML pages are converted to readable content by default: ' +
    '{status, url, title, text (visible text in reading order), links (content links first, then links from link lists, then site-menu links; each group in page order; the latter two carry list / nav), ' +
    'images, meta, structuredData}. ' +
    'Non-HTML responses (JSON / plain text / XML) come back unchanged in "body"; raw:true returns the untouched body (HTML source). ' +
    'Long pages: the beginning of the text is inline plus a section outline (sections); pass focus (what you are looking for) ' +
    'to also get the passages most relevant to it (excerpts, with offsets into the full text). ' +
    'The full page is stored as an evidence record (evidenceId) — read more with evidence_read(offset / path) or search it with evidence_read(query).',
  inputSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL to fetch' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP method (default GET)' },
      headers: { type: 'object', description: 'Additional request headers (string values)' },
      body: { type: 'string', description: 'Request body (string, e.g. JSON text)' },
      timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default 30000, max 120000)' },
      raw: { type: 'boolean', description: 'Return the response body unchanged. Default false: HTML pages are converted to readable text + links + meta. Use true when you need the HTML source itself (embedded scripts, attributes, hidden fields).' },
      focus: { type: 'string', description: 'What you are looking for on this page (a few keywords or the question). On long pages the most relevant passages beyond the beginning are returned as excerpts.' },
    },
  },
  source: 'builtin',
  permission: 'auto',
  effects: { accessesNetwork: true },
  isConcurrencySafe: true,
  maxResultSizeChars: 30_000,

  async invoke(input: any, ctx: ToolContext): Promise<ToolResult> {
    const url = String(input?.url ?? '');
    const hasBody = typeof input?.body === 'string' && input.body.length > 0;
    const headers: Record<string, string> = { ...plainStringValues(input?.headers) };
    if (hasBody && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const timeoutMs = Math.min(Math.max(Number(input?.timeout_ms) || 30000, 1000), 120000);

    const fetched = await fetchWithRecovery(url, {
      method: String(input?.method ?? 'GET').toUpperCase(),
      headers,
      body: hasBody ? input.body : undefined,
      timeoutMs,
    }, ctx);
    if (!fetched.ok) return fetched.result;
    const page = fetched.page;

    if (page.binary) {
      return toolOk({
        status: page.status, ok: page.ok, url: page.url, contentType: page.contentType,
        binary: true,
        byteLength: page.byteLength,
        note: '二进制响应体未回传（可用 shell_run + curl 落盘处理）',
      });
    }
    const focus = typeof input?.focus === 'string' ? input.focus.trim() : '';
    const display = `${String(input?.method ?? 'GET').toUpperCase()} ${page.url} → ${page.status}（${(page.byteLength / 1024).toFixed(1)} KB${page.truncated ? '，超出部分截断' : ''}）`;
    if (input?.raw !== true && page.text.trim() !== '' && looksLikeHtml(page.contentType, page.text)) {
      return pageResult(
        extractHtml(page.text, page.url),
        { status: page.status, ok: page.ok, url: page.url, contentType: page.contentType, truncated: page.truncated, byteLength: page.byteLength },
        ctx.saveEvidence,
        { focus },
      );
    }
    return toolOk(
      { status: page.status, ok: page.ok, url: page.url, contentType: page.contentType, body: page.text, truncated: page.truncated, byteLength: page.byteLength },
      display
    );
  },
};

// ─────────────────────── 抓取例程 ───────────────────────

export interface FetchedPage {
  status: number;
  ok: boolean;
  /** 重定向后的最终地址（相对链接的基准） */
  url: string;
  contentType: string;
  /** 按声明字符集解码后的正文；二进制响应为空串 */
  text: string;
  byteLength: number;
  truncated: boolean;
  binary: boolean;
}

export type FetchOutcome = { ok: true; page: FetchedPage } | { ok: false; result: ToolResult };

/**
 * 带恢复的抓取：网络不可用时快速失败（不发请求）、瞬时连接错误工具内重试、
 * 每次结果记入运行级网络状态、按字符集解码。失败时直接返回给模型的结果对象。
 */
export async function fetchWithRecovery(
  rawUrl: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
  ctx: ToolContext,
): Promise<FetchOutcome> {
  const url = String(rawUrl ?? '');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, result: toolError('BAD_URL', `无效 URL: ${url}`) };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, result: toolError('BAD_PROTOCOL', `仅支持 http/https，收到: ${parsed.protocol}`) };
  }
  const method = String(opts.method ?? 'GET').toUpperCase();
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 30000, 1000), 120000);
  const headers: Record<string, string> = { 'User-Agent': DEFAULT_UA, ...(opts.headers ?? {}) };

  // 运行级网络状态：网络不可用的快速失败 / 探测 / 瞬时重试都看它（没有运行级状态时每次调用各算各的）
  const health = fetchHealthOf(ctx);
  const host = parsed.hostname;
  if (!health.shouldAttempt()) {
    health.markFastFail();
    return { ok: false, result: toolError('NETWORK_DOWN', `网络不可用，本次抓取没有发出请求: ${url}\n${health.note() ?? ''}`.trim(), false) };
  }
  // 判定"网络不可用"后放行的是一次探测：不重试，失败就立刻告诉模型
  const attempts = health.dead ? 1 : 1 + FETCH_HEALTH.RETRIES;
  const idempotent = method === 'GET' || method === 'HEAD';

  let response: Response;
  let read: BodyRead;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(parsed.toString(), {
        method,
        headers,
        body: opts.body,
        redirect: 'follow',
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]),
      });
      read = await readBody(response, method, ctx);
      break;
    } catch (err: any) {
      const cls = classifyNetworkError(err, ctx.signal);
      if (cls.kind === 'cancelled') {
        return { ok: false, result: toolError('CANCELLED', '请求已取消', false) };
      }
      // 先救：连接被中断这类瞬时错误、且请求幂等 → 工具内直接重试（一次抓取失败 = 一整步模型往返）
      if (cls.transient && idempotent && attempt < attempts - 1) {
        const aborted = await sleep(FETCH_HEALTH.BACKOFF_MS[Math.min(attempt, FETCH_HEALTH.BACKOFF_MS.length - 1)], ctx.signal);
        if (aborted) return { ok: false, result: toolError('CANCELLED', '请求已取消', false) };
        continue;
      }
      if (cls.network) health.record({ host, ok: false, network: true });
      const note = health.note();
      const suffix = `${attempt > 0 ? `（已内部重试 ${attempt} 次）` : ''}${note ? `\n[网络状态] ${note}` : ''}`;
      if (cls.kind === 'timeout') {
        return { ok: false, result: toolError('HTTP_TIMEOUT', `请求超时（${timeoutMs}ms）: ${url}${suffix}`, true) };
      }
      return {
        ok: false,
        result: toolError(
          'HTTP_FAILED',
          `请求失败: ${describeNetworkError(cls.kind, cls.code, host, Boolean(PROXY_URL))}${suffix}`,
          cls.transient,
        ),
      };
    }
  }

  // 收到了服务器响应（哪怕 403 / 404）就说明网络是通的
  health.record({ host, ok: response.ok, network: false });
  return {
    ok: true,
    page: {
      status: response.status,
      ok: response.ok,
      // 个别运行时不填 response.url → 退回请求地址
      url: response.url || parsed.toString(),
      contentType: response.headers.get('content-type') ?? '',
      text: read.kind === 'text' ? read.text : '',
      byteLength: read.byteLength,
      truncated: read.kind === 'text' ? read.truncated : false,
      binary: read.kind === 'binary',
    },
  };
}

/** 这次抓取用的运行级网络状态（见 fetch-health.ts）；没有 runState 时退化为"只看本次调用" */
export function fetchHealthOf(ctx: ToolContext): FetchHealth {
  const state = ctx.runState;
  if (!state) return new FetchHealth();
  let health = state.get('fetchHealth') as FetchHealth | undefined;
  if (!(health instanceof FetchHealth)) {
    health = new FetchHealth();
    state.set('fetchHealth', health);
  }
  return health;
}

/** 可被取消打断的等待；返回 true = 等待期间被取消 */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(true); return; }
    const done = () => { signal.removeEventListener('abort', done); resolve(signal.aborted); };
    signal.addEventListener('abort', done, { once: true });
    setTimeout(done, ms);
  });
}

type BodyRead =
  | { kind: 'text'; text: string; byteLength: number; truncated: boolean }
  | { kind: 'binary'; byteLength: number };

/**
 * 读取响应体：流式、超限即断（审查 P2：原 response.text() 先全量进内存，大响应 OOM）；
 * 按声明的字符集解码（GBK / Big5 / Shift_JIS 等非 UTF-8 页面此前一律按 UTF-8 解成乱码）。
 * 二进制响应（首块出现 NUL）直接判为 binary，不回传内容。
 */
async function readBody(response: Response, method: string, ctx: ToolContext): Promise<BodyRead> {
  if (method === 'HEAD') return { kind: 'text', text: '', byteLength: 0, truncated: false };
  if (!response.body) {
    const text = await response.text();
    return { kind: 'text', text, byteLength: Buffer.byteLength(text), truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const onParentAbort = () => { void reader.cancel().catch(() => {}); };
  ctx.signal.addEventListener('abort', onParentAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
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
      if (chunks.length === 1 && Buffer.from(chunks[0].subarray(0, 8192)).includes(0)) {
        await reader.cancel().catch(() => {});
        return { kind: 'binary', byteLength: total };
      }
    }
  } finally {
    ctx.signal.removeEventListener('abort', onParentAbort);
  }
  const bytes = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
  return { kind: 'text', text: decodeBody(bytes, response.headers.get('content-type') ?? ''), byteLength: bytes.length, truncated };
}

/**
 * 按字符集解码。优先级：内容本身是合法 UTF-8（且含多字节字符）> 响应头 / 页面声明的字符集 >
 * 按 UTF-8 宽松解码。不少老站点声明 GB2312 实际发的是 UTF-8，反过来也有——先验 UTF-8 是因为
 * "合法的多字节 UTF-8"几乎不可能被别的编码碰巧产生。
 */
export function decodeBody(bytes: Buffer, contentType: string): string {
  if (bytes.length === 0) return '';
  let utf8Valid = false;
  try {
    utf8Valid = /[\u0080-\uffff]/.test(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { /* 不是合法 UTF-8 */ }
  if (utf8Valid) return bytes.toString('utf8');
  const declared =
    /charset\s*=\s*["']?([\w+-]+)/i.exec(contentType)?.[1] ||
    /<meta[^>]+charset\s*=\s*["']?([\w+-]+)/i.exec(bytes.subarray(0, 4096).toString('latin1'))?.[1];
  if (declared && !/^(utf-?8)$/i.test(declared)) {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch { /* 不认识的字符集标签 — 按 UTF-8 宽松解码 */ }
  }
  return bytes.toString('utf8');
}

// ─────────────────────── 网页 → 模型看到的结果 ───────────────────────

interface PageBase {
  status: number;
  ok: boolean;
  url: string;
  contentType: string;
  truncated: boolean;
  byteLength: number;
}

/** 链接对象进上下文前的精简：导航链接显式带 nav，正文链接只在有提示文字 / 外站时带附加字段 */
function linkForContext(link: PageLink): Record<string, unknown> {
  return {
    text: link.text,
    href: link.href,
    ...(link.title ? { title: link.title } : {}),
    ...(link.external ? { external: true } : {}),
    ...(link.nav ? { nav: true } : {}),
    ...(link.list ? { list: true } : {}),
  };
}

/** 链接的可靠程度分级：正文句子 / 表格里的 > 正文里的链接列表 > 导航容器里的（站点菜单） */
function linkTier(link: PageLink): number {
  return link.nav ? 2 : link.list ? 1 : 0;
}

/**
 * 网页 → 模型看到的结果：正文 / 链接 / 图片 / 元信息 / 结构化数据，长页面再加目录与相关片段。
 *
 * 结果总体积守在 INLINE_TOTAL_BUDGET 内：每一部分按它在 JSON 里的实际字符数记账，按重要性分配 —
 * 正文开头 → 链接 → 点缀信息（图片 / 元信息 / 结构化数据，各有上限）→ 目录 → 与关注点相关的片段。
 * 正文或链接超出内联预算时把完整页面存为证据记录（工具侧部分存档），这里只留开头与 evidenceId。
 */
export function pageResult(
  page: ExtractedPage,
  base: PageBase,
  saveEvidence: ((content: string) => string | null) | undefined,
  extra: { focus?: string } = {},
): ToolResult {
  const notes: string[] = [];
  const data: Record<string, unknown> = {
    status: base.status,
    ok: base.ok,
    url: base.url,
    contentType: base.contentType,
    title: page.title,
  };
  const focus = (extra.focus ?? '').trim();

  // ── 点缀信息：先定体量（它们不依赖正文长短）。从前往后放，到了上限就停 ──
  const images: PageImage[] = [];
  let imageChars = 0;
  for (const img of page.images) {
    const size = JSON.stringify(img).length + 1;
    if (images.length >= INLINE_IMAGES || imageChars + size > IMAGES_BUDGET_CHARS) break;
    images.push(img);
    imageChars += size;
  }
  const meta: Record<string, string> = {};
  let metaChars = 0;
  for (const key of [
    ...PRIORITY_META.filter(k => page.meta[k] !== undefined),
    ...Object.keys(page.meta).filter(k => !PRIORITY_META.includes(k)),
  ]) {
    const value = page.meta[key].slice(0, META_VALUE_CHARS);
    const size = JSON.stringify(key).length + JSON.stringify(value).length + 2;
    if (Object.keys(meta).length >= INLINE_META || metaChars + size > META_BUDGET_CHARS) break;
    meta[key] = value;
    metaChars += size;
  }
  const jsonLd: string[] = [];
  let jsonLdChars = 0;
  for (const s of page.structuredData) {
    // 每一段最多用到剩余额度：结构化数据常是长列表，开头（类型、日期、作者）才是有用的部分
    const room = Math.min(JSON_LD_CHARS, JSON_LD_BUDGET_CHARS - jsonLdChars);
    if (jsonLd.length >= INLINE_JSON_LD || room < 200) break;
    const text = cutSerialized(s, room);
    jsonLd.push(text);
    jsonLdChars += JSON.stringify(text).length + 1;
  }
  const extrasChars = (images.length ? JSON.stringify(images).length : 0)
    + (Object.keys(meta).length ? JSON.stringify(meta).length : 0)
    + (jsonLd.length ? JSON.stringify(jsonLd).length : 0);

  // ── 预算分配：结果总体积固定，正文开头 / 链接 / 相关片段按需分 ──
  // 链接按实际体量给（下限保底、上限封顶）：目录页、列表页的价值就是链接；
  // 正文开头拿剩下的（至少留一段，看得出这一页在讲什么）；带了关注点时再给相关片段留出一块 —
  // 模型特意说了要找什么，片段就不能被挤掉
  const linkSize = (l: PageLink) => JSON.stringify(linkForContext(l)).length + 1;
  const allLinkChars = page.links.reduce((n, l) => n + linkSize(l), 0) + 2;
  const linkBudget = Math.min(Math.max(allLinkChars, LINKS_BUDGET_CHARS), LINKS_MAX_CHARS);
  const textLimit = Math.min(
    Math.max(
      INLINE_TOTAL_BUDGET - linkBudget - extrasChars - SECTIONS_BUDGET - NOTES_RESERVE_CHARS - (focus ? EXCERPT_BUDGET : 0),
      MIN_TEXT_CHARS,
    ),
    INLINE_TEXT_CHARS,
  );

  const long = page.text.length > textLimit;
  // 记账口径是"序列化后的字符数"：换行、引号在 JSON 里占两个字符，按原文长度截会超一点，这里补截
  let inlineText = long ? cutAtLine(page.text, textLimit) : page.text;
  for (let i = 0; i < 4 && JSON.stringify(inlineText).length - 2 > textLimit; i++) {
    const over = JSON.stringify(inlineText).length - 2 - textLimit;
    inlineText = cutAtLine(inlineText, inlineText.length - over - 1);
  }
  data.text = inlineText;

  // 链接：一份列表，按可靠程度分三组先后列（各组内部按页面顺序）—
  //   正文句子 / 表格里的链接 → 正文里的链接列表（list：目录条目，或没用语义标签的菜单）→ 导航容器里的（nav：站点菜单）
  // · 菜单类不单独拆一份：实测模型真正点开的链接里三分之一带 list / nav 标记（站内分类、翻页都长这样）；
  // · 菜单类也不能排在前面：菜单在页面最开头，放不下时会把正文链接全挤掉；
  // · 链接放不下时导航容器保底拿一小块预算，其余给正文链接和链接列表，用不完的再还给它（比例见 CONTENT_LINK_SHARE）。
  const orderedLinks = page.links
    .map((l, i) => ({ l, i }))
    .sort((a, b) => linkTier(a.l) - linkTier(b.l) || a.i - b.i)
    .map(x => x.l);
  const navFloor = Math.min(
    orderedLinks.reduce((n, l) => n + (l.nav ? linkSize(l) : 0), 0),
    linkBudget * (1 - CONTENT_LINK_SHARE),
  );
  const links: Array<Record<string, unknown>> = [];
  const shownLinks: PageLink[] = [];
  let linkChars = 0;
  let upperOpen = true;
  for (const l of orderedLinks) {
    if (links.length >= INLINE_LINKS) break;
    // 正文链接 / 链接列表一旦放不下，后面的也不列（保证这一组列出来的是它的前一段）
    if (!l.nav && !upperOpen) continue;
    const size = linkSize(l);
    if (linkChars + size > (l.nav ? linkBudget : linkBudget - navFloor)) {
      if (l.nav) break;
      upperOpen = false;
      continue;
    }
    links.push(linkForContext(l));
    shownLinks.push(l);
    linkChars += size;
  }
  if (links.length) data.links = links;
  const linksCut = links.length < page.links.length;
  // 证据记录里的链接顺序：已列出的在前（与内联顺序一致，续读位置才对得上），没列出的按同样的分级顺序跟在后面
  const shownSet = new Set(shownLinks);
  const evidenceLinks = linksCut ? [...shownLinks, ...orderedLinks.filter(l => !shownSet.has(l))] : orderedLinks;

  // 正文或链接被截短才存证据：整页都在上下文里时不必多存一份
  const evidenceId = long || linksCut ? saveEvidence?.(JSON.stringify({ ...base, ...page, links: evidenceLinks })) ?? null : null;

  if (long) {
    data.textChars = page.text.length;
    if (evidenceId) {
      notes.push(`正文较长，这里只有开头约 ${textLimit} 字符；完整正文已存为证据记录 ${evidenceId} — ` +
        `续读用 evidence_read（evidence_id="${evidenceId}", path="text", offset=${inlineText.length}），查找直接用 query`);
      // 目录：长页面先给"有哪些节、在第几个字符"，模型按偏移直接跳到要读的那一节
      const sections = listSections(page.text);
      if (sections.length) {
        const kept: Array<Record<string, unknown>> = [];
        let used = 0;
        for (const s of sections) {
          const size = s.title.length + 48;
          if (kept.length >= 60 || used + size > SECTIONS_BUDGET) break;
          kept.push({ level: s.level, title: s.title, offset: s.offset });
          used += size;
        }
        if (kept.length) {
          data.sections = kept;
          notes.push(`sections 是全文的标题目录（偏移相对全文）：用 evidence_read（path="text", offset=…）可以直接跳到某一节`);
        }
      }
    } else {
      notes.push(`正文较长，这里只有开头约 ${textLimit} 字符，其余部分未保留`);
    }
  }

  if (linksCut || page.linksTruncated) {
    const head = `链接只列出了一部分（前 ${links.length}/${page.links.length}${page.linksTruncated ? '+' : ''} 条）`;
    if (!linksCut) {
      // 收录的都列了，但页面上还有：证据记录里同样没有后面的
      notes.push(`${head} — 页面链接过多，后面的没有收录；要找的链接不在其中时，用 raw:true 取源码自行查找`);
    } else if (evidenceId) {
      // 续读位置：证据记录的 links 字段是按 JSON 文本读的。紧凑 JSON 里第 N 条链接的起始字符
      // 正好等于"前 N 条组成的数组"的文本长度（左括号与逗号一进一出抵消）
      const offset = JSON.stringify(evidenceLinks.slice(0, links.length)).length;
      notes.push(`${head} — 其余在证据记录 ${evidenceId} 里：evidence_read（evidence_id="${evidenceId}", path="links", offset=${offset}）往后读，或用 query="关键词" 直接找`);
    } else {
      notes.push(`${head}，其余部分未保留`);
    }
  }
  if (images.length) data.images = images;
  if (Object.keys(meta).length) data.meta = meta;
  if (jsonLd.length) data.structuredData = jsonLd;

  // 相关片段：正文被截短、又给了关注点时才需要（全文都在上下文里时没有"看不见的部分"）
  if (long && focus) {
    const baseChars = JSON.stringify({ ...data, notes }).length;
    // 片段的预算按原文长度计，序列化后（换行、引号转义，加上每段的偏移字段）会大一些：留出余量
    const budget = Math.min(EXCERPT_BUDGET, INLINE_TOTAL_BUDGET - baseChars - 400);
    if (budget >= 400) {
      const excerpts = pickExcerpts(page.text, focus, { budget, excludeUntil: inlineText.length, maxBlockChars: 1200 });
      if (excerpts.length) {
        data.excerpts = excerpts.map(x => ({ offset: x.offset, text: x.text }));
        notes.push(`excerpts 是全文里与 focus 最相关的 ${excerpts.length} 段（原文摘录，偏移相对全文；各段之间有省略）`);
      }
    }
  }

  if (page.foldedRegions > 0) notes.push(`已折叠 ${page.foldedRegions} 处导航链接区（这些链接仍在 links 里，带 nav 标记）`);
  if (page.hiddenDroppedChars > 0) notes.push(`已忽略 ${page.hiddenDroppedChars} 字符的隐藏内容（站点内嵌的数据或模板，不是给人读的）`);
  if (base.status === 401 || base.status === 403 || base.status === 429) {
    notes.push(`目标站点拒绝访问（HTTP ${base.status}）— 不要重复抓取同一地址；改用搜索摘要、存档副本或其他来源`);
  } else if (base.ok && page.text.length < 300 && page.links.length < 10 && base.byteLength > 5000) {
    // 几乎没有文字也没有链接才是空壳；通篇是链接的目录页文字本来就少
    notes.push('页面几乎没有可读文字 — 内容很可能要由浏览器执行脚本后才出现。可以改用搜索摘要、该站点的接口或存档副本；若已连接浏览器抓取类工具可改用它');
  }
  if (notes.length) data.notes = notes;
  data.byteLength = base.byteLength;
  if (base.truncated) data.truncated = true;

  // 最后一道保险：各项是按实际字符数记账的，正常到不了这里；万一提示文字等比预留的多，
  // 宁可缩短正文开头也不能超出预算 — 超了会被主循环整份转存，模型只看到一条摘要
  const overflow = JSON.stringify(data).length - INLINE_TOTAL_BUDGET;
  if (overflow > 0 && typeof data.text === 'string') {
    data.text = cutAtLine(data.text, data.text.length - overflow);
  }

  const shown = inlineText.length;
  const display =
    `GET ${base.url} → ${base.status}（${(base.byteLength / 1024).toFixed(1)} KB）` +
    ` · 正文 ${page.text.length === shown ? page.text.length : `${shown}+`} 字符` +
    (links.length ? ` · 链接 ${links.length}${linksCut ? '+' : ''}` : '');
  return toolOk(data, display);
}

/** 从 limit 附近的一行末尾截断（附近没有换行就硬截） */
export function cutAtLine(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const windowStart = Math.max(0, limit - 600);
  const nl = text.lastIndexOf('\n', limit - 1);
  return nl >= windowStart ? text.slice(0, nl) : text.slice(0, limit);
}

/**
 * 把一段文本截到"放进 JSON 之后"不超过 limit 个字符（引号、换行在 JSON 里占两个字符，
 * 按原文长度截会超）。截过的话末尾带标记；标记与两侧引号各占的字符也算在 limit 里。
 */
function cutSerialized(text: string, limit: number): string {
  if (text.length <= limit && JSON.stringify(text).length <= limit) return text;
  const budget = Math.max(0, limit - TRUNCATED_MARK.length - 2);
  let n = Math.min(text.length - 1, budget);
  for (let i = 0; i < 6; i++) {
    const size = JSON.stringify(text.slice(0, n)).length - 2;
    if (size <= budget) break;
    n = Math.max(0, n - (size - budget) - 1);
  }
  return `${text.slice(0, n)}${TRUNCATED_MARK}`;
}

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
