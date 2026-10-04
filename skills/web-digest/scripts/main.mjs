#!/usr/bin/env node
/**
 * M4-2 web-digest：抓取一个或多个 URL 的正文，产出合并的 Markdown 摘要文件。
 * 零 npm 依赖（正文抽取用 _lib/readability.mjs；进度协议用 _lib/coral-progress.mjs）。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitProgress, emitLog, emitArtifact } from '../../_lib/coral-progress.mjs';
import { extractReadable } from '../../_lib/readability.mjs';

const stdin = await new Promise(resolve => {
  let data = '';
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => resolve(data));
});
const payload = JSON.parse(stdin || '{}');
const input = payload.input ?? payload; // 协议契约：{input, context} 包装（兼容裸输入）
const urls = (Array.isArray(input.urls) ? input.urls : input.url ? [input.url] : [])
  .map(String).filter(u => /^https?:\/\//.test(u));

if (urls.length === 0) {
  emitLog('缺少 urls（至少一个 http(s) 地址）', 'error');
  console.log(JSON.stringify({ ok: false, error: '缺少 urls' }));
  process.exit(0);
}

const outDir = process.env.CORAL_OUTPUT_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'output');
const { mkdirSync, writeFileSync } = await import('node:fs');
mkdirSync(outDir, { recursive: true });

emitProgress('init', `开始抓取 ${urls.length} 个页面`, { percent: 5, total: urls.length });

const sections = [];
const failures = [];
for (let i = 0; i < urls.length; i++) {
  const url = urls[i];
  emitProgress('fetch', `[${i + 1}/${urls.length}] ${url.slice(0, 60)}`, { percent: 10 + Math.floor(80 * (i / urls.length)), step: i + 1, total: urls.length });
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'CORAL-Agent/2.0 web-digest' }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const article = extractReadable(html);
    sections.push(`## ${(article.title || url)}\n\n来源: ${url}\n\n${(article.content || '').slice(0, 20000)}`);
  } catch (err) {
    failures.push({ url, error: String(err?.message ?? err) });
    emitLog(`抓取失败 ${url}: ${err?.message ?? err}`, 'warn');
  }
}

emitProgress('write', '合并写入 Markdown', { percent: 95 });
const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const path = join(outDir, `web-digest_${ts}.md`);
const body = [
  `# Web Digest（${new Date().toLocaleString('zh-CN')}）`,
  '',
  ...sections,
  failures.length ? `\n---\n# 抓取失败（${failures.length}）\n${failures.map(f => `- ${f.url}: ${f.error}`).join('\n')}` : '',
].join('\n\n');
writeFileSync(path, body, 'utf-8');
emitArtifact(`web-digest_${ts}.md`, path, 'markdown', { preview: sections.map(s => s.split('\n')[0]).join(' / ').slice(0, 200) });
emitProgress('done', '完成', { percent: 100 });

console.log(JSON.stringify({
  ok: failures.length === urls.length ? false : true,
  md_path: path,
  pages_ok: sections.length,
  pages_failed: failures.length,
  failures,
}, null, 2));
