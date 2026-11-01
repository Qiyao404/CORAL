import type { Tool, ToolResult, ToolContext } from '../types.js';
import { toolOk, toolError } from '../types.js';
import type { TeamService } from '../../kernel/team-service.js';

/**
 * Teams 工具组（模型侧接口）— 与 team_spawn（spawn.ts，复用子代理机制）配套：
 *  · team_send  代理间直接消息（步边界投递：运行中的在下一轮请求前收到）
 *  · team_tasks 共享任务板（create/update/list，revision 乐观锁 + blockedBy 无环）
 *  · team_wait  等待指定 teammate 终态并取回其最终回答
 *
 * 设计取向：工具面收窄（任务板四操作合一）— 每次 run 的上下文成本 ~3 条描述。
 */

const MAX_WAIT_MS = 600_000;
const DEFAULT_WAIT_MS = 120_000;

export function makeTeamSendTool(team: TeamService, selfName: string): Tool {
  return {
    name: 'team_send',
    description:
      `Send a direct message to a teammate or to the lead agent ("main"). ` +
      `Delivery happens at the target's next step boundary (queued, never lost, never interrupts a running step). ` +
      `Use it to hand off findings, ask for a computation, or report a blocker.`,
    inputSchema: {
      type: 'object',
      required: ['to', 'content'],
      properties: {
        to: { type: 'string', description: 'Teammate name, or "main" for the lead agent' },
        content: { type: 'string', description: 'Message content (self-contained; the reader may lack your context)' },
      },
    },
    source: 'builtin',
    permission: 'auto',
    effects: { idempotent: false },

    async invoke(input: any, ctx: ToolContext): Promise<ToolResult> {
      const r = team.send(selfName, String(input?.to ?? ''), String(input?.content ?? ''));
      if (!r.ok) return toolError('TEAM_SEND_FAILED', r.error, false);
      return toolOk(
        { queued: true, to: String(input?.to).trim().toLowerCase(), note: '消息已入队 — 目标代理在下一个步边界收到' },
        `→ ${String(input?.to).trim().toLowerCase()}：消息已入队（步边界投递）`
      );
    },
  };
}

export function makeTeamTasksTool(team: TeamService, selfName: string): Tool {
  return {
    name: 'team_tasks',
    description:
      'Shared task board for the whole team (survives across teammates). Actions: ' +
      '"list" (shows readiness — a task is ready when all its blockers are completed), ' +
      '"create" (subject + optional description + blockedBy task ids), ' +
      '"update" (status pending/in_progress/completed/deleted, owner, or add blockers; pass expectedRevision for conflict-safe updates).',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update'] },
        subject: { type: 'string', description: 'create: one-line task title' },
        description: { type: 'string', description: 'create/update: details of the task' },
        blockedBy: { type: 'array', items: { type: 'string' }, description: 'create: task ids this task depends on' },
        id: { type: 'string', description: 'update: task id (t1, t2...)' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'], description: 'update: new status' },
        owner: { type: 'string', description: 'update: owner name (teammate or main)' },
        expectedRevision: { type: 'integer', description: 'update: revision you read (conflict detection; omit to force)' },
        addBlockedBy: { type: 'array', items: { type: 'string' }, description: 'update: additional blocker task ids' },
      },
    },
    source: 'builtin',
    permission: 'auto',
    effects: { idempotent: false },

    async invoke(input: any): Promise<ToolResult> {
      switch (String(input?.action ?? '')) {
        case 'list': {
          const tasks = team.listTasks();
          return toolOk(
            { count: tasks.length, tasks },
            tasks.length === 0
              ? '任务板为空'
              : `任务板 ${tasks.length} 项：${tasks.filter(t => t.status === 'in_progress').length} 进行中 / ${tasks.filter(t => t.status === 'completed').length} 已完成`
          );
        }
        case 'create': {
          const r = team.createTask({
            subject: String(input?.subject ?? ''),
            description: input?.description,
            blockedBy: input?.blockedBy,
            owner: typeof input?.owner === 'string' && input.owner ? input.owner : selfName,
          });
          if (!r.ok) return toolError('TEAM_TASK_CREATE_FAILED', r.error, false);
          return toolOk(
            { id: r.task.id, revision: r.task.revision, blockedBy: r.task.blockedBy },
            `创建任务 ${r.task.id}「${r.task.subject}」`
          );
        }
        case 'update': {
          const r = team.updateTask({
            id: String(input?.id ?? ''),
            expectedRevision: typeof input?.expectedRevision === 'number' ? input.expectedRevision : undefined,
            status: input?.status,
            owner: input?.owner === null ? null : input?.owner,
            description: input?.description,
            addBlockedBy: input?.addBlockedBy,
          });
          if (!r.ok) return toolError('TEAM_TASK_UPDATE_FAILED', r.error, false);
          return toolOk(
            { id: r.task.id, revision: r.task.revision, status: r.task.status },
            `更新任务 ${r.task.id} → ${r.task.status ?? r.task.subject}（r${r.task.revision}）`
          );
        }
        default:
          return toolError('BAD_INPUT', 'action 必须是 list / create / update', false);
      }
    },
  };
}

export function makeTeamWaitTool(team: TeamService): Tool {
  return {
    name: 'team_wait',
    description:
      'Wait for teammates to finish and collect their final answers. ' +
      'Pass "all" or a list of teammate names. Blocks until all named teammates settle or the timeout (default 120s, max 600s); ' +
      'still-running teammates are reported as running so you can wait again.',
    inputSchema: {
      type: 'object',
      required: ['agents'],
      properties: {
        agents: { type: 'array', items: { type: 'string' }, description: 'Teammate names, or ["all"]' },
        timeout_s: { type: 'integer', description: 'Max seconds to block (default 120, max 600)' },
      },
    },
    source: 'builtin',
    permission: 'auto',
    effects: { idempotent: true },

    async invoke(input: any): Promise<ToolResult> {
      let names: string[];
      const raw = Array.isArray(input?.agents) ? input.agents.map(String) : [];
      if (raw.length === 0 || raw.includes('all')) {
        names = team.listTeammates().map(t => t.name);
      } else {
        names = raw;
      }
      if (names.length === 0) {
        return toolOk({ results: [], note: '当前没有 teammate' }, '当前没有 teammate');
      }
      const unknown = names.filter(n => !team.getTeammate(n));
      if (unknown.length > 0) {
        return toolError('TEAMMATE_NOT_FOUND', `未知 teammate: ${unknown.join(', ')}（已知: ${team.listTeammates().map(t => t.name).join(', ') || '无'}）`, false);
      }
      const timeoutMs = Math.min(Math.max(Number(input?.timeout_s) || DEFAULT_WAIT_MS / 1000, 1) * 1000, MAX_WAIT_MS);
      const handles = await team.wait(names, timeoutMs);
      const results = handles.map(h => ({
        name: h.name,
        status: h.status,
        ...(h.result ? { finalContent: h.result.finalContent, steps: h.result.steps } : {}),
      }));
      const done = results.filter(r => r.status !== 'running').length;
      return toolOk(
        { results, waited: names.length, settled: done, timeout: done < names.length },
        names.length === done
          ? `${done} 个 teammate 已完成`
          : `等待超时：${done}/${names.length} 完成，其余仍在运行`
      );
    },
  };
}
