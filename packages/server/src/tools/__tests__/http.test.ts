import { describe, it, expect, afterEach, vi } from 'vitest';
import { httpFetchTool, decodeBody, cutAtLine, pageResult, INLINE_TEXT_CHARS } from '../builtin/http.js';
import { extractHtml } from '../builtin/html-text.js';
import { makeToolContext } from '../types.js';
import { FetchHealth } from '../builtin/fetch-health.js';

function fakeFetch(handler: (url: string, init: any) => Promise<any>) {
  return handler as unknown as typeof fetch;
}

afterEach(() => {
  // vi.unstubAllGlobals 的手动版：还原 fetch
  (globalThis as any).fetch = (globalThis as any).__realFetch ?? (globalThis as any).fetch;
  vi.useRealTimers();
});

function stubFetch(handler: (url: string, init: any) => Promise<any>) {
  if (!(globalThis as any).__realFetch) (globalThis as any).__realFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = fakeFetch(handler);
}

/** Node 原生 fetch 的网络错误形态：TypeError("fetch failed")，真正原因在 cause.code */
function netError(code: string, message = 'fetch failed'): Error {
  const err = new TypeError(message);
  (err as any).cause = Object.assign(new Error(message.toLowerCase()), { code });
  return err;
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

const PAGE = `<!doctype html><html><head><title>测试页 &amp; 更多</title>
<meta name="description" content="A page"><meta charset="utf-8"><meta property="article:published_time" content="2024-05-06T00:00:00Z">
<script type="application/ld+json">{"@type":"Article","datePublished":"2024-05-06"}</script></head>
<body><nav><a href="/">Home</a><a href="/about">About</a></nav><h1>标题</h1>
<div id="content"><div><p>First paragraph.</p></div><div><p>Second paragraph with a <a href="/rel/x">relative link</a>.</p></div></div></body></html>`;

describe('http_fetch 工具（M1-2）', () => {
  it('无效 URL → BAD_URL', async () => {
    const r = await httpFetchTool.invoke({ url: 'not a url' }, makeToolContext());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('BAD_URL');
  });

  it('非 http(s) 协议 → BAD_PROTOCOL', async () => {
    const r = await httpFetchTool.invoke({ url: 'file:///etc/passwd' }, makeToolContext());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('BAD_PROTOCOL');
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
      return new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json' } });
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
    expect((r.data as any).body).toBe('{"ok":true}');
  });
});

describe('http_fetch · 网页默认转成可读内容', () => {
  it('HTML 页面：title / text / links（绝对地址）/ meta / 结构化数据，不再回传源码', async () => {
    stubFetch(async () => html(PAGE));
    const r = await httpFetchTool.invoke({ url: 'https://example.test/dir/page.html' }, makeToolContext());
    expect(r.ok).toBe(true);
    const d = r.data as any;
    expect(d.status).toBe(200);
    expect(d.title).toBe('测试页 & 更多');
    expect(d.text).toBe('# 标题\n\nFirst paragraph.\n\nSecond paragraph with a relative link.');
    expect(d.meta).toEqual({ description: 'A page', 'article:published_time': '2024-05-06T00:00:00Z' });
    expect(d.structuredData).toEqual(['{"@type":"Article","datePublished":"2024-05-06"}']);
    expect(d.body).toBeUndefined();
    // 链接：一份列表 — 正文里的链接在前、站点菜单类的在后（带 nav 标记作提示），两组各自按页面顺序。
    // 菜单类不单独拆一份（实测模型真正点开的链接里 33% 带导航标记——站内分类、翻页都长这样），
    // 也不能排在正文链接前面（菜单在页面最开头，放不下时会把正文链接全挤掉）。
    expect(d.links).toEqual([
      { text: 'relative link', href: 'https://example.test/rel/x' },
      { text: 'Home', href: 'https://example.test/', nav: true },
      { text: 'About', href: 'https://example.test/about', nav: true },
    ]);
    expect(d).not.toHaveProperty('navLinks');
    expect(r.display).toContain('正文 62 字符');
    expect(r.display).toContain('链接 3');
  });

  it('raw:true → 原样返回源码', async () => {
    stubFetch(async () => html('<html><body><h1>hi</h1></body></html>'));
    const r = await httpFetchTool.invoke({ url: 'https://example.com', raw: true }, makeToolContext());
    expect(r.ok).toBe(true);
    expect((r.data as any).body).toContain('<h1>');
    expect((r.data as any).text).toBeUndefined();
  });

  it('非 HTML 响应（JSON / 文本 / XML）原样返回，哪怕里面夹着标签', async () => {
    for (const ct of ['application/json', 'text/plain', 'application/xml']) {
      stubFetch(async () => new Response('{"a": "<b>x</b>"}', { headers: { 'content-type': ct } }));
      const r = await httpFetchTool.invoke({ url: 'https://api.example.com/x' }, makeToolContext());
      expect((r.data as any).body, ct).toBe('{"a": "<b>x</b>"}');
      expect((r.data as any).text, ct).toBeUndefined();
    }
  });

  it('Content-Type 没写对、但正文确实是完整 HTML 文档 → 也按网页处理', async () => {
    stubFetch(async () => new Response('<!doctype html><html><body><p>Looks like html</p></body></html>', { headers: { 'content-type': 'text/plain' } }));
    const r = await httpFetchTool.invoke({ url: 'https://example.com/doc' }, makeToolContext());
    expect((r.data as any).text).toBe('Looks like html');
  });

  it('HEAD 请求没有正文 → 不走网页转换', async () => {
    stubFetch(async () => new Response(null, { status: 200, headers: { 'content-type': 'text/html' } }));
    const r = await httpFetchTool.invoke({ url: 'https://example.com', method: 'HEAD' }, makeToolContext());
    expect((r.data as any).body).toBe('');
    expect((r.data as any).text).toBeUndefined();
  });

  it('长页面：内联开头 + 完整页面存为证据记录（带 evidenceId 与续读提示）', async () => {
    const paragraphs = Array.from({ length: 400 }, (_, i) => `<p>Paragraph number ${i} ${'lorem ipsum '.repeat(6)}</p>`).join('');
    stubFetch(async () => html(`<html><body><h1>Long</h1>${paragraphs}</body></html>`));
    const saved: string[] = [];
    const ctx = makeToolContext({ saveEvidence: c => { saved.push(c); return 'ev-long-1'; } } as any);
    const r = await httpFetchTool.invoke({ url: 'https://example.com/long' }, ctx);
    const d = r.data as any;
    expect(d.text.length).toBeLessThanOrEqual(INLINE_TEXT_CHARS);
    expect(d.textChars).toBeGreaterThan(INLINE_TEXT_CHARS);
    expect(d.notes[0]).toContain('ev-long-1');
    expect(d.notes[0]).toContain(`offset=${d.text.length}`);
    const full = JSON.parse(saved[0]);
    expect(full.text.length).toBe(d.textChars);
    expect(full.text.startsWith(d.text)).toBe(true);
    // 内联结果必须留在工具的结果预算内，否则会被主循环再整体存档一次
    expect(JSON.stringify(d).length).toBeLessThan(30_000);
  });

  it('长页面但没有证据层可用：只留开头并如实说明其余未保留', async () => {
    const paragraphs = Array.from({ length: 400 }, () => `<p>${'lorem ipsum '.repeat(8)}</p>`).join('');
    stubFetch(async () => html(`<html><body>${paragraphs}</body></html>`));
    const r = await httpFetchTool.invoke({ url: 'https://example.com/long' }, makeToolContext());
    const d = r.data as any;
    expect(d.text.length).toBeLessThanOrEqual(INLINE_TEXT_CHARS);
    expect(d.notes[0]).toContain('未保留');
    expect(JSON.stringify(d).length).toBeLessThan(30_000);
  });

  it('长页面带标题目录（节名 + 偏移），模型可以按偏移直接跳到某一节', async () => {
    const sections = Array.from({ length: 40 }, (_, i) => `<h2>第 ${i} 节</h2>${'<p>这一节的内容，足够长。</p>'.repeat(30)}`).join('');
    stubFetch(async () => html(`<html><body><h1>总标题</h1>${sections}</body></html>`));
    const ctx = makeToolContext({ saveEvidence: () => 'ev-toc-1' } as any);
    const r = await httpFetchTool.invoke({ url: 'https://example.com/long' }, ctx);
    const d = r.data as any;
    expect(d.sections.length).toBeGreaterThan(5);
    expect(d.sections[0]).toMatchObject({ level: 1, title: '总标题' });
    expect(d.sections[1]).toMatchObject({ level: 2, title: '第 0 节' });
    // 目录里的偏移指向内联正文 / 证据里的位置：前几节在内联部分里能对上
    expect(d.text.slice(d.sections[1].offset, d.sections[1].offset + d.sections[1].title.length)).toBe('第 0 节');
    // 不长的页面不带目录（全文都在，不需要）
    stubFetch(async () => html('<html><body><h1>短页面</h1><p>内容</p></body></html>'));
    expect((await httpFetchTool.invoke({ url: 'https://example.com/short' }, ctx)).data as any).not.toHaveProperty('sections');
  });

  it('带关注点（focus）的长页面：开头之外再给出与关注点最相关的几段，并标明在全文里的位置', async () => {
    // 三节无关内容把"交通"一节顶到内联开头（约 1.6 万字符）之后：不看片段就找不到它
    const filler = (name: string) => `<h2>${name}</h2><p>${name}这一节讲的是别的内容，与关注点无关，这里补足长度用的文字。</p>`.repeat(150);
    const body = `<h1>某市概况</h1><p>导语：地铁是这座城市公共交通的骨干。</p>${filler('历史')}${filler('地理')}${filler('经济')}<h2>交通</h2><p>地铁三号线于 2019 年通车，日均客流量为 42 万人次。</p><p>公交系统覆盖全市，共有 200 条线路。</p>${filler('文化')}${filler('教育')}`;
    stubFetch(async () => html(`<html><body>${body}</body></html>`));
    const saved: string[] = [];
    const ctx = makeToolContext({ saveEvidence: c => { saved.push(c); return 'ev-focus-1'; } } as any);
    const r = await httpFetchTool.invoke({ url: 'https://example.com/city', focus: '地铁三号线 客流量' }, ctx);
    const d = r.data as any;
    const joined = d.excerpts.map((x: any) => x.text).join('\n');
    expect(joined).toContain('地铁三号线于 2019 年通车');
    expect(joined).not.toContain('历史这一节讲的是别的内容');
    // 开头部分里已经内联给出的相关段落不重复出现在片段里
    expect(d.text).toContain('导语：地铁是这座城市公共交通的骨干');
    expect(joined).not.toContain('导语：地铁是');
    // 片段偏移指向证据记录里的全文
    const full = JSON.parse(saved[0]).text as string;
    for (const x of d.excerpts) expect(full.slice(x.offset, x.offset + x.text.length)).toBe(x.text);
    expect(d.notes.join(' ')).toContain('excerpts');
    expect(JSON.stringify(d).length).toBeLessThan(30_000);
    // 不带 focus 时不给片段；页面不长时也不给
    expect((await httpFetchTool.invoke({ url: 'https://example.com/city' }, ctx)).data as any).not.toHaveProperty('excerpts');
    expect((await httpFetchTool.invoke({ url: 'https://example.com/city', focus: '地铁' , raw: true }, ctx)).data as any).not.toHaveProperty('excerpts');
  });

  it('长正文 + 上百条链接 + 关注点：正文开头让出篇幅，链接和与关注点相关的片段都给出来，总体积仍在预算内', async () => {
    const filler = (name: string) => `<h2>${name}</h2><p>${name}这一节讲的是别的内容，与关注点无关，这里补足长度用的文字。</p>`.repeat(120);
    const items = Array.from({ length: 120 }, (_, i) => `<li><a href="/report/chapter-${i}">第 ${i} 章的小节标题文字</a></li>`).join('');
    // "交通"一节有 5 段相关内容（每段约 900 字符）：片段必须拿得到足够的篇幅，而不是只挤出一句
    const transit = Array.from({ length: 5 }, (_, i) => `<p>地铁 ${i} 号线的客流分析：${'这是与关注点相关的正文内容，需要完整地保留下来供模型阅读。'.repeat(30)}</p>`).join('');
    // 四节无关内容把"交通"一节顶到任何正文开头范围之后：不看片段就找不到它
    stubFetch(async () => html(`<html><body><h1>总览</h1>${filler('历史')}${filler('地理')}${filler('经济')}${filler('教育')}<h2>交通</h2>${transit}${filler('文化')}<ul>${items}</ul></body></html>`));
    const r = await httpFetchTool.invoke({ url: 'https://example.com/report', focus: '地铁 客流' }, makeToolContext({ saveEvidence: () => 'ev-big' } as any));
    const d = r.data as any;
    expect(d.links.length).toBeGreaterThan(60);
    const excerpts = d.excerpts.map((x: any) => x.text).join('\n');
    expect(excerpts).toContain('地铁 0 号线的客流分析');
    expect(excerpts.length).toBeGreaterThanOrEqual(3000);
    expect(excerpts).not.toContain('这一节讲的是别的内容');
    // 正文开头不再占满 1.6 万字符：篇幅让给了链接和片段
    expect(d.text.length).toBeLessThan(INLINE_TEXT_CHARS);
    expect(JSON.stringify(d).length).toBeLessThanOrEqual(27_500);
  });

  it('长页面的截断点落在行尾，且从开头算起', () => {
    expect(cutAtLine('line one\nline two\nline three', 12)).toBe('line one');
    expect(cutAtLine('no newline here at all', 8)).toBe('no newli');
    const long = `${'a'.repeat(900)}\n${'b'.repeat(500)}\n${'c'.repeat(2000)}`;
    // 1600 处落在第三段中间：退到第二段末尾的换行，前面 1401 个字符原样保留
    expect(cutAtLine(long, 1600)).toBe(long.slice(0, 1401));
    // 附近没有换行就硬截
    expect(cutAtLine('x'.repeat(2000), 1600)).toBe('x'.repeat(1600));
  });

  it('需要脚本渲染的空壳页 → 给出换路提示', async () => {
    const shell = `<!doctype html><html><head><title>App</title>${'<script>var a=1;</script>'.repeat(300)}</head><body><div id="root"></div></body></html>`;
    stubFetch(async () => html(shell));
    const r = await httpFetchTool.invoke({ url: 'https://app.example.com/' }, makeToolContext());
    const d = r.data as any;
    expect(d.text.length).toBeLessThan(300);
    expect(d.notes.join(' ')).toContain('浏览器执行脚本');
  });

  it('被站点拒绝（403）→ 提示不要重复抓取同一地址', async () => {
    stubFetch(async () => html('<html><body><h1>Access denied</h1></body></html>', 403));
    const r = await httpFetchTool.invoke({ url: 'https://blocked.example.com/' }, makeToolContext());
    expect((r.data as any).status).toBe(403);
    expect((r.data as any).notes.join(' ')).toContain('不要重复抓取同一地址');
  });
});

describe('http_fetch · 链接密集页面（目录 / 列表 / 搜索结果）', () => {
  // 背景（996 篇存档网页实测）：每页链接数 中位 54 / p90 286，72% 的页面超过 30 条；目录页、列表页的价值就是链接。
  // 链接若只给一个很小的固定预算，模型只看得到前三十来条，其余的既看不到也没处取。
  const listing = (n: number) => html(`<html><body><h1>目录</h1><ul>${Array.from({ length: n }, (_, i) => `<li><a href="/catalog/item-${String(i).padStart(3, '0')}">第 ${i} 号条目的标题文字</a></li>`).join('')}</ul></body></html>`);

  it('正文不长、链接上百条：预算让给链接，全部内联给出，不需要存证据', async () => {
    stubFetch(async () => listing(100));
    const saved: string[] = [];
    const r = await httpFetchTool.invoke({ url: 'https://example.com/catalog' }, makeToolContext({ saveEvidence: c => { saved.push(c); return 'ev-x'; } } as any));
    const d = r.data as any;
    expect(d.links).toHaveLength(100);
    expect(d.links[99]).toMatchObject({ text: '第 99 号条目的标题文字', href: 'https://example.com/catalog/item-099' });
    expect(saved).toEqual([]);
    expect(JSON.stringify(d).length).toBeLessThan(27_500);
  });

  it('链接多到放不下：列到预算为止，完整列表存证据记录，并给出"从哪一条继续读"的准确位置', async () => {
    stubFetch(async () => listing(400));
    const saved: string[] = [];
    const r = await httpFetchTool.invoke({ url: 'https://example.com/catalog' }, makeToolContext({ saveEvidence: c => { saved.push(c); return 'ev-many'; } } as any));
    const d = r.data as any;
    expect(d.links.length).toBeGreaterThan(60);
    expect(d.links.length).toBeLessThan(400);
    expect(JSON.parse(saved[0]).links).toHaveLength(400);
    const note: string = d.notes.find((n: string) => String(n).includes('链接只列出了一部分'));
    expect(note).toContain(`前 ${d.links.length}/400 条`);
    expect(note).toContain('ev-many');
    // 续读位置 = 证据记录里 links 字段的 JSON 文本中，第一条没列出的链接的起始字符
    const m = /path="links", offset=(\d+)/.exec(note);
    expect(m).not.toBeNull();
    const target = JSON.stringify(JSON.parse(saved[0]).links);
    expect(Number(m![1])).toBe(JSON.stringify(JSON.parse(saved[0]).links.slice(0, d.links.length)).length);
    expect(target.slice(Number(m![1]))).toMatch(/^\{"text":"第 \d+ 号条目的标题文字"/);
    expect(JSON.stringify(d).length).toBeLessThan(27_500);
  });

  it('链接放不下、又没有证据层：如实说明其余部分未保留', async () => {
    stubFetch(async () => listing(400));
    const r = await httpFetchTool.invoke({ url: 'https://example.com/catalog' }, makeToolContext());
    const d = r.data as any;
    expect(d.links.length).toBeLessThan(400);
    expect(d.notes.find((n: string) => String(n).includes('链接只列出了一部分'))).toContain('未保留');
  });

  it('链接不多的普通页面：预算分配与以前一样（正文开头照常、链接全给）', async () => {
    stubFetch(async () => html(PAGE));
    const r = await httpFetchTool.invoke({ url: 'https://example.test/dir/page.html' }, makeToolContext({ saveEvidence: () => 'ev-none' } as any));
    const d = r.data as any;
    expect(d.links).toHaveLength(3);
    expect(d).not.toHaveProperty('notes');
    expect(d).not.toHaveProperty('evidenceId');
  });

  it('页面链接多过收录上限：如实标出"600+"，不假装是全部', async () => {
    stubFetch(async () => listing(700));
    const r = await httpFetchTool.invoke({ url: 'https://example.com/catalog' }, makeToolContext({ saveEvidence: () => 'ev-cap' } as any));
    const d = r.data as any;
    expect(d.links.length).toBeLessThan(600);
    const note: string = d.notes.find((n: string) => String(n).includes('链接只列出了一部分'));
    expect(note).toContain('/600+ 条');
  });

  it('收录的链接都列出来了、但页面上还有更多（超过收录上限）：如实说后面的没有收录，不给出"往后读"的承诺', () => {
    const body = `<html><body><ul>${Array.from({ length: 50 }, (_, i) => `<li><a href="/p${i}">链接 ${i}</a></li>`).join('')}</ul></body></html>`;
    const page = extractHtml(body, 'https://example.com/dir/', { maxLinks: 20 });
    const r = pageResult(page, { status: 200, ok: true, url: 'https://example.com/dir/', contentType: 'text/html', truncated: false, byteLength: 5000 }, () => 'ev-cap', {});
    const d = r.data as any;
    const notes = d.notes.join(' ');
    expect(d.links).toHaveLength(20);
    // 工具只知道"收录到了上限"，不知道页面上一共有多少：如实写成 20+，不编一个总数
    expect(notes).toContain('前 20/20+ 条');
    expect(notes).toContain('没有收录');
    expect(notes).not.toContain('path="links"');
  });

  it('正文按"放进 JSON 之后"的体积记账：换行极多的页面（清单 / 诗歌）不会因为转义而超出预算', async () => {
    const lines = Array.from({ length: 6000 }, (_, i) => `<div>条目 ${i}</div>`).join('');
    stubFetch(async () => html(`<html><body>${lines}</body></html>`));
    const r = await httpFetchTool.invoke({ url: 'https://example.com/line-only' }, makeToolContext({ saveEvidence: () => 'ev-lines' } as any));
    const d = r.data as any;
    expect(d.textChars).toBeGreaterThan(INLINE_TEXT_CHARS);
    expect(JSON.stringify(d.text).length - 2).toBeLessThanOrEqual(INLINE_TEXT_CHARS);
    expect(JSON.stringify(d).length).toBeLessThanOrEqual(27_500);
  });

  it('页面开头一大排站点菜单（百科类页面的常态）：放不下时先保正文链接，菜单类排在后面；续读位置按这个顺序算', async () => {
    // 真机：百科的得主列表页抓回来 58 条链接里 56 条是站内菜单和外站链接——排在页面最前面的菜单把预算吃光，
    // 表格里的正文链接反而看不到（回放历史轨迹：这样会挤掉 11/81 条后来被点开的正文链接）
    const menu = Array.from({ length: 200 }, (_, i) => `<a href="/menu/${i}" title="站点菜单第 ${i} 项的提示文字，写长一些让它占地方">${i === 0 ? '菜单' : `菜单项 ${i}`}</a>`).join('');
    const items = Array.from({ length: 40 }, (_, i) => `<li><a href="/entry/${i}">正文条目 ${i} 的标题文字</a></li>`).join('');
    stubFetch(async () => html(`<html><body><nav>${menu}</nav><h1>目录</h1><ul>${items}</ul></body></html>`));
    const saved: string[] = [];
    const r = await httpFetchTool.invoke({ url: 'https://example.com/chrome' }, makeToolContext({ saveEvidence: c => { saved.push(c); return 'ev-chrome'; } } as any));
    const d = r.data as any;
    expect(d.links.length).toBeLessThan(240);
    for (let i = 0; i < 40; i++) expect(d.links.some((x: any) => x.href === `https://example.com/entry/${i}`), `entry ${i}`).toBe(true);
    const firstNav = d.links.findIndex((x: any) => x.nav);
    expect(firstNav).toBe(40);
    // 这 40 条来自"一行一个链接"的列表：标 list（目录条目 or 无语义标签的菜单），不标 nav（导航容器）
    expect(d.links[0]).toMatchObject({ text: '正文条目 0 的标题文字', href: 'https://example.com/entry/0', list: true });
    expect(d.links[0].nav).toBeUndefined();
    expect(d.links[firstNav]).toMatchObject({ text: '菜单', nav: true });
    expect(d.links[firstNav].list).toBeUndefined();
    // 正文链接用不完的预算还是给菜单类（这里菜单很多，列到预算用完为止）
    expect(d.links.length - firstNav).toBeGreaterThan(40);
    const note: string = d.notes.find((n: string) => String(n).includes('链接只列出了一部分'));
    const m = /path="links", offset=(\d+)/.exec(note);
    const stored = JSON.parse(saved[0]).links;
    expect(Number(m![1])).toBe(JSON.stringify(stored.slice(0, d.links.length)).length);
    expect(JSON.stringify(stored).slice(Number(m![1]))).toMatch(/^\{"text":"菜单项/);
    expect(JSON.stringify(d).length).toBeLessThanOrEqual(27_500);
  });

  it('正文链接也多得放不下时：菜单类仍保底拿到一小块，正文链接拿其余的', async () => {
    const menu = Array.from({ length: 200 }, (_, i) => `<a href="/menu/${i}" title="站点菜单第 ${i} 项的提示文字，写长一些让它占地方">菜单项 ${i}</a>`).join('');
    // 每隔几条夹一个特别长的：放不下的那一条被跳过后，后面较短的那条也不能再插进来（否则不是"前一段"）
    const items = Array.from({ length: 300 }, (_, i) => `<p>第 ${i} 条：正文里的说明文字，附一个<a href="/entry/${i}">指向条目 ${i} 的链接${i % 7 === 0 ? `，${'这一条的链接文字特别长，用来制造长短不一的情况。'.repeat(20)}` : ''}</a>。</p>`).join('');
    stubFetch(async () => html(`<html><body><nav>${menu}</nav><h1>目录</h1>${items}</body></html>`));
    const saved: string[] = [];
    const r = await httpFetchTool.invoke({ url: 'https://example.com/both' }, makeToolContext({ saveEvidence: c => { saved.push(c); return 'ev-both'; } } as any));
    const stored = JSON.parse(saved[0]).links;
    const d = r.data as any;
    const navCount = d.links.filter((x: any) => x.nav).length;
    expect(navCount).toBeGreaterThanOrEqual(15);
    // 正文链接拿到预算的大头（这里每 7 条有一条约 1000 字符的长链接，所以条数不算多）
    expect(d.links.length - navCount).toBeGreaterThanOrEqual(60);
    // 列出来的链接必须是证据记录里那份顺序的前一段（续读位置才接得上）
    expect(JSON.stringify(stored.slice(0, d.links.length))).toBe(JSON.stringify(d.links));
    // 而且是页面顺序里连续的前一段：某一条放不下之后，后面较短的那条不能再跳着插进来
    const contentShown = d.links.filter((x: any) => !x.nav).map((x: any) => Number(/\/entry\/(\d+)$/.exec(x.href)![1]));
    expect(contentShown.length).toBeLessThan(300);
    expect(contentShown.every((n: number, i: number) => n === i)).toBe(true);
    // 被跳过的那一条仍在证据记录里（在没列出的那部分里，排在后面）
    expect(stored.filter((x: any) => !x.nav && !d.links.some((y: any) => y.href === x.href)).length).toBe(300 - contentShown.length);
    expect(JSON.stringify(d).length).toBeLessThanOrEqual(27_500);
  });

  it('样样都大的页面（长正文 + 几百条长链接 + 一堆长地址图片 / 长元信息 / 结构化数据 + 关注点）：总体积守在预算内', async () => {
    // 真实存档里有页面把结果撑到 3.3 万字符：链接按估算少算了两成，图片 / 元信息 / 结构化数据又没有总量上限。
    // 超过工具的结果上限会被主循环整份转存，模型只看到一条摘要 — 等于白抓。
    const filler = (name: string) => `<h2>${name}</h2><p>${name}这一节讲的是别的内容，与关注点无关，这里补足长度用的文字。</p>`.repeat(120);
    const longUrl = 'https://cdn.example.com/assets/images/'.padEnd(150, 'x');
    const links = Array.from({ length: 200 }, (_, i) => `<a href="${longUrl}${i}" title="这个链接的提示文字也写得特别长，用来逼近真实的体量${i}">第 ${i} 个条目的标题文字，写得比较长一些</a>`).join(' ');
    const images = Array.from({ length: 15 }, (_, i) => `<img src="${longUrl}${i}.jpg" alt="这张图片的说明文字也很长，用来逼近真实页面的体量${i}">`).join('');
    const metas = Array.from({ length: 14 }, (_, i) => `<meta name="field${i}" content="${'元信息内容'.repeat(80)}${i}">`).join('');
    const lds = Array.from({ length: 3 }, () => `<script type="application/ld+json">${'{"key":"value",'.repeat(120)}"end":true}</script>`).join('');
    stubFetch(async () => html(`<html><head>${metas}${lds}</head><body><h1>总览</h1>${filler('历史')}${filler('地理')}<h2>交通</h2><p>地铁三号线日均客流量为 42 万人次。</p>${filler('文化')}${images}<p>${links}</p></body></html>`));
    const r = await httpFetchTool.invoke({ url: 'https://example.com/everything', focus: '地铁 客流' }, makeToolContext({ saveEvidence: () => 'ev-huge' } as any));
    const d = r.data as any;
    const total = JSON.stringify(d).length;
    expect(total).toBeLessThanOrEqual(27_500);
    // 让出篇幅的是正文开头和点缀信息；模型点名要的片段、以及链接仍然给出来
    expect(d.excerpts.map((x: any) => x.text).join('\n')).toContain('地铁三号线日均客流量为 42 万人次');
    expect(d.links.length).toBeGreaterThan(40);
    expect(JSON.stringify(d.images).length).toBeLessThanOrEqual(1_600);
    expect(JSON.stringify(d.meta).length).toBeLessThanOrEqual(1_600);
    expect(JSON.stringify(d.structuredData).length).toBeLessThanOrEqual(1_300);
    // 被截短的链接可以续读，且续读位置准确
    const note: string = d.notes.find((n: string) => String(n).includes('链接只列出了一部分'));
    expect(note).toContain('path="links", offset=');
    // 各项是按实际体积记账的，不是靠最后削短正文来凑数：正文开头应当保住下限附近
    // （下限 6000，按行截断、再算上换行的转义，实际略少于 6000；记账不准时会掉到 3000 上下）
    expect(d.text.length).toBeGreaterThanOrEqual(5_300);
  });
});

describe('http_fetch · 字符集', () => {
  it('GBK 页面按声明解码（此前一律按 UTF-8 解成乱码）', async () => {
    // "中文测试" 的 GBK 编码
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
    const bytes = new TextEncoder().encode('<html><head><meta charset="gb2312"></head><body><p>');
    const tail = new TextEncoder().encode('</p></body></html>');
    const all = new Uint8Array(bytes.length + gbk.length + tail.length);
    all.set(bytes, 0); all.set(gbk, bytes.length); all.set(tail, bytes.length + gbk.length);
    stubFetch(async () => new Response(all, { headers: { 'content-type': 'text/html' } }));
    const r = await httpFetchTool.invoke({ url: 'https://cn.example.com/' }, makeToolContext());
    expect((r.data as any).text).toBe('中文测试');
  });

  it('声明是 GB2312、实际发的是 UTF-8：以内容为准', () => {
    const utf8 = Buffer.from('<p>实际是 UTF-8</p>', 'utf8');
    expect(decodeBody(utf8, 'text/html; charset=gb2312')).toBe('<p>实际是 UTF-8</p>');
  });

  it('Latin-1 页面按声明解码；不认识的字符集标签退回 UTF-8', () => {
    const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // café
    expect(decodeBody(latin, 'text/plain; charset=iso-8859-1')).toBe('café');
    expect(decodeBody(latin, 'text/plain; charset=no-such-charset')).toContain('caf');
    expect(decodeBody(Buffer.alloc(0), '')).toBe('');
  });
});

describe('http_fetch · 先救：瞬时错误在工具内重试', () => {
  it('连接被中断 → 重试后成功，模型看不到这次失败', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let n = 0;
    stubFetch(async () => { if (++n === 1) throw netError('ECONNRESET'); return new Response('ok', { headers: { 'content-type': 'text/plain' } }); });
    const pending = httpFetchTool.invoke({ url: 'https://flaky.example.com/a' }, makeToolContext());
    await vi.advanceTimersByTimeAsync(1000);
    const r = await pending;
    expect(r.ok).toBe(true);
    expect((r.data as any).body).toBe('ok');
    expect(n).toBe(2);
  });

  it('重试 2 次仍失败 → HTTP_FAILED（可重试），信息带底层错误码与重试次数', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let n = 0;
    stubFetch(async () => { n++; throw netError('ECONNRESET'); });
    const pending = httpFetchTool.invoke({ url: 'https://down.example.com/a' }, makeToolContext());
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await pending;
    expect(n).toBe(3);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('HTTP_FAILED');
    expect(r.error?.retryable).toBe(true);
    expect(r.error?.message).toContain('ECONNRESET');
    expect(r.error?.message).toContain('已内部重试 2 次');
  });

  it('非幂等请求（POST）不自动重试', async () => {
    let n = 0;
    stubFetch(async () => { n++; throw netError('ECONNRESET'); });
    const r = await httpFetchTool.invoke({ url: 'https://api.example.com/a', method: 'POST', body: '{}' }, makeToolContext());
    expect(n).toBe(1);
    expect(r.error?.code).toBe('HTTP_FAILED');
    expect(r.error?.retryable).toBe(true);
  });

  it('退避等待期间被取消 → CANCELLED，不再重试', async () => {
    const c = new AbortController();
    let n = 0;
    stubFetch(async () => { n++; c.abort(); throw netError('ECONNRESET'); });
    const r = await httpFetchTool.invoke({ url: 'https://flaky.example.com/a' }, makeToolContext({ signal: c.signal }));
    expect(n).toBe(1);
    expect(r.error?.code).toBe('CANCELLED');
  });
});

describe('http_fetch · 再说清：失败原因', () => {
  it('域名解析失败：带错误码、不可重试、给出换源建议', async () => {
    let n = 0;
    stubFetch(async () => { n++; throw netError('ENOTFOUND', 'getaddrinfo ENOTFOUND nope.example.com'); });
    const r = await httpFetchTool.invoke({ url: 'https://nope.example.com/' }, makeToolContext());
    expect(n).toBe(1);
    expect(r.error?.retryable).toBe(false);
    expect(r.error?.message).toContain('ENOTFOUND');
    expect(r.error?.message).toContain('换一个来源');
  });

  it('连接被拒绝 / 证书错误 / 连接超时：各自的说法，都不重试', async () => {
    const cases: Array<[Error, string]> = [
      [netError('ECONNREFUSED'), '连接被拒绝'],
      [netError('CERT_HAS_EXPIRED'), '安全连接失败'],
      [netError('UND_ERR_CONNECT_TIMEOUT'), '超时'],
    ];
    for (const [err, word] of cases) {
      let n = 0;
      stubFetch(async () => { n++; throw err; });
      const r = await httpFetchTool.invoke({ url: 'https://x.example.com/' }, makeToolContext());
      expect(n, word).toBe(1);
      expect(r.error?.message, word).toContain(word);
    }
  });
});

describe('http_fetch · 最后才停：网络不可用与探测', () => {
  function deadNetworkCtx() {
    const runState = new Map<string, unknown>();
    return { ctx: makeToolContext({ runState } as any), runState };
  }

  /** 连续多次抓取全部在网络层失败（工具内每次已重试 2 次） */
  async function failNTimes(ctx: ReturnType<typeof makeToolContext>, n: number) {
    for (let i = 0; i < n; i++) {
      const pending = httpFetchTool.invoke({ url: `https://h${i % 3}.example.com/p${i}` }, ctx);
      await vi.advanceTimersByTimeAsync(10_000);
      const r = await pending;
      expect(r.ok).toBe(false);
    }
  }

  it('连续 10 次、涉及 3 个不同站点都失败 → 判定网络不可用，之后的抓取不再发请求', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let n = 0;
    stubFetch(async () => { n++; throw netError('ECONNRESET'); });
    const { ctx, runState } = deadNetworkCtx();
    await failNTimes(ctx, 9);
    expect((runState.get('fetchHealth') as FetchHealth).dead).toBe(false);
    await failNTimes(ctx, 1);
    expect((runState.get('fetchHealth') as FetchHealth).dead).toBe(true);
    expect(n).toBe(30);

    const before = n;
    const r = await httpFetchTool.invoke({ url: 'https://h9.example.com/next' }, ctx);
    expect(n).toBe(before);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('NETWORK_DOWN');
    expect(r.error?.message).toContain('网络不可用');
    expect(r.error?.message).toContain('10 次');
  });

  it('只对同一个站点连续失败 10 次 → 不判定网络不可用（可能只是这个站点挂了）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubFetch(async () => { throw netError('ECONNRESET'); });
    const { ctx, runState } = deadNetworkCtx();
    for (let i = 0; i < 10; i++) {
      const pending = httpFetchTool.invoke({ url: `https://one.example.com/p${i}` }, ctx);
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
    }
    expect((runState.get('fetchHealth') as FetchHealth).dead).toBe(false);
  });

  it('网络不稳（最近 12 次里 ≥9 次失败）→ 失败信息附带网络状态提示，但仍照常发请求', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let n = 0;
    stubFetch(async () => {
      n++;
      // 前 9 次失败、其间夹 3 次成功（不连续 → 不会判定不可用），第 13 次再失败
      if ([4, 8, 12].includes(n)) return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      throw netError('ECONNRESET');
    });
    const { ctx } = deadNetworkCtx();
    let last: any = null;
    for (let i = 0; i < 13; i++) {
      const pending = httpFetchTool.invoke({ url: `https://h${i % 2}.example.com/p${i}` }, ctx);
      await vi.advanceTimersByTimeAsync(10_000);
      last = await pending;
    }
    expect(last.error?.message).toContain('[网络状态]');
    expect(last.error?.message).toContain('网络不稳定');
    expect(last.error?.message).not.toContain('网络不可用');
  });

  it('冷却期满放行一次探测：探测成功 → 自动恢复，后续抓取恢复重试', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let n = 0;
    let up = false;
    stubFetch(async () => { n++; if (up) return new Response('ok', { headers: { 'content-type': 'text/plain' } }); throw netError('ECONNRESET'); });
    const { ctx, runState } = deadNetworkCtx();
    await failNTimes(ctx, 10);
    expect((runState.get('fetchHealth') as FetchHealth).dead).toBe(true);

    // 冷却期内（判定后 30 秒）：不发请求
    const t0 = Date.now();
    vi.setSystemTime(t0 + 30_000);
    const held = await httpFetchTool.invoke({ url: 'https://h0.example.com/still' }, ctx);
    expect(held.error?.code).toBe('NETWORK_DOWN');
    expect(n).toBe(30);

    // 冷却期满：放行一次探测，成功 → 自动恢复
    vi.setSystemTime(t0 + 60_001);
    up = true;
    const r = await httpFetchTool.invoke({ url: 'https://h0.example.com/probe' }, ctx);
    expect(r.ok).toBe(true);
    expect(n).toBe(31); // 探测只发一次
    expect((runState.get('fetchHealth') as FetchHealth).dead).toBe(false);
  });

  it('探测仍失败 → 继续判定不可用并顺延下一次探测', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let n = 0;
    stubFetch(async () => { n++; throw netError('ECONNRESET'); });
    const { ctx, runState } = deadNetworkCtx();
    await failNTimes(ctx, 10);
    const health = runState.get('fetchHealth') as FetchHealth;
    expect(health.dead).toBe(true);

    const t0 = Date.now();
    vi.setSystemTime(t0 + 60_001);
    const r = await httpFetchTool.invoke({ url: 'https://h0.example.com/probe' }, ctx);
    expect(r.error?.code).toBe('HTTP_FAILED');
    expect(n).toBe(31); // 探测不重试：只发一次
    expect(health.dead).toBe(true);
    expect(health.attemptsWhileDead).toBe(1);
    expect(health.shouldAttempt(t0 + 60_001 + 30_000)).toBe(false);
    expect(health.shouldAttempt(t0 + 60_001 + 60_001)).toBe(true);
  });

  it('探测时收到了服务器响应（哪怕是 403）→ 说明网络是通的，判定复位', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let up = false;
    stubFetch(async () => { if (up) return html('<html><body><p>no</p></body></html>', 403); throw netError('ECONNRESET'); });
    const { ctx, runState } = deadNetworkCtx();
    await failNTimes(ctx, 10);
    const health = runState.get('fetchHealth') as FetchHealth;
    expect(health.dead).toBe(true);

    vi.setSystemTime(Date.now() + 60_001);
    up = true;
    const r = await httpFetchTool.invoke({ url: 'https://h0.example.com/probe' }, ctx);
    expect((r.data as any).status).toBe(403);
    expect(health.dead).toBe(false);
    expect(health.attemptsWhileDead).toBe(0);
  });

  it('没有运行级状态（单测 / SDK 直接调用）时：重试照常，但不跨调用记忆', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let n = 0;
    stubFetch(async () => { n++; throw netError('ECONNRESET'); });
    for (let i = 0; i < 12; i++) {
      const pending = httpFetchTool.invoke({ url: `https://h${i % 3}.example.com/p${i}` }, makeToolContext());
      await vi.advanceTimersByTimeAsync(10_000);
      const r = await pending;
      expect(r.error?.code).toBe('HTTP_FAILED');
    }
    expect(n).toBe(36);
  });
});
