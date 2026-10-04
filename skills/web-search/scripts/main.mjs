#!/usr/bin/env node
/**
 * M4-2 web-search（可选技能，D21）：联网搜索 — 双后端可配，用户自有 key。
 *  · Tavily：CORAL_TAVILY_API_KEY（推荐，注册免费额度）
 *  · SearXNG：CORAL_SEARXNG_URL（自建实例，无需 key）
 * 都未配置时返回明确指引（不伪造结果）。
 */
import { emitProgress, emitLog } from '../../_lib/coral-progress.mjs';

const stdin = await new Promise(resolve => {
  let data = '';
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => resolve(data));
});
const payload = JSON.parse(stdin || '{}');
const input = payload.input ?? payload;
const query = String(input.query || '').trim();
const max = Math.min(Math.max(Number(input.max) || 5, 1), 10);
if (!query) {
  console.log(JSON.stringify({ ok: false, error: '缺少 query（搜索词）' }));
  process.exit(0);
}

emitProgress('init', `搜索: ${query}`, { percent: 20 });
const tavilyKey = process.env.CORAL_TAVILY_API_KEY;
const searxUrl = process.env.CORAL_SEARXNG_URL;

async function tavilySearch() {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: tavilyKey, query, max_results: max, search_depth: 'basic' }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const d = await res.json();
  return (d.results ?? []).map(r => ({ title: r.title, url: r.url, snippet: (r.content ?? '').slice(0, 300) }));
}

async function searxngSearch() {
  const res = await fetch(`${searxUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json&language=zh-CN`,
    { headers: { 'User-Agent': 'CORAL-Agent/2.0 web-search' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const d = await res.json();
  return (d.results ?? []).slice(0, max).map(r => ({ title: r.title, url: r.url, snippet: (r.content ?? '').slice(0, 300) }));
}

try {
  const results = tavilyKey ? await tavilySearch() : searxUrl ? await searxngSearch() : null;
  if (results === null) {
    emitLog('未配置搜索后端 — 请设置 CORAL_TAVILY_API_KEY 或 CORAL_SEARXNG_URL', 'warn');
    console.log(JSON.stringify({
      ok: false,
      error: 'web-search 未配置：请在 .env 设置 CORAL_TAVILY_API_KEY（推荐，tavily.com 免费注册）或 CORAL_SEARXNG_URL（自建实例地址）后重启',
    }));
    process.exit(0);
  }
  emitProgress('done', `${results.length} 条结果`, { percent: 100 });
  console.log(JSON.stringify({ ok: true, query, engine: tavilyKey ? 'tavily' : 'searxng', results }, null, 2));
} catch (err) {
  emitLog(`搜索失败: ${err?.message ?? err}`, 'error');
  console.log(JSON.stringify({ ok: false, error: `搜索失败: ${err?.message ?? err}` }));
}
