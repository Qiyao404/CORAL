/**
 * 创新点⑤：网页正文抽取（零依赖 readability 简化版）。
 * 策略（按优先级）：
 *  1. <article> / <main> / [role=main] / 常见正文 class/id 命中
 *  2. 全文回退：剔除 script/style/nav/header/footer/aside 后取最长文本块
 * 保留标题（title/h1）、段落、列表、标题层级 → Markdown-ish 输出。
 * 注：单文件启发式，不追求 Readability 库的完备 — 个人工具够用即可。
 *
 * 容器配对按嵌套层数走（balancedEnd）：此前用惰性正则 `<div …>([\s\S]*?)<\/div>` 取内容，
 * 遇到嵌套的 div 会在第一个内层 </div> 处提前收口——命中的"正文"只有开头一小截，
 * 之后的内容静默丢失（抓取方还以为读完了）。
 */

/**
 * @typedef {Object} ExtractResult
 * @property {string} title
 * @property {string} content
 * @property {number} length
 * @property {string} strategy
 * @property {Array<{href: string, text: string}>} links
 */

/**
 * 抽取网页正文。
 * @param {string} html
 * @returns {ExtractResult}
 */
export function extractReadable(html) {
  const title = matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i) || matchFirst(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) || '';
  const links = collectLinks(html);

  // 候选容器：open = 起始标签；tag = 用于配对的标签名（role=main 的标签名从命中处取）
  const candidates = [
    { sel: '<article', open: /<article\b[^>]*>/gi, tag: () => 'article' },
    { sel: '<main', open: /<main\b[^>]*>/gi, tag: () => 'main' },
    { sel: '[role=main]', open: /<[a-z][^>]*\brole\s*=\s*["']?main["']?[^>]*>/gi, tag: m => tagOf(m[0]) },
    { sel: '#content', open: /<div\b[^>]*\bid\s*=\s*["']content["'][^>]*>/gi, tag: () => 'div' },
    { sel: '.content', open: /<div\b[^>]*\bclass\s*=\s*["'][^"']*content[^"']*["'][^>]*>/gi, tag: () => 'div' },
    { sel: '.post', open: /<div\b[^>]*\bclass\s*=\s*["'][^"']*(?:post|entry|article)[^"']*["'][^>]*>/gi, tag: () => 'div' },
  ];
  for (const c of candidates) {
    // 同一种选择器可能命中多个：取第一个内容够长的（外层命中优先于内层）
    for (const m of html.matchAll(c.open)) {
      const start = m.index + m[0].length;
      const md = htmlToMarkdown(html.slice(start, balancedEnd(html, c.tag(m), start)));
      if (md.length >= 200) {
        return finish(title, md, c.sel, links);
      }
    }
  }

  // 全文回退
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '');
  return finish(title, htmlToMarkdown(stripped), 'full-page-fallback', links);
}

function tagOf(openTag) {
  return (/^<([a-zA-Z][\w-]*)/.exec(openTag)?.[1] ?? 'div').toLowerCase();
}

/**
 * 从 from 起找到与"已打开一层"的 tagName 配对的闭合标签位置（按同名标签的嵌套层数计数）。
 * 找不到闭合（文档被截断）→ 到文末。
 */
export function balancedEnd(html, tagName, from) {
  const re = new RegExp(`<(/?)${tagName}\\b[^>]*>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0].endsWith('/>')) continue; // 自闭合不开新层
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index;
  }
  return html.length;
}

function collectLinks(html) {
  const links = [];
  const re = /<a[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && links.length < 50) {
    const text = stripTags(m[2]).trim();
    if (text && m[1].startsWith('http')) links.push({ href: m[1], text: text.slice(0, 100) });
  }
  return links;
}

function htmlToMarkdown(fragment) {
  return fragment
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, text) => `\n\n${'#'.repeat(Number(lvl))} ${stripTags(text).trim()}\n\n`)
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, text) => `**${stripTags(text).trim()}**`)
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, text) => `*${stripTags(text).trim()}*`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, text) => `\n- ${stripTags(text).trim()}`)
    .replace(/<\/(p|div|section|ul|ol|table|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map(l => l.trim()).filter((l, i, arr) => l !== '' || (arr[i - 1] ?? '') !== '').join('\n')
    .trim();
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '').trim();
}

function matchFirst(html, re) {
  const m = html.match(re);
  return m ? stripTags(m[1]).trim().slice(0, 300) : '';
}

function finish(title, content, strategy, links) {
  const trimmed = content.slice(0, 50_000);
  return {
    title: decodeEntities(title),
    content: trimmed,
    length: trimmed.length,
    strategy,
    links,
  };
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
