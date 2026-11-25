/**
 * HTML → 可读文本（零依赖）。
 *
 * 给 http_fetch 用：网页源码里九成是标签、脚本和样式，原样进上下文既贵又难读
 *（实测：已存档网页原始中位 9.9 万字符，提取后约 4 千）。
 *
 * 原则是"召回优先"——只去掉页面上看不见的东西（脚本 / 样式 / 注释 / 模板 / noscript），
 * 可见文字按阅读顺序全部保留；导航类的纯链接列表从正文里折叠掉（链接本身仍进 links，
 * 模型找入口时看 links 即可）。隐藏元素里的文字分两种：短的原样保留（折叠面板里的规格表
 * 往往正是要找的内容），很长的丢弃（站点塞在隐藏节点里的数据 / 模板，不是给人读的）。
 *
 * 一次扫描、不建 DOM：标签与文本逐个走，块级标签处换行，链接 / 图片顺手收集。
 */

export interface PageLink {
  text: string;
  href: string;
  /** 链接上的提示文字（title / aria-label），与可见文字不同时才带 */
  title?: string;
  /** 指向别的站点（或非网页地址） */
  external?: true;
  /** 站点菜单类：在导航容器里（<nav>、页眉页脚、role=navigation 等） */
  nav?: true;
  /**
   * 链接列表里的链接：正文里被折叠掉的"纯链接列表区"（一行一个链接）。可能是目录 / 列表页的条目，
   * 也可能是没用语义标签的菜单 — 两者的可靠程度不同，所以和 nav 分开标
   */
  list?: true;
}

export interface PageImage {
  src: string;
  alt: string;
}

export interface ExtractedPage {
  /** <title>，没有则取第一个 <h1>，再没有取 og:title */
  title: string;
  /** 可读文本（导航链接区已折叠），段落间空一行 */
  text: string;
  /** 链接：绝对地址、文档顺序、去重 */
  links: PageLink[];
  /** 页面上的链接多过收录上限（links 只收了前面的；默认上限见 ExtractOptions.maxLinks） */
  linksTruncated?: true;
  images: PageImage[];
  /** <meta name=… / property=… / itemprop=…> → content */
  meta: Record<string, string>;
  /** JSON-LD 结构化数据原文（最多 3 段，各截断） */
  structuredData: string[];
  /** 从正文里折叠掉的导航链接区个数 */
  foldedRegions: number;
  /** 因过长而丢弃的隐藏内容字符数 */
  hiddenDroppedChars: number;
}

export interface ExtractOptions {
  /** 最多收集多少条链接（默认 600 — 目录页、列表页的链接常常过百） */
  maxLinks?: number;
  /** 最多收集多少张图片（默认 30） */
  maxImages?: number;
  /** 隐藏内容超过这个长度就丢弃（默认 3000） */
  maxHiddenChars?: number;
}

/** 块级容器：开始与结束处换行（内容另起一行） */
const LINE_TAGS = new Set([
  'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'center', 'summary', 'figcaption',
  'thead', 'tbody', 'tfoot', 'fieldset', 'option', 'tr',
]);
/** 段落级容器：开始与结束处空一行 */
const PARA_TAGS = new Set([
  'p', 'ul', 'ol', 'table', 'blockquote', 'figure', 'dl', 'dt', 'dd', 'caption', 'form', 'details', 'address', 'select',
]);
/** 内容整体不可见的元素：连同内容一起丢弃（都是成对标签——空元素不能放进来，否则会被当成"没闭合"） */
const INVISIBLE_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'canvas', 'textarea', 'video', 'audio'];
/** 导航类容器：正文不收文字，但链接照收 */
const NAV_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'menu', 'menubar', 'tablist']);
/** 折叠判定里视为"装饰"的字符（列表符号 / 分隔符）。竖线不算：表格行里的竖线是单元格边界，表格行不能被当成导航 */
const DECOR = /[\s\-•·,;:›»>~*]/;
/** 整行只有空白 / 列表符号 */
const DECOR_ONLY = /^[\s\-|•·,;:›»>~*]*$/;
/** 无信息量的图片 alt */
const JUNK_ALT = /^(image|img|photo|picture|logo|icon|spacer|bullet|banner|thumb|thumbnail|avatar)?$/i;
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden/i;
const LINE_BREAK = '\n';
const PARA_BREAK = '\n\n';

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const HEAD_TAG = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i;
const HEADING = /^h[1-6]$/;

/** 空白折叠：HTML 把连续空白（含源码换行）显示为一个空格 */
const WS = /[\s\u00a0\u2007\u202f]+/g;
/** 控制字符（保留换行与制表） */
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * 是否按 HTML 处理：Content-Type 说是，或者正文以完整的 HTML 文档头开头。
 * 接口返回的 text/plain 里夹几个标签不算——那种原样返回。
 */
export function looksLikeHtml(contentType: string, body: string): boolean {
  if (/text\/html|application\/xhtml\+xml/i.test(contentType)) return true;
  return /^\s*(<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(body.slice(0, 500));
}

export function extractHtml(html: string, baseUrl: string, options: ExtractOptions = {}): ExtractedPage {
  // ── <head>：标题 / meta / <base> ──（取完整体丢弃——里面没有可见文字）
  const headMatch = HEAD_TAG.exec(html);
  const head = headMatch ? headMatch[1] : html.slice(0, 200_000);
  const base = resolveUrl(firstAttr(openTagAttrs(head, 'base'), 'href'), baseUrl) || baseUrl;

  const source = headMatch ? html.slice(0, headMatch.index) + ' ' + html.slice(headMatch.index + headMatch[0].length) : html;
  const scan = scanBody(stripInvisible(source), base, options);
  const meta = collectMeta(head);

  const title =
    cleanInline(decodeEntities(firstInner(head, 'title').replace(CTRL, ''))).slice(0, 300) ||
    scan.firstHeading ||
    meta['og:title'] ||
    meta['twitter:title'] ||
    '';
  // 先折叠再收尾：折叠靠链接在原始文本里的位置，收尾会挪动偏移
  const folded = foldNavRegions(scan.text, scan.linkSpans, scan.tableLines);
  // 被折叠掉的链接区里的链接标成"链接列表"类（list）：它们的文字已经不在正文里，只在 links 里出现
  for (const idx of folded.navLinks) {
    const l = scan.links[idx];
    if (l && !l.nav) l.list = true;
  }

  return {
    title,
    text: finalizeText(folded.text),
    links: scan.links,
    ...(scan.linksTruncated ? { linksTruncated: true as const } : {}),
    images: scan.images,
    meta,
    structuredData: collectJsonLd(html),
    foldedRegions: folded.folded,
    hiddenDroppedChars: scan.hiddenDroppedChars,
  };
}

// ─────────────────────────── 扫描 ───────────────────────────

interface LinkSpan {
  start: number;
  end: number;
}

/** "扫描到闭合标签才知道多长"的区域（导航容器 / 隐藏节点）：按标签名 + 开始时该标签的打开层数认领自己的闭合标签 */
interface ScopedRegion {
  tag: string;
  depth: number;
}

interface ScanResult {
  text: string;
  links: PageLink[];
  images: PageImage[];
  linkSpans: LinkSpan[];
  firstHeading: string;
  hiddenDroppedChars: number;
  tableLines: Set<number>;
  linksTruncated: boolean;
}

interface TableCell {
  parts: string[];
  colspan: number;
  rowspan: number;
  th: boolean;
}
interface TableRow {
  cells: TableCell[];
  inTHead: boolean;
}
interface TableFrame {
  rows: TableRow[];
  row: TableRow | null;
  cell: TableCell | null;
  /** 被上方跨行单元格占住的列：列号 → 填充值与最后一行的行号 */
  pending: Map<number, { value: string; until: number }>;
  truncated: boolean;
  caption: string;
  captionParts: string[] | null;
}
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_CELLS = 60;
const MAX_CELL_CHARS = 2000;
const clampAttr = (raw: string, min: number, max: number) => Math.min(Math.max(parseInt(raw, 10) || min, min), max);

function scanBody(html: string, base: string, options: ExtractOptions): ScanResult {
  const maxLinks = options.maxLinks ?? 600;
  const maxImages = options.maxImages ?? 30;
  const maxHiddenChars = options.maxHiddenChars ?? 3000;

  const chunks: string[] = [];
  let len = 0;
  const lastChunk = () => chunks[chunks.length - 1] ?? '';
  const atLineStart = () => chunks.length === 0 || lastChunk().endsWith('\n');
  /** 导航容器里的内容不进正文（链接照收） */
  let navDepth = 0;
  const roleSkips: ScopedRegion[] = [];
  const openCount = new Map<string, number>();
  /** 隐藏节点：内容先进旁路缓冲，闭合时短的并入正文、长的丢弃 */
  let hiddenDepth = 0;
  const hiddenRegions: ScopedRegion[] = [];
  let hiddenBuf: string[] = [];
  let hiddenDroppedChars = 0;
  let preDepth = 0;

  const inNav = () => navDepth > 0 || roleSkips.length > 0;
  let lineNo = 0;
  /** 表格行在正文里的行号（从 0 起） */
  const tableLines = new Set<number>();
  /**
   * 最外层表格：内容先进结构（行 / 格 / 跨行跨列），</table> 时整体渲染成带表头的行。
   * 实测抓到的大网页里 1/4 带表格——"每格是什么、哪行是表头、合并单元格盖住了哪些格"
   * 直接决定模型能不能读对数；边扫边输出 "甲 | 乙" 的老做法这三样都表达不了。
   */
  let table: TableFrame | null = null;
  /** 外层表格里再嵌套的表格：内容并进所在单元格（格间 | 、行间 ;） */
  let nestedTable = 0;
  /** 内层表格当前行还没有出过格（行首不补格间分隔符） */
  let innerRowStart = true;
  let theadDepth = 0;

  const push = (s: string) => {
    chunks.push(s);
    len += s.length;
    for (let k = 0; k < s.length; k++) if (s.charCodeAt(k) === 10) lineNo++;
  };
  const emit = (s: string) => {
    // 导航容器与隐藏节点里的换行 / 分隔符同样不进正文（隐藏内容闭合时整段另行决定去留）；
    // 表格里的文字进结构缓冲，</table> 时整体渲染
    if (!s || inNav() || hiddenDepth > 0 || table) return;
    push(s);
  };

  const links: PageLink[] = [];
  const linkSpans: LinkSpan[] = [];
  const images: PageImage[] = [];
  const seenLinks = new Set<string>();
  /** 还有链接没收录（到了条数上限） */
  let linksTruncated = false;

  let link: { href: string; parts: string[]; start: number; title: string; nav: boolean } | null = null;
  let firstH1: string[] | null = null;
  let firstHeading = '';

  const closeLink = () => {
    if (!link) return;
    const text = cleanInline(link.parts.join(''));
    const key = `\u0000${link.href}\u0000${text}`;
    if (!seenLinks.has(key)) {
      seenLinks.add(key);
      if (links.length < maxLinks) {
        links.push({
          text: text || describeHref(link.href),
          href: link.href,
          ...(link.title && link.title !== text ? { title: link.title } : {}),
          ...(isExternalHref(link.href, base) ? { external: true as const } : {}),
          ...(link.nav ? { nav: true as const } : {}),
        });
        linkSpans.push({ start: link.start, end: len });
      } else {
        linksTruncated = true;
      }
    }
    link = null;
  };

  const trailingNewlines = (): number => {
    let n = 0;
    for (let c = chunks.length - 1; c >= 0 && n < 2; c--) {
      for (let k = chunks[c].length - 1; k >= 0 && n < 2; k--) {
        const ch = chunks[c][k];
        if (ch === '\n') n++;
        else if (ch !== ' ') return n;
      }
    }
    return n;
  };
  const lineBreak = () => {
    if (hiddenDepth > 0) { hiddenBuf.push(' '); return; }
    if (table) { if (table.cell) table.cell.parts.push(' '); return; }
    if (!atLineStart()) emit(LINE_BREAK);
  };
  const paraBreak = () => {
    if (hiddenDepth > 0) { hiddenBuf.push(' '); return; }
    if (table) return;
    const nl = trailingNewlines();
    if (nl === 0) emit(PARA_BREAK);
    else if (nl === 1) emit(LINE_BREAK);
  };
  /** 表格之外出现的单元格（写坏的 HTML）：记下这一行是表格行（折叠导航时不能动它），必要时补分隔符 */
  const cellBoundary = () => {
    tableLines.add(lineNo);
    if (!atLineStart() && !lastChunk().endsWith('| ')) emit(' | ');
  };

  const text = (raw: string) => {
    const s = decodeEntities(raw).replace(CTRL, '');
    if (link) link.parts.push(s);
    if (firstH1) firstH1.push(s);
    if (hiddenDepth > 0) { hiddenBuf.push(s); return; }
    if (inNav()) return;
    if (table) {
      const flat = s.replace(WS, ' ');
      if (table.cell) table.cell.parts.push(flat);
      else if (table.captionParts) table.captionParts.push(flat);
      return;
    }
    if (preDepth > 0) { emit(s); return; }
    const flat = s.replace(WS, ' ');
    if (!flat) return;
    emit(atLineStart() || lastChunk().endsWith(' ') ? flat.replace(/^ /, '') : flat);
  };

  // ── 表格结构 ──
  const finishCell = () => {
    if (table?.cell) {
      if (!table.row) table.row = { cells: [], inTHead: false };
      table.row.cells.push(table.cell);
      table.cell = null;
    }
  };
  const finishRow = () => {
    finishCell();
    if (table?.row) {
      if (table.rows.length < MAX_TABLE_ROWS) table.rows.push(table.row);
      else table.truncated = true;
      table.row = null;
    }
  };
  const cellHasText = () => Boolean(table?.cell && table.cell.parts.join('').trim());
  /** 把表格渲染成带表头的行；跨行 / 跨列的值填进它盖住的格（合并单元格的含义是"这些格都是它"） */
  const renderTable = (f: TableFrame) => {
    const grid: string[][] = [];
    const header: boolean[] = [];
    f.rows.forEach((row, r) => {
      for (const [c, p] of f.pending) if (p.until < r) f.pending.delete(c);
      const out: string[] = [];
      let col = 0;
      for (const cell of row.cells) {
        for (;;) {
          const p = f.pending.get(col);
          if (!p) break;
          out.push(p.value);
          if (p.until <= r) f.pending.delete(col);
          col++;
        }
        const value = cleanInline(cell.parts.join('')).slice(0, MAX_CELL_CHARS);
        for (let k = 0; k < cell.colspan && out.length < MAX_TABLE_CELLS; k++) {
          out.push(value);
          if (cell.rowspan > 1) f.pending.set(col, { value, until: r + cell.rowspan - 1 });
          col++;
        }
      }
      grid.push(out);
      header.push(row.cells.length > 0 && (row.inTHead || row.cells.every(c => c.th)));
    });
    const cols = grid.reduce((m, g) => Math.max(m, g.length), 0);
    const firstLine = lineNo;
    if (f.caption) push(`表：${f.caption}\n`);
    if (grid.length === 1 && cols <= 1) {
      push(`${grid[0][0] ?? ''}\n`);
    } else {
      const out: string[] = [];
      grid.forEach((g, i) => {
        out.push(`| ${g.join(' | ')} |`);
        // 开头连续的表头行结束后加分隔线（只有首列是行标题的键值表不算表头）
        if (header[i] && !header[i + 1] && header.slice(0, i + 1).every(Boolean)) out.push(`|${Array(cols).fill('---').join('|')}|`);
      });
      if (f.truncated) out.push(`| …表格超过 ${MAX_TABLE_ROWS} 行，已截断 |`);
      push(out.join('\n') + '\n');
    }
    for (let k = firstLine; k < lineNo; k++) tableLines.add(k);
  };

  const isBlockEdge = (name: string) =>
    LINE_TAGS.has(name) || PARA_TAGS.has(name) || name === 'li' || name === 'td' || name === 'th' || HEADING.test(name);

  /** 区域容器的收口：标签后面找不到对应的闭合标签（文档被截断 / 写漏了）就不进该状态，否则后半页全被吞掉 */
  const closesLater = (name: string, from: number) => html.indexOf(`</${name}`, from) >= 0;

  const onStart = (name: string, attrText: string, selfClosing: boolean, tagEndPos: number) => {
    const attr = (key: string) => firstAttr(attrText, key);

    if (name === 'a') {
      closeLink();
      const href = resolveUrl(attr('href'), base);
      const tip = cleanInline(decodeEntities(attr('title') || attr('aria-label'))).slice(0, 120);
      if (href) link = { href, parts: [], start: len, title: tip, nav: inNav() };
      return;
    }
    if (name === 'img' || name === 'area') {
      const src = resolveUrl(attr(name === 'img' ? 'src' : 'href'), base);
      if (!src) return;
      const alt = cleanInline(decodeEntities(attr('alt')));
      if (link) { if (alt && !JUNK_ALT.test(alt)) link.parts.push(alt); return; }
      if (name === 'area') {
        const key = `\u0000${src}\u0000${alt || describeHref(src)}`;
        if (!seenLinks.has(key)) {
          seenLinks.add(key);
          if (links.length < maxLinks) links.push({ text: alt || describeHref(src), href: src });
          else linksTruncated = true;
        }
        return;
      }
      if (images.length < maxImages) images.push({ src, alt });
      if (alt.length >= 3 && !JUNK_ALT.test(alt) && !/\.(png|jpe?g|gif|svg|webp|bmp|ico)\s*$/i.test(alt)) text(` [图: ${alt}] `);
      return;
    }
    if (VOID_TAGS.has(name) || selfClosing) {
      if (name === 'br') lineBreak();
      else if (name === 'hr') { paraBreak(); emit('---'); paraBreak(); }
      return;
    }

    const depth = (openCount.get(name) ?? 0) + 1;
    openCount.set(name, depth);

    // 链接没闭合就遇到了块边界（HTML 允许 <a> 包住块级元素，也常见漏写 </a>）：就此收口
    if (link && isBlockEdge(name)) closeLink();

    if (name === 'nav') {
      if (closesLater(name, tagEndPos)) { navDepth++; lineBreak(); }
      return;
    }
    if (NAV_ROLES.has(attr('role').toLowerCase())) {
      if (closesLater(name, tagEndPos)) { roleSkips.push({ tag: name, depth }); lineBreak(); }
      return;
    }
    if (hiddenDepth === 0 && (/\shidden(?:\s|=|$)/i.test(attrText) || HIDDEN_STYLE.test(attr('style')))) {
      if (closesLater(name, tagEndPos)) {
        hiddenDepth = 1;
        hiddenRegions.push({ tag: name, depth });
        hiddenBuf = [];
        closeLink();
        lineBreak();
        return;
      }
    }

    if (name === 'table') {
      if (table) { nestedTable++; innerRowStart = true; }
      else {
        paraBreak();
        table = { rows: [], row: null, cell: null, pending: new Map(), truncated: false, caption: '', captionParts: null };
      }
      return;
    }
    if (name === 'caption') {
      if (table && nestedTable === 0 && !table.cell) table.captionParts = [];
      return;
    }
    if (name === 'thead') {
      if (table && nestedTable === 0) theadDepth++;
      return;
    }
    if (name === 'tr') {
      if (table) {
        // 嵌套表的行不能收口外层的格与行——它的内容要并进外层单元格
        if (nestedTable === 0) {
          finishRow();
          table.row = { cells: [], inTHead: theadDepth > 0 };
        } else if (cellHasText()) { table.cell!.parts.push(' ; '); innerRowStart = true; }
        return;
      }
      lineBreak();
      return;
    }
    if (name === 'td' || name === 'th') {
      if (table) {
        if (nestedTable > 0) {
          if (!innerRowStart && cellHasText()) table.cell!.parts.push(' | ');
          innerRowStart = false;
          return;
        }
        finishCell();
        table.cell = {
          parts: [],
          colspan: clampAttr(attr('colspan'), 1, 50),
          rowspan: clampAttr(attr('rowspan'), 1, 500),
          th: name === 'th',
        };
        return;
      }
      cellBoundary();
      return;
    }

    if (HEADING.test(name)) {
      paraBreak();
      emit(`${'#'.repeat(Number(name[1]))} `);
      if (name === 'h1' && !firstH1 && !firstHeading) firstH1 = [];
      return;
    }
    if (name === 'li') {
      if (table) { if (table.cell) table.cell.parts.push(' • '); return; }
      lineBreak();
      emit('- ');
      return;
    }
    if (name === 'pre') { paraBreak(); preDepth++; return; }
    if (PARA_TAGS.has(name)) { paraBreak(); return; }
    if (LINE_TAGS.has(name)) lineBreak();
    // 其余（b / i / span / 自定义元素…）按行内处理：不换行，文字与前后自然衔接
  };

  const onEnd = (name: string) => {
    if (name === 'a') { closeLink(); return; }
    if (name === 'nav') { navDepth = Math.max(0, navDepth - 1); lineBreak(); return; }
    if (name === 'table') {
      if (table) {
        if (nestedTable > 0) nestedTable--;
        else {
          finishRow();
          renderTable(table);
          table = null;
          paraBreak();
        }
      }
      return;
    }
    if (name === 'caption') {
      if (table?.captionParts) {
        table.caption = cleanInline(table.captionParts.join('')).slice(0, 200);
        table.captionParts = null;
      }
      return;
    }
    if (name === 'thead') {
      if (table && nestedTable === 0 && theadDepth > 0) theadDepth--;
      return;
    }
    const after = Math.max(0, (openCount.get(name) ?? 1) - 1);
    openCount.set(name, after);
    const owns = (r: ScopedRegion) => r.tag === name && r.depth === after + 1;

    const role = roleSkips.length - 1;
    if (role >= 0 && owns(roleSkips[role])) {
      roleSkips.splice(role, 1);
      lineBreak();
      return;
    }
    const hidden = hiddenRegions.length - 1;
    if (hidden >= 0 && owns(hiddenRegions[hidden])) {
      hiddenRegions.splice(hidden, 1);
      hiddenDepth = hiddenRegions.length;
      const content = cleanInline(hiddenBuf.join(''));
      hiddenBuf = [];
      if (content.length > 0 && content.length <= maxHiddenChars) { paraBreak(); emit(content); paraBreak(); }
      else if (content.length > maxHiddenChars) hiddenDroppedChars += content.length;
      return;
    }
    if (link && isBlockEdge(name)) closeLink();
    if (HEADING.test(name)) {
      if (firstH1) { firstHeading = cleanInline(firstH1.join('')); firstH1 = null; }
      paraBreak();
      return;
    }
    if (name === 'li') { lineBreak(); return; }
    if (name === 'tr') {
      if (table) { if (nestedTable === 0) finishRow(); return; }
      lineBreak();
      return;
    }
    if (name === 'td' || name === 'th') {
      if (table) { if (nestedTable === 0) finishCell(); return; }
      cellBoundary();
      return;
    }
    if (name === 'pre') { preDepth = Math.max(0, preDepth - 1); paraBreak(); return; }
    if (PARA_TAGS.has(name)) { paraBreak(); return; }
    if (LINE_TAGS.has(name)) lineBreak();
  };

  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { text(html.slice(i)); break; }
    if (lt > i) text(html.slice(i, lt));
    const c = html[lt + 1];
    if (c === '!') {
      if (html.startsWith('<!--', lt)) {
        const close = html.indexOf('-->', lt + 4);
        i = close < 0 ? n : close + 3;
      } else {
        const close = html.indexOf('>', lt);
        i = close < 0 ? n : close + 1;
      }
      continue;
    }
    if (c === '?') {
      const close = html.indexOf('>', lt);
      i = close < 0 ? n : close + 1;
      continue;
    }
    if (c === '/') {
      const m = /^<\/\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 48));
      if (!m) { text('<'); i = lt + 1; continue; }
      onEnd(m[1].toLowerCase());
      i = tagEnd(html, lt);
      continue;
    }
    if (!isLetter(c)) { text('<'); i = lt + 1; continue; }
    const end = tagEnd(html, lt);
    let inner = html.slice(lt + 1, Math.max(lt + 1, end - 1));
    let selfClosing = false;
    if (inner.endsWith('/')) { selfClosing = true; inner = inner.slice(0, -1); }
    const nm = /^([a-zA-Z][a-zA-Z0-9:-]*)([\s\S]*)$/.exec(inner);
    if (nm) onStart(nm[1].toLowerCase(), nm[2], selfClosing, end);
    i = end;
  }
  closeLink();
  // 文档在表格中间被截断（没等到 </table>）：已经读到的行照常输出
  if (table) {
    finishRow();
    renderTable(table);
  }
  return { text: chunks.join(''), links, images, linkSpans, firstHeading, hiddenDroppedChars, tableLines, linksTruncated };
}

const isLetter = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

/** 标签结束位置（'>' 之后）；属性值里的 '>' 不算 */
function tagEnd(html: string, lt: number): number {
  let quote: string | null = null;
  for (let k = lt + 1; k < html.length; k++) {
    const ch = html[k];
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return k + 1;
  }
  return html.length;
}

function firstAttr(attrText: string, key: string): string {
  const m = new RegExp(`(^|[\\s/])${key}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s"'>]+)`, 'i').exec(attrText);
  return m ? m[2].replace(/^["']|["']$/g, '') : '';
}

/** 第一个指定起始标签的属性文本；没有则返回空串 */
function openTagAttrs(html: string, name: string): string {
  const m = new RegExp(`<${name}\\b([^>]*)>`, 'i').exec(html);
  return m ? m[1] : '';
}

/** 第一个指定成对标签的内容；没有则返回空串 */
function firstInner(html: string, name: string): string {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'i').exec(html);
  return m ? m[1] : '';
}

function cleanInline(s: string): string {
  return s.replace(WS, ' ').trim();
}

/** 收尾：去掉行尾空白与首尾空行，连续空行压成一个；只剩列表符号的行按空行处理（<pre> 内部不动）。
 *  表格的表头分隔线（|---|---|）也只由符号组成，但它是表格结构的一部分，不能当空行删掉 */
function finalizeText(text: string): string {
  const out: string[] = [];
  let pendingBlank = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[ \t]+$/, '');
    if (line.trim() === '' || (DECOR_ONLY.test(line) && !TABLE_SEPARATOR.test(line))) {
      pendingBlank = out.length > 0;
      continue;
    }
    if (pendingBlank) out.push('');
    pendingBlank = false;
    out.push(line);
  }
  return out.join('\n');
}
const TABLE_SEPARATOR = /^\|(-+\|)+$/;

/** 链接没有可见文字时用地址里最有信息量的一段代替（图片链接 / 空锚点） */
function describeHref(href: string): string {
  try {
    const u = new URL(href);
    const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    try { return decodeURIComponent(last).slice(0, 80); } catch { return last.slice(0, 80); }
  } catch {
    return href.slice(0, 80);
  }
}

/** 相对地址 → 绝对地址；页内锚点 / javascript: / data: 不收 */
function resolveUrl(href: string | undefined, base: string): string {
  if (!href) return '';
  const h = href.trim();
  if (!h || h.startsWith('#') || /^(javascript|data):/i.test(h)) return '';
  try {
    return new URL(decodeEntities(h), base).toString();
  } catch {
    return '';
  }
}

/** 链接是否指向别的站点：网页地址比主机名，其余协议（mailto: / tel: …）一律算外站 */
function isExternalHref(href: string, base: string): boolean {
  try {
    return new URL(href).host !== new URL(base).host;
  } catch {
    return true;
  }
}

// ─────────────────────── 不可见内容 / head ───────────────────────

/** 丢弃不可见元素；标签没闭合（文档被截断）时从那里截掉——后面只可能是它的内容 */
function stripInvisible(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of INVISIBLE_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
    const open = new RegExp(`<${tag}\\b[^>]*>`, 'i').exec(out);
    if (open && !new RegExp(`<\\/${tag}\\s*>`, 'i').test(out.slice(open.index))) {
      out = out.slice(0, open.index);
    }
  }
  return out;
}

const SKIP_META = new Set(['charset', 'viewport', 'generator', 'http-equiv', 'format-detection', 'robots']);

function collectMeta(head: string): Record<string, string> {
  const meta: Record<string, string> = {};
  let count = 0;
  const re = /<meta\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(head)) && count < 40) {
    const content = firstAttr(m[1], 'content');
    if (!content) continue;
    const key = firstAttr(m[1], 'property') || firstAttr(m[1], 'name') || firstAttr(m[1], 'itemprop');
    const k = key.toLowerCase();
    if (!k || SKIP_META.has(k) || meta[k] !== undefined) continue;
    meta[k] = cleanInline(decodeEntities(content)).slice(0, 400);
    count++;
  }
  return meta;
}

function collectJsonLd(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 3) {
    const body = m[1].trim();
    if (body) out.push(body.slice(0, 4000));
  }
  return out;
}

// ─────────────────────── 导航链接区折叠 ───────────────────────

/**
 * 正文里的"纯链接列表"（导航菜单、页脚链接堆、标签云）折叠掉：
 *  · 纵向：连续 ≥6 行、每行除了链接文字就只有列表符号 / 分隔符
 *  · 横向：一行里 ≥8 个链接、行首就是链接、链接以外的字符不到三成
 * 判定以整行为单位，而不是以"连续链接段"为单位——
 * "乐队成员是 甲、乙、丙、丁。"这种一句话里带多个链接是正文，不能折。
 */
export function foldNavRegions(
  text: string,
  spans: LinkSpan[],
  protectedLines: Set<number> = new Set(),
): { text: string; folded: number; navLinks: Set<number> } {
  if (!spans.length || !text) return { text, folded: 0, navLinks: new Set() };
  const sorted = spans.map((s, i) => ({ start: s.start, end: s.end, i })).sort((a, b) => a.start - b.start);
  const lines = text.split('\n');
  const remove = new Set<number>();
  /** 每一行里的链接（在 spans 里的序号） */
  const lineLinks: number[][] = [];

  let offset = 0;
  const lineInfo = lines.map((line, idx) => {
    const ls = offset;
    offset += line.length + 1;
    let a = 0;
    let b = line.length;
    while (a < b && line[a] === ' ') a++;
    while (b > a && line[b - 1] === ' ') b--;
    if (b === a) { lineLinks.push([]); return { links: 0, linkOnly: false, dense: false }; }
    const inLine = sorted
      .filter(s => s.end > ls + a && s.start < ls + b)
      .map(s => ({ start: s.start - ls, end: s.end - ls, i: s.i }));
    lineLinks.push(inLine.map(s => s.i));
    let outside = 0;
    let linked = 0;
    for (let k = a; k < b; k++) {
      if (inLine.some(s => k >= s.start && k < s.end)) { linked++; continue; }
      if (!DECOR.test(line[k])) outside++;
    }
    // 表格行是数据：即使长得像链接列表也不折
    if (protectedLines.has(idx)) return { links: inLine.length, linkOnly: false, dense: false };
    return {
      links: inLine.length,
      linkOnly: inLine.length > 0 && outside === 0,
      // 横向密集：行首就是链接，且链接以外的实义字符不到三成（"甲 | 乙 | 丙"的分隔符不算实义）
      dense: inLine.length >= 8 && inLine[0].start <= a && outside <= (linked + outside) * 0.3,
    };
  });

  // 纵向：连续的"纯链接行"（中间夹的空行不打断）
  let folded = 0;
  let runStart = -1;
  let runEnd = -1;
  let runCount = 0;
  let runLinks = 0;
  const flush = () => {
    if (runStart >= 0 && runCount >= 6 && runLinks >= 6) {
      for (let k = runStart; k <= runEnd; k++) remove.add(k);
      folded++;
    }
    runStart = -1;
    runEnd = -1;
    runCount = 0;
    runLinks = 0;
  };
  lineInfo.forEach((x, idx) => {
    // 空行与"只剩列表符号"的行（嵌套列表里没有自己文字的父级项）不打断连续段
    if (DECOR_ONLY.test(lines[idx])) { if (runStart >= 0) runEnd = idx; return; }
    if (x.linkOnly) {
      if (runStart < 0) runStart = idx;
      runEnd = idx;
      runCount++;
      runLinks += x.links;
    } else {
      flush();
    }
  });
  flush();
  // 横向：单行密集链接
  lineInfo.forEach((x, idx) => {
    if (x.dense && !remove.has(idx)) { remove.add(idx); folded++; }
  });

  if (remove.size === 0) return { text, folded: 0, navLinks: new Set() };
  const navLinks = new Set<number>();
  for (const idx of remove) for (const i of lineLinks[idx] ?? []) navLinks.add(i);
  return { text: lines.filter((_, idx) => !remove.has(idx)).join('\n'), folded, navLinks };
}

// ─────────────────────── 长页面：目录与相关片段 ───────────────────────

export interface SectionRef {
  level: number;
  title: string;
  /** 标题文字在正文里的起始偏移 */
  offset: number;
}

/** 正文里的标题目录（标题行形如 "## 标题"）：标题、层级、在正文里的起始偏移 */
export function listSections(text: string): SectionRef[] {
  const out: SectionRef[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const m = /^(#{1,6}) (.+)$/.exec(line);
    if (m && out.length < 80) out.push({ level: m[1].length, title: m[2].trim(), offset: offset + m[1].length + 1 });
    offset += line.length + 1;
  }
  return out;
}

export interface Excerpt {
  /** 片段在正文里的起始偏移（evidence_read 按它续读） */
  offset: number;
  text: string;
  score: number;
}

export interface ExcerptOptions {
  /** 片段总字符预算 */
  budget?: number;
  /** 最多几段 */
  maxBlocks?: number;
  /** 起始偏移小于它的段落不算（开头已经内联的部分不重复给） */
  excludeUntil?: number;
  /** 单段最长 */
  maxBlockChars?: number;
}

/** 关注点里不参与计分的词（太常见，命中了也说明不了相关） */
const STOP_TERMS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'to', 'with', 'is', 'are', 'was', 'were', 'by', 'at', 'from', 'as', 'that', 'this',
  'these', 'those', 'what', 'which', 'who', 'when', 'where', 'how', 'many', 'much', 'about', 'into', 'than', 'then', 'there', 'their', 'its', 'it',
  'be', 'been', 'has', 'have', 'had', 'not', 'no', 'on', 'do', 'does', 'did',
  '的', '了', '是', '在', '和', '与', '或', '及', '对', '从', '到', '有', '个', '中', '里', '吗', '呢', '着', '地', '得', '把', '被', '给', '让',
  '关于', '以及', '什么', '哪些', '怎么', '多少', '一个', '这个', '那个', '哪些',
]);

/** 把关注点拆成可计数的词：西文按词，中文等按相邻两字；返回 词 → 权重 */
export function extractTerms(focus: string): Map<string, number> {
  const terms = new Map<string, number>();
  const add = (t: string, w: number) => terms.set(t, Math.max(terms.get(t) ?? 0, w));
  for (const raw of focus.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    for (const w of raw.match(/[\p{Script=Latin}\p{N}]+/gu) ?? []) {
      if (w.length < 2 || STOP_TERMS.has(w)) continue;
      add(w, /\d/.test(w) || w.length >= 5 ? 2 : 1);
    }
    for (const run of raw.match(/[^\p{Script=Latin}\p{N}]+/gu) ?? []) {
      for (let i = 0; i + 1 < run.length; i++) {
        const bigram = run.slice(i, i + 2);
        if (!STOP_TERMS.has(bigram)) add(bigram, 1);
      }
    }
  }
  return terms;
}

/**
 * 按关注点挑出正文里最相关的几段（带偏移，按原文顺序返回）。
 * 长页面只内联开头时，答案常在后面的某一节——这里把"带着问题找段落"做成确定性的：
 * 段落按空行切分，标题跟它的正文算一段，按关注点里的词命中次数计分，取分数最高的几段。
 * 不改写、不概括：片段是原文，全文仍在证据记录里，模型可以按偏移续读。
 */
export function pickExcerpts(text: string, focus: string, options: ExcerptOptions = {}): Excerpt[] {
  const terms = extractTerms(focus);
  if (!text || terms.size === 0) return [];
  const budget = options.budget ?? 4000;
  const maxBlocks = options.maxBlocks ?? 6;
  const excludeUntil = options.excludeUntil ?? 0;
  const maxBlockChars = options.maxBlockChars ?? 1200;

  const candidates: Excerpt[] = [];
  let pendingHeading: { offset: number } | null = null;
  const parts = text.split(/(\n{2,})/);
  let offset = 0;
  for (const part of parts) {
    if (/^\n{2,}$/.test(part)) { offset += part.length; continue; }
    const start = offset;
    offset += part.length;
    const trimmed = part.trim();
    if (!trimmed) continue;
    const bodyEnd = start + part.trimEnd().length;
    // 只有标题的一块：挂到下一段上（连同中间的空行按原文切片——片段必须是原文里连续的一段）
    if (!trimmed.includes('\n') && /^#{1,6} /.test(trimmed)) {
      pendingHeading = { offset: start + (part.length - part.trimStart().length) };
      continue;
    }
    const blockOffset = pendingHeading ? pendingHeading.offset : start + (part.length - part.trimStart().length);
    let from = blockOffset;
    if (from < excludeUntil) {
      // 块的开头已经在内联部分里：整块都在就跳过；跨在截断点上（标题在前、内容在后）只取截断点之后的尾巴
      if (bodyEnd <= excludeUntil) continue;
      from = excludeUntil + (text.slice(excludeUntil, bodyEnd).length - text.slice(excludeUntil, bodyEnd).trimStart().length);
    }
    const blockText = text.slice(from, bodyEnd);
    pendingHeading = null;
    if (blockText.length < 20) continue;
    const hay = blockText.toLowerCase();
    let score = 0;
    for (const [term, weight] of terms) {
      const count = hay.split(term).length - 1;
      if (count > 0) score += weight * Math.min(3, count);
    }
    if (score > 0) candidates.push({ offset: from, text: blockText.slice(0, maxBlockChars), score });
  }

  const ranked = [...candidates].sort((a, b) => b.score - a.score || a.offset - b.offset);
  const chosen: Excerpt[] = [];
  let used = 0;
  for (const c of ranked) {
    if (chosen.length >= maxBlocks) break;
    if (used + c.text.length > budget && chosen.length > 0) continue;
    const textKept = c.text.slice(0, Math.max(0, budget - used));
    if (!textKept) break;
    chosen.push({ ...c, text: textKept });
    used += textKept.length;
  }
  return chosen.sort((a, b) => a.offset - b.offset);
}

// ─────────────────────── 实体解码 ───────────────────────

const NAMED_ENTITIES: Record<string, string> = buildEntities();

function buildEntities(): Record<string, string> {
  const map: Record<string, string> = {
    quot: '"', amp: '&', lt: '<', gt: '>', apos: "'",
    nbsp: ' ', iexcl: '¡', cent: '¢', pound: '£', curren: '¤', yen: '¥', brvbar: '¦', sect: '§', uml: '¨', copy: '©',
    ordf: 'ª', laquo: '«', not: '¬', shy: '­', reg: '®', macr: '¯', deg: '°', plusmn: '±', sup2: '²', sup3: '³',
    acute: '´', micro: 'µ', para: '¶', middot: '·', cedil: '¸', sup1: '¹', ordm: 'º', raquo: '»', frac14: '¼', frac12: '½',
    frac34: '¾', iquest: '¿', times: '×', divide: '÷', fnof: 'ƒ', circ: 'ˆ', tilde: '˜', ensp: ' ', emsp: ' ', thinsp: ' ',
    zwnj: '', zwj: '', lrm: '', rlm: '', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”',
    bdquo: '„', dagger: '†', Dagger: '‡', bull: '•', hellip: '…', permil: '‰', prime: '′', Prime: '″', lsaquo: '‹', rsaquo: '›',
    oline: '‾', frasl: '⁄', euro: '€', trade: '™', alefsym: 'ℵ', larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔',
    crarr: '↵', forall: '∀', part: '∂', exist: '∃', empty: '∅', nabla: '∇', isin: '∈', notin: '∉', ni: '∋', prod: '∏',
    sum: '∑', minus: '−', lowast: '∗', radic: '√', prop: '∝', infin: '∞', ang: '∠', and: '∧', or: '∨', cap: '∩', cup: '∪',
    int: '∫', there4: '∴', sim: '∼', cong: '≅', asymp: '≈', ne: '≠', equiv: '≡', le: '≤', ge: '≥', sub: '⊂', sup: '⊃',
    nsub: '⊄', sube: '⊆', supe: '⊇', oplus: '⊕', otimes: '⊗', perp: '⊥', sdot: '⋅', lceil: '⌈', rceil: '⌉', lfloor: '⌊',
    rfloor: '⌋', lang: '〈', rang: '〉', loz: '◊', spades: '♠', clubs: '♣', hearts: '♥', diams: '♦',
    OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', thetasym: 'ϑ', upsih: 'ϒ', piv: 'ϖ',
  };
  // Latin-1 带重音字母（0xC0–0xDE 大写；小写 = 大写码位 +0x20；乘号与除码位不在其中）
  const names = 'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml Oslash Ugrave Uacute Ucirc Uuml Yacute THORN'.split(' ');
  const codes = [0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd8, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde];
  names.forEach((name, idx) => {
    map[name] = String.fromCharCode(codes[idx]);
    map[name.toLowerCase()] = String.fromCharCode(codes[idx] + 0x20);
  });
  map.yuml = 'ÿ';
  // 希腊大写字母（0x391 起；0x3A2 未分配——Sigma 及之后要多加 1）
  'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho Sigma Tau Upsilon Phi Chi Psi Omega'.split(' ').forEach((name, idx) => {
    map[name] = String.fromCharCode(0x391 + idx + (idx >= 18 ? 1 : 0));
  });
  const greekLower: Array<[string, string]> = [
    ['alpha', 'α'], ['beta', 'β'], ['gamma', 'γ'], ['delta', 'δ'], ['epsilon', 'ε'], ['zeta', 'ζ'], ['eta', 'η'], ['theta', 'θ'],
    ['iota', 'ι'], ['kappa', 'κ'], ['lambda', 'λ'], ['mu', 'μ'], ['nu', 'ν'], ['xi', 'ξ'], ['omicron', 'ο'], ['pi', 'π'], ['rho', 'ρ'],
    ['sigmaf', 'ς'], ['sigma', 'σ'], ['tau', 'τ'], ['upsilon', 'υ'], ['phi', 'φ'], ['chi', 'χ'], ['psi', 'ψ'], ['omega', 'ω'],
  ];
  for (const [name, ch] of greekLower) map[name] = ch;
  return map;
}

const ENTITY = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;
/** 老页面常见的"不带分号"写法（只认这几个——放宽到全部会把网址里的 &times= 当成乘号） */
const BARE_ENTITY = /&(amp|lt|gt|quot|nbsp|copy|reg)(?![a-zA-Z0-9;])/g;

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(ENTITY, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : whole;
  }).replace(BARE_ENTITY, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()]);
}
