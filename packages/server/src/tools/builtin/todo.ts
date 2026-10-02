import type { Tool } from '../types.js';
import { toolOk, toolError } from '../types.js';

/**
 * M1-3（D19）：todo_write — agent 的可见任务清单。
 * 整体替换式写入（Claude TodoWrite 模式）；清单状态通过事件流出，
 * run-engine 落库、前端（M1-8）渲染为进度 checklist。
 */

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const STATUS_SET = new Set(['pending', 'in_progress', 'completed']);

export function makeTodoTool(): Tool {
  return {
    name: 'todo_write',
    description:
      'Write your task list for the current goal (replaces the whole list each time). ' +
      'Use it for any multi-step work: plan first, then move items to in_progress/completed as you go. ' +
      'The list is shown to the user as a live checklist.',
    inputSchema: {
      type: 'object',
      required: ['todos'],
      properties: {
        todos: {
          type: 'array',
          description: 'Full task list in execution order',
          items: {
            type: 'object',
            required: ['content', 'status'],
            properties: {
              content: { type: 'string', description: 'Task description (short)' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
          },
        },
      },
    },
    source: 'builtin',
    permission: 'auto',

    async invoke(input: any, ctx: import('../types.js').ToolContext): Promise<import('../types.js').ToolResult> {
      const todos = input?.todos;
      if (!Array.isArray(todos) || todos.length === 0) {
        return toolError('BAD_INPUT', 'todos 必须为非空数组');
      }
      if (todos.length > 50) {
        return toolError('BAD_INPUT', `todos 过多（${todos.length}，上限 50）`);
      }
      const cleaned: TodoItem[] = [];
      for (const t of todos) {
        // 健壮性（用户实测反馈）：模型常用 task/text 误作键名 — 接受别名
        const content = String(t?.content ?? t?.task ?? t?.text ?? '').trim();
        const status = String(t?.status ?? '');
        if (!content) return toolError('BAD_INPUT', '清单项缺少文本：请用 "content" 键（每项 {content, status}）');
        if (!STATUS_SET.has(status)) {
          return toolError('BAD_INPUT', `todo.status 非法: ${status}（须为 pending/in_progress/completed）`);
        }
        cleaned.push({ content: content.slice(0, 200), status: status as TodoItem['status'] });
      }

      ctx.emit({ type: 'todo.updated', payload: { todos: cleaned } });

      return toolOk({
        updated: cleaned.length,
        todos: cleaned,
      });
    },
  };
}
