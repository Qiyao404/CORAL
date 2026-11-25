import { describe, it, expect } from 'vitest';
import { extractHtml, looksLikeHtml, listSections, pickExcerpts, extractTerms } from '../builtin/html-text.js';

const BASE = 'https://example.test/dir/page.html';
const page = (body: string, head = '') =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('html-text：正文提取', () => {
  it('嵌套容器的正文完整保留（旧实现的正则遇到嵌套 div 会提前截断）', () => {
    const html = page(
      '<div id="content"><div class="inner"><p>AAA first block</p></div>' +
      '<div><p>BBB second block</p><div><p>CCC third block</p></div></div></div>'
    );
    const r = extractHtml(html, BASE);
    expect(r.text).toBe('AAA first block\n\nBBB second block\n\nCCC third block');
  });

  it('标题层级 / 列表 / 表格按阅读顺序成行', () => {
    const html = page(
      '<h1>Title</h1><h2>Sub</h2><ul><li>One</li><li>Two</li></ul>' +
      '<table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table>'
    );
    expect(extractHtml(html, BASE).text).toBe(
      '# Title\n\n## Sub\n\n- One\n- Two\n\n| Name | Value |\n|---|---|\n| A | 1 |'
    );
  });

  it('漏写 </td> / </li> 的页面：单元格与列表项仍然分开', () => {
    const html = page('<table><tr><td>A<td>B<tr><td>C<td>D</table><ul><li>X<li>Y</ul>');
    expect(extractHtml(html, BASE).text).toBe('| A | B |\n| C | D |\n\n- X\n- Y');
  });

  it('脚本 / 样式 / 注释 / 模板 / noscript / svg 不进正文', () => {
    const html = page(
      '<script>var secret = "SCRIPT_TEXT";</script><style>.a{color:red}</style>' +
      '<!-- COMMENT_TEXT --><template>TEMPLATE_TEXT</template><noscript>NOSCRIPT_TEXT</noscript>' +
      '<svg><text>SVG_TEXT</text></svg><p>Visible</p>'
    );
    const r = extractHtml(html, BASE);
    expect(r.text).toBe('Visible');
    expect(JSON.stringify(r)).not.toMatch(/SCRIPT_TEXT|COMMENT_TEXT|TEMPLATE_TEXT|NOSCRIPT_TEXT|SVG_TEXT/);
  });

  it('文档在脚本中间被截断：脚本之后的内容不泄漏成正文', () => {
    const html = page('<p>Before</p><script>var a = 1; if (a < 2) { leaking(); }');
    expect(extractHtml(html, BASE).text).toBe('Before');
  });

  it('行内标签不换行，文字自然衔接', () => {
    const html = page('<p>Plain <b>bold</b> and <span class="x">span</span> and <my-tag>custom</my-tag>.</p>');
    expect(extractHtml(html, BASE).text).toBe('Plain bold and span and custom.');
  });

  it('源码里的换行与缩进折叠成一个空格', () => {
    const html = page('<p>\n   First line\n   second line\n</p>');
    expect(extractHtml(html, BASE).text).toBe('First line second line');
  });

  it('<pre> 保留原有空白', () => {
    const html = page('<pre>def f():\n    return 1\n</pre>');
    expect(extractHtml(html, BASE).text).toBe('def f():\n    return 1');
  });

  it('实体：命名 / 数字 / 不带分号的老写法 / 未知实体原样保留', () => {
    const html = page(
      '<p>A &amp; B &lt;tag&gt; &quot;q&quot; &nbsp;x&nbsp; &#20013;&#x6587; &eacute;&Eacute; &alpha;&Omega; &copy 2000 &times=5 &nosuch; &lt 3</p>'
    );
    expect(extractHtml(html, BASE).text).toBe('A & B <tag> "q" x 中文 éÉ αΩ © 2000 &times=5 &nosuch; < 3');
  });

  it('正文里的 "<" 不是标签时保留；属性值里的 ">" 不截断标签', () => {
    const html = page('<p title="a > b">5 &lt; 6 and x < y</p><a href="/x?a=1>b" title="a > b">T</a>');
    const r = extractHtml(html, BASE);
    expect(r.text).toBe('5 < 6 and x < y\n\nT');
    expect(r.links[0].href).toBe('https://example.test/x?a=1%3Eb');
  });

  it('中文页面：全角标点与中文实体正常', () => {
    const html = page('<p>第一条：&ldquo;引号&rdquo;（括号）。</p><p>第二条&mdash;破折号</p>');
    expect(extractHtml(html, BASE).text).toBe('第一条：“引号”（括号）。\n\n第二条—破折号');
  });
});

describe('html-text：链接与图片', () => {
  it('相对地址转绝对地址，按文档顺序', () => {
    const html = page('<a href="/abs">Absolute</a> <a href="rel.html">Relative</a> <a href="//cdn.other.test/x">Protocol</a>');
    // 第三条指向别的站点：带外站标记
    expect(extractHtml(html, BASE).links).toEqual([
      { text: 'Absolute', href: 'https://example.test/abs' },
      { text: 'Relative', href: 'https://example.test/dir/rel.html' },
      { text: 'Protocol', href: 'https://cdn.other.test/x', external: true },
    ]);
  });

  it('<base href> 改写相对地址的基准', () => {
    const html = page('<a href="page.html">P</a>', '<base href="https://cdn.other.test/sub/">');
    expect(extractHtml(html, BASE).links[0].href).toBe('https://cdn.other.test/sub/page.html');
  });

  it('页内锚点 / javascript: / data: 不收；无 href 的 <a> 当普通行内元素', () => {
    const html = page('<a href="#top">Top</a> <a href="javascript:void(0)">JS</a> <a name="x">Named</a> <a href="/ok">Ok</a>');
    const r = extractHtml(html, BASE);
    expect(r.links.map(l => l.text)).toEqual(['Ok']);
    expect(r.text).toBe('Top JS Named Ok');
  });

  it('图片链接 / 空锚点：链接文字取 alt 或地址里最有信息量的一段', () => {
    const html = page('<a href="/docs/report-2024.pdf"><img src="/img/pdf.png" alt="logo"></a> <a href="/downloads/file.zip"> </a>');
    expect(extractHtml(html, BASE).links).toEqual([
      { text: 'report-2024.pdf', href: 'https://example.test/docs/report-2024.pdf' },
      { text: 'file.zip', href: 'https://example.test/downloads/file.zip' },
    ]);
  });

  it('链接跨块边界 / 漏写 </a>：在块边界收口，后面的文字照常进正文', () => {
    const html = page('<a href="/a">Link text<li>Next item');
    const r = extractHtml(html, BASE);
    expect(r.links).toEqual([{ text: 'Link text', href: 'https://example.test/a' }]);
    expect(r.text).toBe('Link text\n- Next item');
  });

  it('同一链接重复出现只收一次；不同文字的同地址链接都保留', () => {
    const html = page('<a href="/h">Home</a> <a href="/h">Home</a> <a href="/h">homepage</a>');
    expect(extractHtml(html, BASE).links.map(l => l.text)).toEqual(['Home', 'homepage']);
  });

  it('有信息量的图片 alt 进正文并列出图片地址；无信息量的不进正文', () => {
    const html = page('<img src="/img/a.png" alt="Chart of sales by year"> <img src="/img/logo.png" alt="logo"> <img src="/img/b.jpg" alt="b.jpg">');
    const r = extractHtml(html, BASE);
    expect(r.text).toBe('[图: Chart of sales by year]');
    expect(r.images.map(i => i.src)).toEqual([
      'https://example.test/img/a.png',
      'https://example.test/img/logo.png',
      'https://example.test/img/b.jpg',
    ]);
  });
});

describe('html-text：导航折叠', () => {
  it('<nav> 里的文字不进正文，但链接照收', () => {
    const html = page('<nav><a href="/">Home</a> <a href="/about">About</a> Menu label</nav><p>Body</p>');
    const r = extractHtml(html, BASE);
    expect(r.text).toBe('Body');
    expect(r.links.map(l => l.text)).toEqual(['Home', 'About']);
  });

  it('role=navigation 的容器：嵌套同名标签不会让它提前失效', () => {
    const html = page(
      '<div role="navigation"><div class="inner"><a href="/i">Inner</a></div><a href="/o">Outer</a> Still nav</div><p>Body</p>'
    );
    const r = extractHtml(html, BASE);
    expect(r.text).toBe('Body');
    expect(r.links.map(l => l.text)).toEqual(['Inner', 'Outer']);
  });

  it('导航容器没有闭合标签：不进入"导航态"，后半页照常进正文', () => {
    const html = page('<nav><a href="/a">A</a><p>After unclosed nav</p>');
    const r = extractHtml(html, BASE);
    expect(r.text).toContain('After unclosed nav');
    expect(r.text).toContain('A');
  });

  it('纵向纯链接列表（≥6 行）折叠，链接仍在 links 里', () => {
    const items = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta'];
    const html = page(`<ul class="menu">${items.map(x => `<li><a href="/${x.toLowerCase()}">${x}</a></li>`).join('')}</ul><p>Body</p>`);
    const r = extractHtml(html, BASE);
    expect(r.text).toBe('Body');
    expect(r.links.map(l => l.text)).toEqual(items);
    expect(r.foldedRegions).toBe(1);
  });

  it('横向密集链接行（行首即链接、≥8 个）折叠', () => {
    const words = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
    const html = page(`<div class="bar">${words.map(w => `<a href="/${w.toLowerCase()}">${w}</a>`).join(' | ')}</div><p>Body</p>`);
    const r = extractHtml(html, BASE);
    expect(r.text).toBe('Body');
    expect(r.foldedRegions).toBe(1);
  });

  it('一句话里带多个链接是正文，不能折', () => {
    const html = page(
      '<p>The band members were <a href="/john">John</a>, <a href="/paul">Paul</a>, <a href="/george">George</a> and <a href="/ringo">Ringo</a>.</p>'
    );
    expect(extractHtml(html, BASE).text).toBe('The band members were John, Paul, George and Ringo.');
  });

  it('行首不是链接的密集行（"See also:"）保留', () => {
    const words = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
    const html = page(`<p>See also: ${words.map(w => `<a href="/${w}">${w}</a>`).join(' ')}</p>`);
    expect(extractHtml(html, BASE).text).toMatch(/^See also: One Two Three/);
  });

  it('表格里的链接行是数据，不折叠', () => {
    const years = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022];
    const html = page(`<table><tr>${years.map(y => `<td><a href="/y${y}">${y}</a></td>`).join('')}</tr></table>`);
    const r = extractHtml(html, BASE);
    expect(r.text).toBe('| 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 |');
    expect(r.foldedRegions).toBe(0);
  });

  it('不足 6 行的链接列表保留（面包屑 / 简短导航）', () => {
    const html = page('<ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li><li><a href="/c">C</a></li><li><a href="/d">D</a></li><li><a href="/e">E</a></li></ul>');
    expect(extractHtml(html, BASE).text).toBe('- A\n- B\n- C\n- D\n- E');
  });
});

describe('html-text：隐藏内容', () => {
  it('短的隐藏内容保留（折叠面板里的规格）', () => {
    const html = page('<div style="display: none"><p>Specs: 12V, 2A</p></div><p>Visible</p>');
    expect(extractHtml(html, BASE).text).toBe('Specs: 12V, 2A\n\nVisible');
  });

  it('hidden 属性等同隐藏', () => {
    expect(extractHtml(page('<section hidden>Collapsed details</section>'), BASE).text).toBe('Collapsed details');
  });

  it('很长的隐藏内容丢弃并计数（站点塞的隐藏数据 / 模板）', () => {
    const blob = 'x'.repeat(5000);
    const r = extractHtml(page(`<div style="display:none">${blob}</div><p>Visible</p>`), BASE);
    expect(r.text).toBe('Visible');
    expect(r.hiddenDroppedChars).toBe(5000);
  });

  it('隐藏节点没有闭合：不进入隐藏态，后半页照常进正文', () => {
    const html = page('<div style="display:none"><p>Hidden?</p><p>Still here</p>');
    const r = extractHtml(html, BASE);
    expect(r.text).toContain('Still here');
    expect(r.text).toContain('Hidden?');
  });

  it('隐藏节点里的换行不泄漏到正文', () => {
    const html = page('<p>Before</p><div style="display:none"><p>H1</p><p>H2</p></div><p>After</p>');
    expect(extractHtml(html, BASE).text).toBe('Before\n\nH1 H2\n\nAfter');
  });
});

describe('html-text：标题 / meta / 结构化数据', () => {
  it('标题取 <title>；meta 按属性名收录并跳过无信息量的条目', () => {
    const html = page('<p>x</p>', '<title>Hello &amp; Welcome</title><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
      '<meta name="description" content="A test page"><meta property="og:title" content="OG Title">');
    const r = extractHtml(html, BASE);
    expect(r.title).toBe('Hello & Welcome');
    expect(r.meta).toEqual({ description: 'A test page', 'og:title': 'OG Title' });
  });

  it('没有 <title> 时取第一个 <h1>，再没有取 og:title', () => {
    expect(extractHtml(page('<h1>Only Heading</h1>'), BASE).title).toBe('Only Heading');
    expect(extractHtml(page('<p>x</p>', '<meta property="og:title" content="OG Only">'), BASE).title).toBe('OG Only');
    expect(extractHtml(page('<p>x</p>'), BASE).title).toBe('');
  });

  it('JSON-LD 结构化数据原文带出（发表日期这类信息常在这里）', () => {
    const html = page('<p>x</p>', '<script type="application/ld+json">{"@type":"Article","datePublished":"2024-01-02"}</script>');
    expect(extractHtml(html, BASE).structuredData).toEqual(['{"@type":"Article","datePublished":"2024-01-02"}']);
  });
});

describe('html-text：是否按 HTML 处理', () => {
  it('Content-Type 说是，或正文以完整文档头开头', () => {
    expect(looksLikeHtml('text/html; charset=utf-8', 'anything')).toBe(true);
    expect(looksLikeHtml('application/xhtml+xml', '<html></html>')).toBe(true);
    expect(looksLikeHtml('text/plain', '<!DOCTYPE html><html><body>x</body></html>')).toBe(true);
  });

  it('接口返回里夹几个标签不算 HTML', () => {
    expect(looksLikeHtml('application/json', '{"a":1}')).toBe(false);
    expect(looksLikeHtml('text/plain', 'a <b>bold</b> tag')).toBe(false);
    expect(looksLikeHtml('text/plain', '<div id="root"></div>')).toBe(false);
  });
});

describe('html-text：体量与健壮性', () => {
  it('1MB 级页面在合理时间内处理完', () => {
    const para = '<div class="row"><p>Some paragraph text number PLACEHOLDER with a <a href="/l/PLACEHOLDER">link</a> and more words.</p></div>';
    const html = page(para.replace(/PLACEHOLDER/g, () => String(Math.random())).repeat(9000));
    expect(html.length).toBeGreaterThan(1_000_000);
    const started = Date.now();
    const r = extractHtml(html, BASE);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(r.text).toContain('Some paragraph text');
  });

  it('空文档 / 只有标签 / 各种残缺输入都不抛异常', () => {
    for (const bad of ['', '   ', '<', '<>', '<p', '<p>unclosed', '</div>', '<<<>>>', '<a href=', '<div><b><i>x', '<!--', '<script>', '&', '&#', '&#xZZ;']) {
      const r = extractHtml(bad, BASE);
      expect(typeof r.text).toBe('string');
      expect(Array.isArray(r.links)).toBe(true);
    }
  });

  it('链接条数：默认收得下几百条（目录页、列表页的链接常常过百），到了上限如实标出而不是悄悄丢掉', () => {
    // 实测存档的大页面里，链接数 p90 超过 200 —— 上限太低会把"页面后半段的链接"无声地丢掉
    const many = (n: number) => page(Array.from({ length: n }, (_, i) => `<a href="/p${i}">链接 ${i}</a>`).join(' '));
    const r = extractHtml(many(650), BASE);
    expect(r.links).toHaveLength(600);
    expect(r.linksTruncated).toBe(true);
    const all = extractHtml(many(450), BASE);
    expect(all.links).toHaveLength(450);
    expect(all).not.toHaveProperty('linksTruncated');
    const capped = extractHtml(many(50), BASE, { maxLinks: 20 });
    expect(capped.links).toHaveLength(20);
    expect(capped.linksTruncated).toBe(true);
    // 图片映射里的可点击区域也算链接，到上限同样标出
    const areas = page(`<img src="/map.png" usemap="#m" alt="地图"><map name="m">${Array.from({ length: 25 }, (_, i) => `<area href="/r${i}" alt="区域 ${i}">`).join('')}</map>`);
    const areaCapped = extractHtml(areas, BASE, { maxLinks: 20 });
    expect(areaCapped.links).toHaveLength(20);
    expect(areaCapped.linksTruncated).toBe(true);
  });
});

describe('html-text：链接带上下文', () => {
  it('带 title / aria-label 提示（与可见文字不同时才带）；外站链接标 external', () => {
    const html = page('<p><a href="/a" title="详细说明">甲</a> <a href="/b" aria-label="乙的说明">乙</a> <a href="/c" title="丙">丙</a> <a href="https://other.test/x">外站</a> <a href="mailto:a@b.test">写信</a></p>');
    const links = extractHtml(html, BASE).links;
    expect(links[0]).toEqual({ text: '甲', href: 'https://example.test/a', title: '详细说明' });
    expect(links[1]).toEqual({ text: '乙', href: 'https://example.test/b', title: '乙的说明' });
    expect(links[2]).toEqual({ text: '丙', href: 'https://example.test/c' }); // title 与文字相同 → 不带
    expect(links[3]).toEqual({ text: '外站', href: 'https://other.test/x', external: true });
    expect(links[4]).toMatchObject({ text: '写信', external: true });
  });

  it('导航容器里的链接标 nav；被折叠的链接区里的链接标 list（两者可靠程度不同，分开标）；正文里的都不标', () => {
    const items = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta'];
    const html = page(`<nav><a href="/">Home</a></nav><ul class="menu">${items.map(x => `<li><a href="/${x}">${x}</a></li>`).join('')}</ul><p>正文里的<a href="/in-text">链接</a>。</p>`);
    const links = extractHtml(html, BASE).links;
    expect(links.find(l => l.text === 'Home')).toMatchObject({ nav: true });
    expect(links.find(l => l.text === 'Home')?.list).toBeUndefined();
    for (const x of items) {
      expect(links.find(l => l.text === x), x).toMatchObject({ list: true });
      expect(links.find(l => l.text === x)?.nav, x).toBeUndefined();
    }
    expect(links.find(l => l.text === '链接')).toEqual({ text: '链接', href: 'https://example.test/in-text' });
  });
});

describe('html-text：表格', () => {
  const table = (inner: string) => page(`<table>${inner}</table>`);

  it('表头行（th 或 thead）后加分隔线；数据行各自成行', () => {
    expect(extractHtml(table('<tr><th>姓名</th><th>数值</th></tr><tr><td>甲</td><td>1</td></tr><tr><td>乙</td><td>2</td></tr>'), BASE).text)
      .toBe('| 姓名 | 数值 |\n|---|---|\n| 甲 | 1 |\n| 乙 | 2 |');
    expect(extractHtml(table('<thead><tr><td>A</td><td>B</td></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody>'), BASE).text)
      .toBe('| A | B |\n|---|---|\n| 1 | 2 |');
  });

  it('没有表头的键值表（首列是行标题）：各行照常，没有分隔线', () => {
    expect(extractHtml(table('<tr><th scope="row">姓名</th><td>甲</td></tr><tr><th scope="row">数值</th><td>1</td></tr>'), BASE).text)
      .toBe('| 姓名 | 甲 |\n| 数值 | 1 |');
  });

  it('跨列：合并的值填满它盖住的列；跨行：合并的值填到下面几行', () => {
    const html = table('<tr><th colspan="2">上半年</th><th colspan="2">下半年</th></tr><tr><td>一月</td><td>二月</td><td>七月</td><td>八月</td></tr><tr><td rowspan="2">东区</td><td>10</td><td>20</td><td>30</td></tr><tr><td>11</td><td>21</td><td>31</td></tr>');
    expect(extractHtml(html, BASE).text).toBe([
      '| 上半年 | 上半年 | 下半年 | 下半年 |',
      '|---|---|---|---|',
      '| 一月 | 二月 | 七月 | 八月 |',
      '| 东区 | 10 | 20 | 30 |',
      '| 东区 | 11 | 21 | 31 |',
    ].join('\n'));
  });

  it('嵌套表：内层表格的内容并进外层单元格；单元格里的换行 / 列表项不把表格撑乱', () => {
    const html = table('<tr><th>项目</th><th>明细</th></tr><tr><td>甲</td><td><table><tr><td>x</td><td>y</td></tr><tr><td>z</td><td>w</td></tr></table></td></tr><tr><td>乙</td><td>第一行<br>第二行</td></tr><tr><td>丙</td><td><ul><li>一</li><li>二</li></ul></td></tr>');
    expect(extractHtml(html, BASE).text).toBe([
      '| 项目 | 明细 |',
      '|---|---|',
      '| 甲 | x | y ; z | w |',
      '| 乙 | 第一行 第二行 |',
      '| 丙 | • 一 • 二 |',
    ].join('\n'));
  });

  it('表格标题放在表格前；只有一个格的表当普通段落', () => {
    expect(extractHtml(table('<caption>销售数据</caption><tr><td>甲</td><td>1</td></tr>'), BASE).text).toBe('表：销售数据\n| 甲 | 1 |');
    expect(extractHtml(table('<tr><td>只有一段说明文字。</td></tr>'), BASE).text).toBe('只有一段说明文字。');
  });

  it('超过行数上限如实标注，前面的行照常输出', () => {
    const rows = Array.from({ length: 205 }, (_, i) => `<tr><td>第 ${i} 行</td></tr>`).join('');
    const text = extractHtml(table(rows), BASE).text;
    expect(text.split('\n').filter(l => l.startsWith('| 第 ')).length).toBe(200);
    expect(text).toContain('已截断');
  });
});

describe('html-text：长页面目录与相关片段', () => {
  const TEXT = [
    '# 机器学习', '', '导言段落，介绍机器学习的定义。', '',
    '## 历史', '', '机器学习的历史可以追溯到 1950 年代。', '',
    '## 应用', '', '机器学习在图像识别、自然语言处理里应用广泛。', '',
    '### 医疗', '', '医疗影像分析里机器学习被用于病灶检测。', '',
    '## 外部链接', '', '- 链接一', '- 链接二',
  ].join('\n');

  it('listSections：按标题列出目录与偏移，偏移能定位到原文', () => {
    const s = listSections(TEXT);
    expect(s.map(x => x.title)).toEqual(['机器学习', '历史', '应用', '医疗', '外部链接']);
    for (const x of s) expect(TEXT.slice(x.offset, x.offset + x.title.length)).toBe(x.title);
    expect(s[0]).toMatchObject({ level: 1 });
    expect(s[3]).toMatchObject({ level: 3 });
    expect(listSections('没有标题的一段文字。\n\n也没有。')).toEqual([]);
  });

  it('pickExcerpts：按关注点挑出相关的段落（带偏移），标题跟它的段落在一起', () => {
    const ex = pickExcerpts(TEXT, '机器学习在医疗上的应用', { budget: 2000 });
    // 片段是原文里连续的一段：标题与正文之间保留原来的空行
    expect(ex.map(x => x.text)).toContain('### 医疗\n\n医疗影像分析里机器学习被用于病灶检测。');
    expect(ex.map(x => x.text)).toContain('## 应用\n\n机器学习在图像识别、自然语言处理里应用广泛。');
    for (const x of ex) expect(TEXT.slice(x.offset, x.offset + x.text.length)).toBe(x.text);
    // 开头已经内联的部分不重复给
    const later = pickExcerpts(TEXT, '机器学习的定义', { budget: 2000, excludeUntil: 60 });
    expect(later.map(x => x.text)).not.toContain('导言段落，介绍机器学习的定义。');
  });

  it('pickExcerpts：预算用完就停、按原文顺序返回、关注点里没有有效的词时返回空', () => {
    const many = Array.from({ length: 12 }, (_, i) => `第 ${i} 段：这一段讲的是目标主题 target${i % 3} 的内容，还有别的词。`).join('\n\n');
    const ex = pickExcerpts(many, 'target1', { budget: 120, maxBlocks: 8 });
    expect(ex.length).toBeGreaterThan(0);
    expect(ex.every(x => x.text.includes('target1'))).toBe(true);
    expect(ex.reduce((n, x) => n + x.text.length, 0)).toBeLessThanOrEqual(120);
    expect(ex.map(x => x.offset)).toEqual([...ex.map(x => x.offset)].sort((a, b) => a - b));
    expect(pickExcerpts(many, '的 了 是', { budget: 1000 })).toEqual([]);
    expect(pickExcerpts('', '任何内容', { budget: 1000 })).toEqual([]);
  });

  it('英文关注点不区分大小写；数字能命中', () => {
    const t = 'Intro paragraph.\n\nThe station opened in 1987 near the river.';
    expect(pickExcerpts(t, 'STATION 1987 opened', { budget: 500 }).map(x => x.text)).toEqual([t.split('\n\n')[1]]);
  });

  it('一节跨在截断点上（标题已在内联部分里、内容在后面）→ 只取截断点之后的尾巴，不能整块跳过', () => {
    const t = '## 交通\n\n地铁三号线日均客流量为 42 万人次，公交系统覆盖全市，共有 200 条线路。';
    const cut = t.indexOf('\n\n') + 2; // 内联部分到标题行为止
    const ex = pickExcerpts(t, '地铁 客流', { budget: 500, excludeUntil: cut });
    expect(ex.length).toBe(1);
    expect(ex[0].text).toBe('地铁三号线日均客流量为 42 万人次，公交系统覆盖全市，共有 200 条线路。');
    expect(t.slice(ex[0].offset, ex[0].offset + ex[0].text.length)).toBe(ex[0].text);
    // 整块都在截断点之前的，仍然不重复给
    expect(pickExcerpts('地铁客流统计年报\n\n别的段落。', '地铁', { budget: 500, excludeUntil: 20 })).toEqual([]);
  });

  it('篇幅不够时先给命中多的段落：两段各提到 3 次（排在后面）、两段各提到 1 次（排在前面），只放得下两段', () => {
    const weak = (i: number) => `第 ${i} 段：这里只提到一次 target，其余是别的内容，补足长度用的文字。`;
    const strong = (i: string) => `第 ${i} 段：target 的 target 和 target 在这里反复出现，其余是别的内容，补足长度用的文字。`;
    const blocks = [weak(0), weak(1), strong('2'), strong('3')];
    const budget = blocks[0].length + blocks[2].length + 40; // 两段放得下，三段放不下
    const ex = pickExcerpts(blocks.join('\n\n'), 'target', { budget, maxBlocks: 8 });
    expect(ex.map(x => x.text)).toEqual([blocks[2], blocks[3]]);
  });

  it('关注点拆词：停用词不要；带数字的词和长词权重更高', () => {
    const w = extractTerms('the city station 1987');
    expect(w.has('the')).toBe(false);
    expect(w.get('city')).toBe(1);
    expect(w.get('station')).toBe(2);
    expect(w.get('1987')).toBe(2);
  });
});
