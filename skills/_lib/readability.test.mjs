import { describe, it, expect } from 'vitest';
import { extractReadable, balancedEnd } from './readability.mjs';

const PAGE = `
<html><head><title>测试页面标题</title></head>
<body>
<nav><a href="/home">首页</a><a href="/about">关于</a></nav>
<article>
  <h1>文章主标题</h1>
  <p>这是第一段正文，包含一些<b>加粗</b>与<i>斜体</i>内容。</p>
  <p>第二段：&amp; &lt;tag&gt; &quot;引号&quot;</p>
  <ul><li>列表项一</li><li>列表项二</li></ul>
  <h2>小节标题</h2>
  <p>小节内容，足够长以通过正文阈值检查——这里需要更多文字来确保长度超过两百个字符的最低要求，所以我们在下面补充一些真实的中文句子，让抽取器有足够的信号判断这是正文而不是导航残渣。补充：系统应当保留标题层级与列表结构，方便后续 LLM 阅读与总结，同时剔除脚本与样式定义，避免把 JavaScript 代码当作正文输出。这一段再补充一些内容确保长度稳定超过阈值线。</p>
</article>
<a href="https://external.example.com/page">外链文本</a>
<footer>版权所有</footer>
</body></html>
`;

describe('readability.mjs — 正文抽取（创新点⑤）', () => {
  const r = extractReadable(PAGE);

  it('命中 <article> 策略，标题与正文抽取正确', () => {
    expect(r.strategy).toBe('<article');
    expect(r.title).toBe('测试页面标题');
    expect(r.content).toContain('文章主标题');
    expect(r.content).toContain('第一段正文');
    expect(r.content).toContain('**加粗**');
    expect(r.content).toContain('*斜体*');
    expect(r.content).toContain('## 小节标题');      // 标题层级保留
    expect(r.content).toContain('- 列表项一');        // 列表转 Markdown
  });

  it('实体解码 + 剔除 nav/footer/script', () => {
    expect(r.content).toContain('& <tag> "引号"');
    expect(r.content).not.toContain('版权所有');
    expect(r.content).not.toContain('<nav');
  });

  it('链接收集（仅 http 外链，含文本）', () => {
    expect(r.links.some(l => l.href === 'https://external.example.com/page' && l.text === '外链文本')).toBe(true);
    expect(r.links.every(l => l.href.startsWith('http'))).toBe(true);
  });

  it('无 article → 回退全文策略（剔 script）', () => {
    const r2 = extractReadable('<html><body><script>var x=1;</script><p>fallback content paragraph with enough text to be captured here.</p></body></html>');
    expect(r2.strategy).toBe('full-page-fallback');
    expect(r2.content).toContain('fallback content');
    expect(r2.content).not.toContain('var x=1');
  });

  it('length 反映截断后内容', () => {
    const big = extractReadable(`<article><p>${'长'.repeat(60000)}</p></article>`);
    expect(big.length).toBeLessThanOrEqual(50_000);
  });
});

describe('readability.mjs — 嵌套容器不再提前截断', () => {
  const para = (name) => `<p>${name}：这一段要足够长，才能通过正文策略的两百字符阈值检查，所以这里多写一些字来凑长度。${'补充说明文字。'.repeat(30)}</p>`;

  it('<div id="content"> 里有嵌套 div：内容取到配对的闭合标签，而不是第一个内层 </div>', () => {
    const html = `<html><body><div id="content"><div class="inner">${para('第一段')}</div><div>${para('第二段')}<div>${para('第三段')}</div></div></div></body></html>`;
    const r = extractReadable(html);
    expect(r.strategy).toBe('#content');
    expect(r.content).toContain('第一段');
    expect(r.content).toContain('第二段');
    expect(r.content).toContain('第三段');
  });

  it('旧实现的问题复现：惰性正则只取到第一个内层 </div>', () => {
    // 对照：同样结构用旧的正则取法，第二、三段取不到
    const html = `<div id="content"><div class="inner">AAA</div><div>BBB</div></div>`;
    const old = /<div[^>]*id=["']content["'][^>]*>([\s\S]*?)<\/div>/i.exec(html)[1];
    expect(old).toContain('AAA');
    expect(old).not.toContain('BBB');
  });

  it('[role=main] 落在任意标签上、且内部有嵌套同名标签', () => {
    const html = `<html><body><section role="main"><div>${para('甲')}</div><div>${para('乙')}</div></section></body></html>`;
    const r = extractReadable(html);
    expect(r.strategy).toBe('[role=main]');
    expect(r.content).toContain('甲');
    expect(r.content).toContain('乙');
  });

  it('同一个选择器命中多处：取第一个内容够长的；前面的短命中（导航条）跳过', () => {
    const html = `<html><body><div class="content"><span>菜单</span></div><div class="content">${para('正文')}</div></body></html>`;
    const r = extractReadable(html);
    expect(r.strategy).toBe('.content');
    expect(r.content).toContain('正文');
    expect(r.content).not.toContain('菜单');
  });

  it('容器没闭合（文档被截断）：取到文末，不抛异常', () => {
    const html = `<main><p>${para('开头')}</p><div>${para('后面')}`;
    const r = extractReadable(html);
    expect(r.content).toContain('开头');
    expect(r.content).toContain('后面');
  });

  it('balancedEnd：自闭合标签不开新层', () => {
    const html = '<div><div class="x"/><p>a</p></div><p>b</p>';
    // 不跳过自闭合的话，层数会多算一层，最后的 </div> 配不上对 → 只能取到文末
    expect(balancedEnd(html, 'div', 5)).toBe(html.indexOf('</div>'));
  });
});
