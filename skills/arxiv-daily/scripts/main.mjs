#!/usr/bin/env node
/**
 * M4-2 arxiv-daily：抓取 arXiv 指定分类的最新论文列表，产出每日摘要 Markdown。
 * 零依赖：arXiv API 返回 Atom XML，用轻量正则解析条目。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { emitProgress, emitLog, emitArtifact } from '../../_lib/coral-progress.mjs';

const stdin = await new Promise(resolve => {
  let data = '';
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => resolve(data));
});
const payload = JSON.parse(stdin || '{}');
const input = payload.input ?? payload;
const category = String(input.category || 'cs.AI');
const max = Math.min(Math.max(Number(input.max) || 10, 1), 50);

emitProgress('init', `arXiv ${category} 最新 ${max} 篇`, { percent: 10 });

let xml;
try {
  const url = `http://export.arxiv.org/api/query?search_query=cat:${category}&sortBy=submittedDate&sortOrder=descending&max_results=${max}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'CORAL-Agent/2.0 arxiv-daily' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  xml = await res.text();
} catch (err) {
  emitLog(`arXiv API 失败: ${err?.message ?? err}`, 'error');
  console.log(JSON.stringify({ ok: false, error: `arXiv API 失败: ${err?.message ?? err}` }));
  process.exit(0);
}

emitProgress('parse', '解析条目', { percent: 60 });
// 终审 P3：Atom 实体解码（&amp;/&quot;/数字实体 — 先数字后命名，&amp; 最后防双解）
function decodeEntities(t) {
  return t
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]).map(e => {
  const pick = (re) => { const mm = e.match(re); return mm ? mm[1].trim() : ''; };
  return {
    title: decodeEntities(pick(/<title>([\s\S]*?)<\/title>/).replace(/\s+/g, ' ')),
    summary: decodeEntities(pick(/<summary>([\s\S]*?)<\/summary>/).replace(/\s+/g, ' ')).slice(0, 300),
    link: pick(/<id>([\s\S]*?)<\/id>/),
    published: pick(/<published>([\s\S]*?)<\/published>/).slice(0, 10),
    authors: [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(a => a[1].trim()).slice(0, 4),
  };
});

emitProgress('write', '生成 Markdown', { percent: 90 });
const outDir = process.env.CORAL_OUTPUT_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'output');
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const path = join(outDir, `arxiv-${category.replace(/\./g, '-')}_${today}.md`);
writeFileSync(path, [
  `# arXiv ${category} 每日速览（${today}）`,
  '',
  ...entries.map((e, i) => `## ${i + 1}. ${e.title}\n\n- 日期: ${e.published} | 作者: ${e.authors.join(', ')}\n- 链接: ${e.link}\n- 摘要: ${e.summary}…`),
].join('\n\n'), 'utf-8');
emitArtifact(path.split(/[\/]/).pop(), path, 'markdown', { preview: entries[0]?.title ?? '' });
emitProgress('done', `共 ${entries.length} 篇`, { percent: 100 });

console.log(JSON.stringify({ ok: true, md_path: path, count: entries.length, category }, null, 2));
