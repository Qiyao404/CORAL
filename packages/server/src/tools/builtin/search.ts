import type { Tool } from '../types.js';
import { toolOk, toolError } from '../types.js';
import type { SearchStore } from '../../store/search-store.js';

/**
 * session_search — 会话经历回溯：跨全部历史 run 的全文检索（FTS5，中英混合）。
 * agent 可据此回答"我们之前讨论过什么 / 上次那个方案是什么"，把经历过的事
 * 变成可召回的上下文（记忆文件只覆盖被蒸馏过的部分，这里覆盖全部原始轨迹）。
 */
export function makeSessionSearchTool(search: SearchStore, runs: { get(id: string): any }): Tool {
  return {
    name: 'session_search',
    description:
      'Full-text search across ALL past conversations and runs in this platform (goals, final answers, ' +
      'user/assistant messages, tool results). Use it to recall previous discussions, earlier solutions, ' +
      'or anything the user ever asked before — e.g. "the plan we discussed", "last deployment issue". ' +
      'Queries of 3+ characters match as substrings (Chinese and English both work).',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Search phrase (3+ chars recommended; matches substrings)' },
        limit: { type: 'integer', description: 'Max hits (default 6, max 20)' },
      },
    },
    source: 'builtin',
    permission: 'auto',
    effects: { idempotent: true },
    isConcurrencySafe: true,

    async invoke(input: any): Promise<import('../types.js').ToolResult> {
      const q = String(input?.query ?? '').trim();
      if (!q) return toolError('BAD_INPUT', 'query 不能为空');
      const hits = search.search(q, Number(input?.limit) || 6);
      const rich = hits.map(h => {
        const run = runs.get(h.runId);
        return {
          runId: h.runId,
          kind: h.kind,
          snippet: h.snippet,
          ...(run ? { goalPreview: String(run.goal ?? '').slice(0, 120), runStatus: run.status, createdAt: run.created_at ?? run.createdAt } : {}),
        };
      });
      return toolOk(
        { query: q, count: rich.length, hits: rich },
        rich.length === 0 ? `检索 "${q}"：无历史命中` : `检索 "${q}"：${rich.length} 条历史命中`
      );
    },
  };
}
