import { describe, it, expect } from 'vitest';
import { makeTodoTool } from '../builtin/todo.js';
import { makePastRunsTool } from '../builtin/past-runs.js';
import { makeToolContext } from '../types.js';

describe('todo_write 工具（M1-3 / D19）', () => {
  it('合法清单 → ok + todo.updated 事件携带完整清单', async () => {
    const events: any[] = [];
    const tool = makeTodoTool(ev => events.push(ev));
    const r = await tool.invoke(
      { todos: [
        { content: '抓取数据', status: 'completed' },
        { content: '筛选相关', status: 'in_progress' },
        { content: '生成报告', status: 'pending' },
      ]},
      makeToolContext()
    );
    expect(r.ok).toBe(true);
    expect((r.data as any).updated).toBe(3);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('todo.updated');
    expect(events[0].payload.todos.map((t: any) => t.status)).toEqual(['completed', 'in_progress', 'pending']);
  });

  it('非法输入：空数组 / 缺 content / 非法 status / 超过 50 条', async () => {
    const tool = makeTodoTool(() => {});
    expect((await tool.invoke({ todos: [] }, makeToolContext())).error?.code).toBe('BAD_INPUT');
    expect((await tool.invoke({ todos: [{ status: 'pending' }] }, makeToolContext())).error?.code).toBe('BAD_INPUT');
    expect((await tool.invoke({ todos: [{ content: 'x', status: 'doing' }] }, makeToolContext())).error?.code).toBe('BAD_INPUT');
    expect((await tool.invoke({ todos: Array.from({ length: 51 }, () => ({ content: 'x', status: 'pending' })) }, makeToolContext())).error?.code).toBe('BAD_INPUT');
  });

  it('超长 content 被裁剪到 200 字符', async () => {
    const events: any[] = [];
    const tool = makeTodoTool(ev => events.push(ev));
    await tool.invoke({ todos: [{ content: '长'.repeat(500), status: 'pending' }] }, makeToolContext());
    expect(events[0].payload.todos[0].content.length).toBe(200);
  });

  it('权限位 auto（清单写入不设卡）', () => {
    expect(makeTodoTool(() => {}).permission).toBe('auto');
    expect(makeTodoTool(() => {}).name).toBe('todo_write');
  });
});

describe('past_runs 工具（M1-3 / D19 情景记忆）', () => {
  const store = {
    getAll: () => [
      { taskId: 't1', goal: '采集广东工信厅 3 月政策', status: 'completed', createdAt: '2026-10-01T10:00:00Z', completedAt: '2026-10-01T10:05:00Z' },
      { taskId: 't2', goal: '把政策转成推文', status: 'failed', createdAt: '2026-10-02T09:00:00Z' },
      { taskId: 't3', goal: '总结一段文本', status: 'completed', createdAt: '2026-10-03T08:00:00Z' },
      { taskId: 't4', goal: '采集佛山住建局政策', status: 'completed', createdAt: '2026-10-03T09:00:00Z' },
    ],
  };
  const tool = makePastRunsTool(store);

  it('关键词过滤（大小写不敏感）+ 按时间倒序', async () => {
    const r = await tool.invoke({ query: '政策' }, makeToolContext());
    const items = (r.data as any).items;
    // t1/t2/t4 的 goal 都含「政策」，按时间倒序
    expect(items.map((i: any) => i.id)).toEqual(['t4', 't2', 't1']);
  });

  it('更精确的关键词缩小范围', async () => {
    const r = await tool.invoke({ query: '推文' }, makeToolContext());
    expect((r.data as any).items.map((i: any) => i.id)).toEqual(['t2']);
  });

  it('status 过滤与 limit 截断', async () => {
    const failed = await tool.invoke({ status: 'failed' }, makeToolContext());
    expect((failed.data as any).items.map((i: any) => i.id)).toEqual(['t2']);

    const limited = await tool.invoke({ limit: 1 }, makeToolContext());
    expect((limited.data as any).items).toHaveLength(1);
    expect((limited.data as any).truncated).toBe(true);
  });

  it('无命中 → 空列表 + 提示', async () => {
    const r = await tool.invoke({ query: '不存在的关键词xyz' }, makeToolContext());
    expect((r.data as any).items).toHaveLength(0);
    expect((r.data as any).note).toContain('没有匹配');
  });

  it('goal 截断到 200 字符（保护上下文）', async () => {
    const longStore = { getAll: () => [{ taskId: 'x', goal: 'G'.repeat(500), status: 'completed', createdAt: '2026-01-01' }] };
    const r = await makePastRunsTool(longStore).invoke({}, makeToolContext());
    expect((r.data as any).items[0].goal.length).toBe(200);
  });
});
