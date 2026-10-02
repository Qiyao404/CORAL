/**
 * 创新点⑤：网页正文抽取（零依赖 readability 简化版）。
 * 策略（按优先级）：
 *  1. <article> / <main> / [role=main] / 常见正文 class/id 命中
 *  2. 全文回退：剔除 script/style/nav/header/footer/aside 后取最长文本块
 * 保留标题（title/h1）、段落、列表、标题层级 → Markdown-ish 输出。
 * 注：单文件启发式，不追求 Readability 库的完备 — 个人工具够用即可。
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

  const candidates = [
    { sel: '<article', re: /<article[^>]*>([\s\S]*?)<\/article>/i },
    { sel: '<main', re: /<main[^>]*>([\s\S]*?)<\/main>/i },
    { sel: '[role=main]', re: /<[^>]*role=["']?main["']?[^>]*>([\s\S]*?)<\/div>/i },
    { sel: '#content', re: /<div[^>]*id=["']content["'][^>]*>([\s\S]*?)<\/div>/i },
    { sel: '.content', re: /<div[^>]*class=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i },
    { sel: '.post', re: /<div[^>]*class=["'][^"']*(?:post|entry|article)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i },
  ];
  for (const c of candidates) {
    const m = html.match(c.re);
    if (m) {
      const md = htmlToMarkdown(m[1]);
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
