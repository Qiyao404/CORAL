// web-reader — 抓取网页并抽取正文（创新点⑤）
import { emitProgress, emitLog } from '../../_lib/coral-progress.mjs';
import { extractReadable } from '../../_lib/readability.mjs';

const stdin = await new Promise(resolve => {
  let data = '';
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => resolve(data));
});

let url = '';
let includeLinks = false;
try {
  const parsed = JSON.parse(stdin || '{}');
  url = String(parsed.input?.url ?? parsed.input ?? '');
  includeLinks = Boolean(parsed.input?.include_links);
} catch {
  url = '';
}

if (!/^https?:\/\//i.test(url)) {
  process.stdout.write(JSON.stringify({ error: `无效 URL: ${url}` }));
  process.exit(0);
}

try {
  emitProgress('fetch', `抓取 ${url}`, { percent: 20 });
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CORAL-Agent/2.0)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    process.stdout.write(JSON.stringify({ error: `HTTP ${res.status}` }));
    process.exit(0);
  }
  emitProgress('extract', '抽取正文', { percent: 60 });
  const html = await res.text();
  const article = extractReadable(html);

  emitProgress('done', `正文 ${article.length} 字符（策略: ${article.strategy}）`, { percent: 100 });
  emitLog(`标题: ${article.title}`);

  process.stdout.write(JSON.stringify({
    title: article.title,
    content: article.content,
    length: article.length,
    strategy: article.strategy,
    ...(includeLinks ? { links: article.links } : {}),
  }));
} catch (err) {
  process.stdout.write(JSON.stringify({ error: String(err?.message ?? err) }));
}
