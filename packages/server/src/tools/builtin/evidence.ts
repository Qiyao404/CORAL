import type { Tool, ToolResult } from '../types.js';
import { toolOk, toolError } from '../types.js';
import type { EvidenceStore } from '../../kernel/evidence.js';

/**
 * evidence_read — 读取证据记录（summary-first 配套工具）。
 *
 * 大结果被归档后，模型（以及后续工具轮次）通过本工具按 ID 取回内容。只读、幂等。四种读法：
 *  · 翻页：offset/limit 顺序读（默认一页 16000 字符）
 *  · 跳读：path 指定 JSON 记录里的一个字段（网页存档的 text / links / body，接口数据的某个数组项）
 *  · 检索：query 在整条记录里做不区分大小写的字面搜索，返回命中位置（path + offset + 上下文片段）
 *  · 概览：outline=true 先看结构（键 / 类型 / 体量），再决定读哪里
 *
 * 实测：翻页读存档占全部步骤的 15.5%，单个任务最多翻过 450 页——旧实现只能从头一页页翻，
 * 一页就是一步模型往返（中位要重读 7.5 万 token 的上下文）。检索与跳读把"找一句话"从几十步压到一两步。
 */
/** 单页字符上限：必须小于内核的单条裁剪线（40k）— 否则页的中段被静默裁掉，
 *  而 offset/hasMore 仍按请求的 limit 推进，模型以为读完了、实际缺一段 */
const MAX_PAGE_CHARS = 30_000;
/** 默认页大小（旧值 8000：一个 5 万字符的存档要翻 7 页） */
export const DEFAULT_PAGE_CHARS = 16_000;
/** 检索一次最多返回的命中数 / 最多累计计到多少 */
export const MAX_MATCHES = 20;
const MATCH_COUNT_CAP = 500;
/** 命中片段前后各带多少字符 */
const SNIPPET_CONTEXT = 160;

export function makeEvidenceReadTool(store: EvidenceStore): Tool {
  return {
    name: 'evidence_read',
    description:
      'Read back an archived evidence record (large tool results are stored as evidence instead of staying in context). ' +
      'Pass the evidence_id from a previous tool result note. Four ways to read: ' +
      '(1) page through it with offset/limit (default page 16000 chars); ' +
      '(2) path="..." reads ONE field of a JSON record — e.g. path="text" for the readable text of an archived web page, ' +
      'path="links" for its links, path="body" for a raw response body, path="items[3]" for one array element; ' +
      '(3) query="..." searches the whole record (case-insensitive, literal) and returns up to 20 matches with ' +
      'path + offset + snippet — use this instead of paging when you look for something specific; ' +
      '(4) outline=true shows the structure (keys, types, sizes) so you can pick the right field. ' +
      'Prefer query / outline / path over sequential paging for large records.',
    inputSchema: {
      type: 'object',
      required: ['evidence_id'],
      properties: {
        evidence_id: { type: 'string', description: 'Evidence record ID, e.g. "ev-xxxx-xxxx" (from a tool result note)' },
        offset: { type: 'integer', description: 'Character offset to start reading from (default 0). With path: offset inside that field.' },
        limit: { type: 'integer', description: `Max characters to read (default ${DEFAULT_PAGE_CHARS}, max ${MAX_PAGE_CHARS})` },
        path: { type: 'string', description: 'Read one field of a JSON record instead of the raw JSON text: "text", "links", "body", "data.items[3]", ...' },
        query: { type: 'string', description: 'Search the record for this literal text (case-insensitive). Returns matches with path/offset/snippet instead of a page.' },
        outline: { type: 'boolean', description: 'Return a structure overview (keys, types, sizes) instead of content.' },
      },
    },
    source: 'builtin',
    permission: 'auto',
    effects: { idempotent: true },
    isConcurrencySafe: true,
    // 分页取回本身就是按需读取（limit 钳制 ≤30k，见 MAX_PAGE_CHARS）— 结果不再转存证据
    //（曾出现"证据的证据"循环归档：12k 的取回页又被归档成新证据）
    maxResultSizeChars: 70_000,

    async invoke(input: any, ctx): Promise<ToolResult> {
      const id = String(input?.evidence_id ?? '').trim();
      if (!id) return toolError('BAD_INPUT', 'evidence_id 必填');
      const offset = Math.max(0, Number(input?.offset) || 0);
      const limit = Math.min(Math.max(Number(input?.limit) || DEFAULT_PAGE_CHARS, 500), MAX_PAGE_CHARS);
      const query = typeof input?.query === 'string' ? input.query.trim() : '';
      const path = typeof input?.path === 'string' ? input.path.trim() : '';

      if (input?.outline === true) {
        const rec = store.load(ctx.runId, id);
        if (!rec) return notFound(store, ctx.runId, id);
        const parsed = parseJson(rec.content);
        return toolOk({
          evidenceId: rec.id,
          tool: rec.tool,
          totalChars: rec.chars,
          format: parsed === undefined ? 'text' : 'json',
          ...(parsed === undefined
            ? { head: rec.content.slice(0, 300), lines: rec.content.split('\n').length }
            : { outline: outline(parsed) }),
        }, `证据 ${rec.id} 结构概览（${rec.tool}，${rec.chars} 字符）`);
      }

      if (query) {
        if (query.length > 200) return toolError('BAD_INPUT', 'query 过长（最多 200 字符）— 请用更短的关键词');
        const rec = store.load(ctx.runId, id);
        if (!rec) return notFound(store, ctx.runId, id);
        return toolOk(searchRecord(rec, query), `证据 ${rec.id} 检索 "${query}"`);
      }

      if (path) {
        const rec = store.load(ctx.runId, id);
        if (!rec) return notFound(store, ctx.runId, id);
        const parsed = parseJson(rec.content);
        if (parsed === undefined) {
          return toolError('EVIDENCE_NOT_JSON', `证据记录 ${rec.id} 不是 JSON（${rec.tool}，纯文本 ${rec.chars} 字符）— 不能按 path 读取；直接用 offset/limit 翻页，或用 query 检索`);
        }
        const found = resolvePath(parsed, path);
        if (found.missing !== undefined) {
          return toolError(
            'EVIDENCE_PATH_NOT_FOUND',
            `证据记录 ${rec.id} 里没有 path="${path}"（在 "${found.missing}" 处走不下去）。顶层字段: ${topKeys(parsed)}`,
          );
        }
        // 字符串字段按原文读（没有 JSON 转义）；其他类型按它的 JSON 文本读
        const isString = typeof found.value === 'string';
        const target = isString ? (found.value as string) : JSON.stringify(found.value);
        return toolOk({
          evidenceId: rec.id,
          tool: rec.tool,
          path,
          kind: isString ? 'string' : 'json',
          totalChars: target.length,
          offset,
          hasMore: offset + limit < target.length,
          content: target.slice(offset, offset + limit),
        });
      }

      const r = store.read(ctx.runId, id, offset, limit);
      if (!r) return notFound(store, ctx.runId, id);
      return toolOk({
        evidenceId: r.record.id,
        tool: r.record.tool,
        totalChars: r.record.chars,
        offset: r.offset,
        hasMore: r.hasMore,
        content: r.page,
      });
    },
  };
}

function notFound(store: EvidenceStore, runId: string, id: string): ToolResult {
  const available = store.list(runId);
  return toolError(
    'EVIDENCE_NOT_FOUND',
    `证据记录 ${id} 不存在（本 run 可用: ${available.map(x => `${x.id}(${x.tool}, ${x.chars}字符)`).join(', ') || '无'}）`
  );
}

function parseJson(s: string): unknown {
  // 纯数字 / true / null 这类也是合法 JSON，但对"按字段读"没有意义 — 只认对象与数组
  try {
    const v = JSON.parse(s);
    return v !== null && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

function topKeys(value: unknown): string {
  if (Array.isArray(value)) return `数组，共 ${value.length} 项（用 path="items[0]" 这样的下标访问）`;
  const o = value as Record<string, unknown>;
  return Object.keys(o).slice(0, 40).map(k => `${k}(${describeType(o[k])})`).join(', ') || '（空对象）';
}

function describeType(v: unknown): string {
  if (typeof v === 'string') return `文本 ${v.length} 字符`;
  if (Array.isArray(v)) return `数组 ${v.length} 项`;
  if (v && typeof v === 'object') return '对象';
  return v === null ? 'null' : typeof v;
}

/** path 语法：a.b[3].c（也接受负下标 [-1]）；找不到时 missing = 走不下去的那一段 */
export function resolvePath(root: unknown, path: string): { value?: unknown; missing?: string } {
  const segments: Array<string | number> = [];
  const re = /[^.[\]]+|\[\s*-?\d+\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    const tok = m[0];
    segments.push(tok.startsWith('[') ? Number(tok.replace(/[[\]\s]/g, '')) : tok);
  }
  if (segments.length === 0) return { missing: path };
  let cur: unknown = root;
  for (const seg of segments) {
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return { missing: `[${seg}]（这里不是数组）` };
      const idx = seg < 0 ? cur.length + seg : seg;
      if (idx < 0 || idx >= cur.length) return { missing: `[${seg}]（数组共 ${cur.length} 项）` };
      cur = cur[idx];
    } else {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return { missing: seg };
      const o = cur as Record<string, unknown>;
      if (!(seg in o)) return { missing: seg };
      cur = o[seg];
    }
  }
  return { value: cur };
}

/** 结构概览：到 3 层为止；字符串只报体量与开头 */
export function outline(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return { type: 'string', chars: value.length, ...(value.length <= 80 ? { value } : { head: value.slice(0, 80) }) };
  }
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length, ...(value.length > 0 && depth < 3 ? { item: outline(value[0], depth + 1) } : {}) };
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o);
    const out: Record<string, unknown> = {};
    for (const k of keys.slice(0, 60)) out[k] = depth < 3 ? outline(o[k], depth + 1) : describeType(o[k]);
    return { type: 'object', ...(keys.length > 60 ? { moreKeys: keys.length - 60 } : {}), keys: out };
  }
  return { type: value === null ? 'null' : typeof value, value };
}

/**
 * 检索：JSON 记录搜"叶子字符串的值"和"键名"，各自带 path 与字段内 offset；
 * 纯文本记录直接在全文里搜。
 */
export function searchRecord(rec: { id: string; tool: string; content: string }, query: string) {
  const needle = query.toLowerCase();
  const parsed = parseJson(rec.content);
  const matches: Array<{ path: string; offset: number; snippet: string; keyMatch?: true }> = [];
  let total = 0;

  const snippetOf = (text: string, at: number) => {
    const from = Math.max(0, at - SNIPPET_CONTEXT);
    const to = Math.min(text.length, at + query.length + SNIPPET_CONTEXT);
    return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
  };
  const scan = (text: string, path: string) => {
    const hay = text.toLowerCase();
    let at = hay.indexOf(needle);
    while (at >= 0) {
      if (total >= MATCH_COUNT_CAP) return;
      total++;
      if (matches.length < MAX_MATCHES) matches.push({ path, offset: at, snippet: snippetOf(text, at) });
      at = hay.indexOf(needle, at + needle.length);
    }
  };

  if (parsed === undefined) {
    scan(rec.content, '');
  } else {
    const walk = (node: unknown, path: string) => {
      if (total >= MATCH_COUNT_CAP) return;
      if (typeof node === 'string') { scan(node, path); return; }
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (total >= MATCH_COUNT_CAP) return;
          const childPath = path ? `${path}.${k}` : k;
          // 键名命中：直接给出这个键下面内容的开头（值本身不再重复扫一遍）
          if (k.toLowerCase().includes(needle)) {
            const text = typeof v === 'string' ? v : (JSON.stringify(v) ?? '');
            total++;
            if (matches.length < MAX_MATCHES) {
              matches.push({ path: childPath, offset: 0, snippet: text.slice(0, SNIPPET_CONTEXT * 2) + (text.length > SNIPPET_CONTEXT * 2 ? '…' : ''), keyMatch: true });
            }
            continue;
          }
          walk(v, childPath);
        }
      }
    };
    walk(parsed, '');
  }

  return {
    evidenceId: rec.id,
    tool: rec.tool,
    query,
    total,
    ...(total > MAX_MATCHES
      ? {
          hasMoreMatches: true,
          note: `只列出了前 ${MAX_MATCHES} 条（共 ${total >= MATCH_COUNT_CAP ? `${MATCH_COUNT_CAP}+` : total} 条）— 换更具体的关键词，或按某条的 path + offset 读上下文`,
        }
      : {}),
    matches,
  };
}
