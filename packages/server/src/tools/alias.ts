import type { Tool } from './types.js';

/**
 * 工具名自动纠正（用户实测：模型反复幻觉 web_fetch / fetch_url 等名字，
 * 错误列表能自纠但每轮浪费一次调用）。
 *
 * 两级匹配：
 *  1. 人工别名表 — 常见幻觉名的确定映射（web_fetch → http_fetch 等）
 *  2. 编辑距离 ≤2 的模糊匹配（拼写错误级别：http_fecth → http_fetch）
 * 未命中返回 null（走原有 TOOL_NOT_FOUND + 可用列表自纠）。
 */

const ALIASES: Record<string, string> = {
  // http 抓取
  web_fetch: 'http_fetch',
  fetch_url: 'http_fetch',
  fetch: 'http_fetch',
  url_fetch: 'http_fetch',
  get_url: 'http_fetch',
  open_url: 'http_fetch',
  browse: 'http_fetch',
  // 文件系统
  read_file: 'fs_read',
  write_file: 'fs_write',
  edit_file: 'fs_edit',
  list_files: 'fs_list',
  list_dir: 'fs_list',
  ls: 'fs_list',
  search_files: 'fs_search',
  grep: 'fs_search',
  find_in_files: 'fs_search',
  // docx
  read_docx: 'docx_read',
  write_docx: 'docx_write',
  word_read: 'docx_read',
  word_write: 'docx_write',
  // 其他
  spawn_agent: 'agent_spawn',
  create_agent: 'agent_spawn',
  subagent: 'agent_spawn',
  todo: 'todo_write',
  todos: 'todo_write',
  update_todo: 'todo_write',
  memory_search_files: 'memory_search',
  recall: 'memory_search',
};

/** 编辑距离（≤2 才有意义；长度差 >2 直接短路） */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

export interface AliasResolution {
  tool: Tool;
  /** 实际执行的工具名（与请求名不同时即发生了纠正） */
  correctedFrom?: string;
}

export function resolveToolName(requested: string, tools: Tool[]): AliasResolution | null {
  const byName = new Map(tools.map(t => [t.name, t]));
  const lower = requested.toLowerCase();

  // 0) 精确命中
  const exact = byName.get(requested);
  if (exact) return { tool: exact };

  // 1) 别名表（大小写不敏感）
  const aliasTarget = ALIASES[lower];
  if (aliasTarget) {
    const t = byName.get(aliasTarget);
    if (t) return { tool: t, correctedFrom: requested };
  }

  // 2) 模糊：编辑距离 ≤2 的唯一最近匹配（多个并列最近则不猜）
  let best: Tool | null = null;
  let bestDist = 99;
  let tie = false;
  for (const t of tools) {
    const d = editDistance(lower, t.name.toLowerCase());
    if (d < bestDist) { bestDist = d; best = t; tie = false; }
    else if (d === bestDist && best && t.name !== best.name) { tie = true; }
  }
  if (best && bestDist <= 2 && !tie) {
    return { tool: best, correctedFrom: requested };
  }
  return null;
}
