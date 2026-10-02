import { describe, it, expect } from 'vitest';
import { extractReadable } from './readability.mjs';

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
