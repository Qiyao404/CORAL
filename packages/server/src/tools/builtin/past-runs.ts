import type { Tool } from '../types.js';
import { toolOk } from '../types.js';

/**
 * M1-3（D19）：past_runs — 情景记忆工具化。
 * 让 agent 查询「我以前做过什么」（v1 tasks 表即完整行为史；M1-5 后 runs 表接管）。
 * 只读查询 → auto 权限。
 */

interface PastTaskLike {
  taskId?: string;
  goal?: string;
  status?: string;
  createdAt?: string;
  completedAt?: string;
}

export function makePastRunsTool(store: { getAll(): PastTaskLike[] }): Tool {
  return {
    name: 'past_runs',
    description:
      'Search previously executed tasks (episodic memory). Returns id, goal, status and time. ' +
      'Use it when the user refers to earlier work ("上次那个报告", "昨天抓的政策") or when prior results could help.',
    inputSchema: {
      type: 'object',
      required: [],
      properties: {
        query: { type: 'string', description: 'Keyword to match in task goals (case-insensitive); omit to list recent' },
        status: { type: 'string', enum: ['completed', 'failed', 'cancelled'], description: 'Filter by final status' },
        limit: { type: 'integer', description: 'Max results (default 10, max 50)' },
      },
    },
    source: 'builtin',
    permission: 'auto',

    async invoke(input: any) {
      const query = String(input?.query ?? '').trim().toLowerCase();
      const status = input?.status ? String(input.status) : undefined;
      const limit = Math.min(Math.max(Number(input?.limit) || 10, 1), 50);

      let tasks = store.getAll();
      if (query) {
        tasks = tasks.filter(t => (t.goal ?? '').toLowerCase().includes(query));
      }
      if (status) {
        tasks = tasks.filter(t => t.status === status);
      }
      tasks.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

      const items = tasks.slice(0, limit).map(t => ({
        id: t.taskId,
        goal: (t.goal ?? '').slice(0, 200),
        status: t.status,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
      }));

      return toolOk({
        total: tasks.length,
        returned: items.length,
        truncated: tasks.length > items.length,
        items,
        note: items.length === 0 ? '没有匹配的历史任务' : undefined,
      });
    },
  };
}
