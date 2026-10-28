#!/usr/bin/env node
/**
 * M4-2 web-search：联网搜索 — 三级后端链，前两级可选、第三级免 key 保底。
 *  · Tavily：CORAL_TAVILY_API_KEY（注册免费额度，结果质量最好）
 *  · SearXNG：CORAL_SEARXNG_URL（自建实例，无限额）
 *  · 免 key 降级：Bing RSS → DuckDuckGo Lite（无需任何配置；质量逊于
 *    前两者但"永远能用"——没有搜索能力的调研技能等于摆设）
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
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; CORAL-Agent/2.0; web-search)' };

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
    { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const d = await res.json();
  return (d.results ?? []).slice(0, max).map(r => ({ title: r.title, url: r.url, snippet: (r.content ?? '').slice(0, 300) }));
}

/** 免 key ①：Bing RSS（format=rss 无反爬，中文环境可用 cn.bing.com） */
async function bingRssSearch(host = 'cn.bing.com') {
  const res = await fetch(`https://${host}/search?format=rss&q=${encodeURIComponent(query)}&count=${max}`,
    { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Bing RSS HTTP ${res.status}`);
  const xml = await res.text();
  // RSS item 的标题/链接/摘要用宽容正则抽（零依赖；feed 结构稳定）
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) && items.length < max) {
    const block = m[1];
    const title = decodeXml(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? '';
    const desc = decodeXml(block.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? '');
    if (title && link) items.push({ title, url: link, snippet: desc.replace(/<[^>]+>/g, '').slice(0, 300) });
  }
  if (items.length === 0) throw new Error('Bing RSS 未解析出结果');
  return items;
}

/** 免 key ②：DuckDuckGo Lite HTML（纯 GET 页面，a.result-link 结构简单） */
async function ddgLiteSearch() {
  const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();
  const items = [];
  const linkRe = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) && items.length < max) {
    const u = m[1].replace(/&amp;/g, '&');
    if (u.startsWith('http')) items.push({ title: decodeXml(m[2].replace(/<[^>]+>/g, '')), url: u, snippet: '' });
  }
  if (items.length === 0) throw new Error('DuckDuckGo 未解析出结果');
  return items;
}

function decodeXml(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .trim();
}

// 后端链：Tavily → SearXNG →（免 key）Bing RSS → DDG Lite。
// Bing 主机按查询语言选：英文查询走 www.bing.com（cn 站会给词典页），中文走 cn.bing.com
const isEnglishQuery = /^[\x00-\x7F\s]+$/.test(query);
const chain = [
  ...(tavilyKey ? [{ name: 'tavily', fn: tavilySearch }] : []),
  ...(searxUrl ? [{ name: 'searxng', fn: searxngSearch }] : []),
  { name: 'bing-rss', fn: () => bingRssSearch(isEnglishQuery ? 'www.bing.com' : 'cn.bing.com') },
  { name: 'bing-rss-alt', fn: () => bingRssSearch(isEnglishQuery ? 'cn.bing.com' : 'www.bing.com') },
  { name: 'duckduckgo-lite', fn: ddgLiteSearch },
];

emitProgress('searching', '检索中', { percent: 50 });
let lastErr = null;
for (const backend of chain) {
  try {
    const results = await backend.fn();
    if (results.length > 0) {
      emitProgress('done', `${results.length} 条（${backend.name}）`, { percent: 100 });
      console.log(JSON.stringify({ ok: true, query, engine: backend.name, results, degraded: backend.name.startsWith('bing') || backend.name.startsWith('duckduckgo') ? '免 key 降级通道（结果质量有限，配置 CORAL_TAVILY_API_KEY 可获得更好结果）' : undefined }, null, 2));
      process.exit(0);
    }
  } catch (err) {
    lastErr = err?.message ?? String(err);
    emitLog(`后端 ${backend.name} 失败: ${lastErr}`, 'warn');
  }
}
console.log(JSON.stringify({ ok: false, error: `全部搜索后端失败（最后错误: ${lastErr}）。可选：.env 配置 CORAL_TAVILY_API_KEY / CORAL_SEARXNG_URL 后重启` }));
