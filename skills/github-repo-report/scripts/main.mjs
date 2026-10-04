#!/usr/bin/env node
/**
 * M4-2 github-repo-report：拉取 GitHub 仓库信息 + 最近提交/发版，产出 Markdown 报告。
 * 零依赖：GitHub REST API（无 token 有 60/h 限额；CORAL_GITHUB_TOKEN 可选注入）。
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
const repo = String(input.repo || '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  emitLog(`无效仓库标识: ${repo}（期望 owner/name）`, 'error');
  console.log(JSON.stringify({ ok: false, error: `无效仓库标识: ${repo}` }));
  process.exit(0);
}

const headers = {
  'User-Agent': 'CORAL-Agent/2.0 github-repo-report',
  Accept: 'application/vnd.github+json',
  ...(process.env.CORAL_GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.CORAL_GITHUB_TOKEN}` } : {}),
};

emitProgress('repo', '拉取仓库信息', { percent: 20 });
async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

try {
  const info = await gh(`/repos/${repo}`);
  emitProgress('activity', '拉取提交与发版', { percent: 60 });
  const [commits, releases] = await Promise.all([
    gh(`/repos/${repo}/commits?per_page=10`).catch(() => []),
    gh(`/repos/${repo}/releases?per_page=5`).catch(() => []),
  ]);

  emitProgress('write', '生成报告', { percent: 90 });
  const outDir = process.env.CORAL_OUTPUT_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'output');
  mkdirSync(outDir, { recursive: true });
  const safe = repo.replace(/[\/:]/g, '_');
  const path = join(outDir, `github-report_${safe}.md`);
  writeFileSync(path, [
    `# ${info.full_name} 仓库报告`,
    '',
    `- 描述: ${info.description ?? '（无）'}`,
    `- Stars: ${info.stargazers_count} | Forks: ${info.forks_count} | Issues: ${info.open_issues_count}`,
    `- 语言: ${info.language ?? '—'} | License: ${info.license?.spdx_id ?? '—'}`,
    `- 最近推送: ${info.pushed_at}`,
    `- 主页: ${info.html_url}`,
    '',
    '## 最近 10 次提交',
    ...commits.map(c => `- **${(c.commit?.message ?? '').split('\n')[0].slice(0, 80)}**（${c.commit?.author?.name}，${String(c.commit?.author?.date).slice(0, 10)}）`),
    '',
    '## 最近发版',
    ...(releases.length ? releases.map(r => `- **${r.tag_name}**（${String(r.published_at).slice(0, 10)}）${(r.name ?? '').slice(0, 60)}`) : ['（无发版或不可见）']),
  ].join('\n'), 'utf-8');
  emitArtifact(`github-report_${safe}.md`, path, 'markdown', { preview: `${info.full_name}: ${info.stargazers_count}★` });
  emitProgress('done', '完成', { percent: 100 });
  console.log(JSON.stringify({ ok: true, md_path: path, stars: info.stargazers_count, commits: commits.length }, null, 2));
} catch (err) {
  emitLog(`GitHub API 失败: ${err?.message ?? err}`, 'error');
  console.log(JSON.stringify({ ok: false, error: `GitHub API 失败: ${err?.message ?? err}` }));
}
