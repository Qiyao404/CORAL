import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EvidenceStore } from '../../kernel/evidence.js';
import { makeEvidenceReadTool, resolvePath, outline, DEFAULT_PAGE_CHARS, MAX_MATCHES } from '../builtin/evidence.js';
import { makeToolContext } from '../types.js';

/**
 * evidence_read 的四种读法（2026-11-24 性能体检落地）：
 * 翻页（默认页放大）/ 按字段跳读 / 关键词检索 / 结构概览。
 * 背景：翻页读存档占全部步骤的 15.5%，单个任务最多翻过 450 页。
 */

const RUN = 'run-ev';
let dir = '';
let store: EvidenceStore;
let tool: ReturnType<typeof makeEvidenceReadTool>;
let ctx: ReturnType<typeof makeToolContext>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coral-evidence-read-'));
  store = new EvidenceStore(dir);
  tool = makeEvidenceReadTool(store);
  ctx = makeToolContext({ runId: RUN });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PAGE_JSON = {
  status: 200,
  url: 'https://example.test/a',
  title: 'Annual Report 2019',
  text: 'Intro paragraph.\n\nThe revenue was 1,234 million in 2019.\n\n' + 'filler line.\n\n'.repeat(3000) + 'Closing remark about 2019.',
  links: [
    { text: 'Home', href: 'https://example.test/' },
    { text: '2019 PDF', href: 'https://example.test/2019.pdf' },
    { text: 'Contact', href: 'https://example.test/contact' },
  ],
  meta: { description: 'Annual report', 'article:published_time': '2020-03-01T00:00:00Z' },
  count: 42,
  flags: { ok: true, note: null },
};

describe('evidence_read · 翻页', () => {
  it('默认一页 16000 字符；offset/limit 照常工作', async () => {
    const rec = store.save(RUN, 'shell_run', JSON.stringify({ stdout: 'x'.repeat(40_000) }));
    const r = await tool.invoke({ evidence_id: rec.id }, ctx);
    expect((r.data as any).content.length).toBe(DEFAULT_PAGE_CHARS);
    expect((r.data as any).hasMore).toBe(true);
    const next = await tool.invoke({ evidence_id: rec.id, offset: DEFAULT_PAGE_CHARS, limit: 500 }, ctx);
    expect((next.data as any).offset).toBe(DEFAULT_PAGE_CHARS);
    expect((next.data as any).content.length).toBe(500);
  });

  it('limit 被钳制在 [500, 30000]', async () => {
    const rec = store.save(RUN, 'shell_run', 'y'.repeat(1000));
    expect((await tool.invoke({ evidence_id: rec.id, limit: 999_999 }, ctx)).error).toBeUndefined();
    const small = await tool.invoke({ evidence_id: rec.id, limit: 10 }, ctx);
    expect((small.data as any).content.length).toBe(500);
    expect((small.data as any).hasMore).toBe(true);
  });

  it('记录不存在 → EVIDENCE_NOT_FOUND 并列出可用的', async () => {
    const rec = store.save(RUN, 'shell_run', 'abc');
    const r = await tool.invoke({ evidence_id: 'ev-nope' }, ctx);
    expect(r.error?.code).toBe('EVIDENCE_NOT_FOUND');
    expect(r.error?.message).toContain(rec.id);
  });
});

describe('evidence_read · 按字段跳读', () => {
  beforeEach(() => {
    store.save(RUN, 'http_fetch', JSON.stringify(PAGE_JSON));
  });

  it('path="text"：按原文读字符串字段，没有 JSON 转义，分页从 0 开始', async () => {
    const [rec] = store.list(RUN);
    const r = await tool.invoke({ evidence_id: rec.id, path: 'text' }, ctx);
    const d = r.data as any;
    expect(d.kind).toBe('string');
    // 原文读出：换行就是换行，不是 JSON 里的 \n 转义
    expect(d.content).toBe(PAGE_JSON.text.slice(0, DEFAULT_PAGE_CHARS));
    expect(d.content.startsWith('Intro paragraph.\n\nThe revenue was 1,234 million in 2019.\n\nfiller line.')).toBe(true);
    expect(d.offset).toBe(0);
    expect(d.totalChars).toBe(PAGE_JSON.text.length);
    expect(d.hasMore).toBe(true);
  });

  it('path 支持数组下标 / 负下标 / 嵌套字段', async () => {
    const [rec] = store.list(RUN);
    const read = async (path: string) => ((await tool.invoke({ evidence_id: rec.id, path }, ctx)).data as any).content;
    expect(JSON.parse(await read('links'))).toEqual(PAGE_JSON.links);
    expect(JSON.parse(await read('links[1]'))).toEqual(PAGE_JSON.links[1]);
    expect(await read('links[1].href')).toBe('https://example.test/2019.pdf');
    expect(await read('links[-1].text')).toBe('Contact');
    expect(await read('title')).toBe('Annual Report 2019');
    expect(await read('count')).toBe('42');
    expect(await read('flags.ok')).toBe('true');
    expect(await read('flags.note')).toBe('null');
    expect(await read('meta.article:published_time')).toBe('2020-03-01T00:00:00Z');
  });

  it('path 走不下去 → 报错指出在哪一段，并列出顶层字段', async () => {
    const [rec] = store.list(RUN);
    const r = await tool.invoke({ evidence_id: rec.id, path: 'links[9].href' }, ctx);
    expect(r.error?.code).toBe('EVIDENCE_PATH_NOT_FOUND');
    expect(r.error?.message).toContain('[9]');
    expect(r.error?.message).toContain('数组共 3 项');
    expect(r.error?.message).toContain('text(文本');
    const r2 = await tool.invoke({ evidence_id: rec.id, path: 'title.nope' }, ctx);
    expect(r2.error?.message).toContain('nope');
  });

  it('纯文本记录不能按 path 读 → 说明原因并给出替代读法', async () => {
    const rec = store.save(RUN, 'shell_run', 'plain text output\nline two');
    const r = await tool.invoke({ evidence_id: rec.id, path: 'text' }, ctx);
    expect(r.error?.code).toBe('EVIDENCE_NOT_JSON');
    expect(r.error?.message).toContain('query');
  });

  it('resolvePath：空路径 / 非对象根', () => {
    expect(resolvePath({ a: 1 }, '')).toEqual({ missing: '' });
    expect(resolvePath([1, 2], '[0]')).toEqual({ value: 1 });
    expect(resolvePath({ a: { b: [10, 20] } }, 'a.b[1]')).toEqual({ value: 20 });
    expect(resolvePath({ a: 1 }, 'a.b')).toEqual({ missing: 'b' });
    expect(resolvePath({ a: 1 }, 'a[0]')).toEqual({ missing: '[0]（这里不是数组）' });
  });
});

describe('evidence_read · 关键词检索', () => {
  it('JSON 记录：命中叶子字符串的值，带 path / 字段内 offset / 上下文片段；不区分大小写', async () => {
    const rec = store.save(RUN, 'http_fetch', JSON.stringify(PAGE_JSON));
    const r = await tool.invoke({ evidence_id: rec.id, query: '2019' }, ctx);
    const d = r.data as any;
    const paths = d.matches.map((m: any) => m.path);
    expect(paths).toContain('title');
    expect(paths).toContain('text');
    expect(paths).toContain('links[1].text');
    expect(paths).toContain('links[1].href');
    const textHit = d.matches.find((m: any) => m.path === 'text');
    expect(PAGE_JSON.text.slice(textHit.offset, textHit.offset + 4)).toBe('2019');
    expect(textHit.snippet).toContain('revenue was 1,234 million in 2019');
  });

  it('同一条字符串里的多处命中各自报出', async () => {
    const rec = store.save(RUN, 'http_fetch', JSON.stringify(PAGE_JSON));
    const d = (await tool.invoke({ evidence_id: rec.id, query: 'Closing remark' }, ctx)).data as any;
    expect(d.total).toBe(1);
    expect(d.matches[0].path).toBe('text');
    expect(d.matches[0].snippet.endsWith('…')).toBe(false);
  });

  it('键名命中：返回该键下面内容的开头', async () => {
    const rec = store.save(RUN, 'http_fetch', JSON.stringify(PAGE_JSON));
    const d = (await tool.invoke({ evidence_id: rec.id, query: 'published_time' }, ctx)).data as any;
    expect(d.matches).toHaveLength(1);
    expect(d.matches[0]).toMatchObject({ path: 'meta.article:published_time', keyMatch: true });
    expect(d.matches[0].snippet).toContain('2020-03-01');
  });

  it('命中很多：最多列 20 条并说明还有更多', async () => {
    const rec = store.save(RUN, 'shell_run', JSON.stringify({ rows: Array.from({ length: 60 }, (_, i) => `row ${i} target value`) }));
    const d = (await tool.invoke({ evidence_id: rec.id, query: 'target' }, ctx)).data as any;
    expect(d.total).toBe(60);
    expect(d.matches).toHaveLength(MAX_MATCHES);
    expect(d.hasMoreMatches).toBe(true);
    expect(d.note).toContain('换更具体的关键词');
  });

  it('纯文本记录：全文检索，path 为空串、offset 是全文位置', async () => {
    const rec = store.save(RUN, 'shell_run', 'alpha\nbeta\ngamma\nBETA again');
    const d = (await tool.invoke({ evidence_id: rec.id, query: 'beta' }, ctx)).data as any;
    expect(d.total).toBe(2);
    expect(d.matches[0].offset).toBe(6);
    expect(d.matches[1].path).toBe('');
    expect(d.matches[1].offset).toBe(17);
    expect(d.matches[1].snippet).toContain('BETA again');
  });

  it('没有命中 / query 过长', async () => {
    const rec = store.save(RUN, 'shell_run', 'nothing here');
    const d = (await tool.invoke({ evidence_id: rec.id, query: 'zebra' }, ctx)).data as any;
    expect(d.total).toBe(0);
    expect(d.matches).toEqual([]);
    const r = await tool.invoke({ evidence_id: rec.id, query: 'x'.repeat(300) }, ctx);
    expect(r.error?.code).toBe('BAD_INPUT');
  });
});

describe('evidence_read · 结构概览', () => {
  it('JSON 记录：键 / 类型 / 体量，数组给出长度与首项结构，字符串只报开头', async () => {
    const rec = store.save(RUN, 'http_fetch', JSON.stringify(PAGE_JSON));
    const d = (await tool.invoke({ evidence_id: rec.id, outline: true }, ctx)).data as any;
    expect(d.format).toBe('json');
    expect(d.totalChars).toBe(rec.chars);
    expect(d.outline.keys.title).toEqual({ type: 'string', chars: 'Annual Report 2019'.length, value: 'Annual Report 2019' });
    expect(d.outline.keys.text.type).toBe('string');
    expect(d.outline.keys.text.chars).toBe(PAGE_JSON.text.length);
    expect(d.outline.keys.text.head).toBe(PAGE_JSON.text.slice(0, 80));
    expect(d.outline.keys.links).toMatchObject({ type: 'array', length: 3, item: { type: 'object' } });
    expect(d.outline.keys.count).toEqual({ type: 'number', value: 42 });
    // 概览本身很小
    expect(JSON.stringify(d).length).toBeLessThan(2000);
  });

  it('纯文本记录：只报体量与开头', async () => {
    const rec = store.save(RUN, 'shell_run', 'line one\nline two\nline three');
    const d = (await tool.invoke({ evidence_id: rec.id, outline: true }, ctx)).data as any;
    expect(d.format).toBe('text');
    expect(d.head).toBe('line one\nline two\nline three');
    expect(d.lines).toBe(3);
  });

  it('outline：深层截断与超多键的截断', () => {
    const wide = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, i]));
    const o = outline(wide) as any;
    expect(Object.keys(o.keys)).toHaveLength(60);
    expect(o.moreKeys).toBe(10);
    const deep = { a: { b: { c: { d: { e: 'x' } } } } };
    const od = outline(deep) as any;
    expect(od.keys.a.keys.b.keys.c.keys.d).toBe('对象');
  });
});
