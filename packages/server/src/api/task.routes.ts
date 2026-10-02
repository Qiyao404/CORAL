import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { taskStore, planStore, agentStore, auditStore } from '../store/index.js';
import { eventBus } from '../event/event-bus.js';
import type { CoralEvent } from '../types/index.js';
import type { Task } from '../types/index.js';
import type { PlanningEngine } from '../planning/planning-engine.js';
import type { DAGScheduler } from '../scheduler/dag-scheduler.js';
import { createAbortController, abortTask, releaseAbortController } from '../services/task-abort-registry.js';
import { linkAbortWithTimeout } from '../services/linked-abort.js';
import { platformConfig } from '../services/config.js';
import type { RunEngine } from '../kernel/run-engine.js';
import type { RunEvent } from '../store/run-event-store.js';

/** M1-9：v1 Task 形状的事件（由 v2 RunEvent 映射，供既有前端时间线渲染） */
function runEventToCoralEvent(e: RunEvent): CoralEvent {
  return {
    eventId: e.eventId,
    type: e.type as CoralEvent['type'],
    taskId: e.runId,
    agentId: e.agentId ?? undefined,
    payload: e.payload,
    timestamp: e.timestamp,
  };
}

/** goal/message 输入上限（直接进 LLM prompt，防成本敞口） */
const MAX_GOAL_LENGTH = 10_000;

export function registerTaskRoutes(
  app: FastifyInstance,
  planningEngine: PlanningEngine,
  dagScheduler: DAGScheduler,
  /** M1-9 桥接：可选注入 run-engine — run id 可经 v1 端点透明读取 */
  runEngine?: RunEngine
) {
  // 创建任务
  app.post('/api/tasks', async (request, reply) => {
    const { goal, constraints, userId } = request.body as any;

    // P3 加固：类型与长度校验 — goal 直接进 LLM prompt，不设上限就是成本敞口
    if (typeof goal !== 'string' || goal.trim().length === 0) {
      return reply.status(400).send({ error: '缺少 goal 参数' });
    }
    if (goal.length > MAX_GOAL_LENGTH) {
      return reply.status(400).send({ error: `goal 过长（${goal.length} 字符，上限 ${MAX_GOAL_LENGTH}）` });
    }

    const taskId = nanoid();
    const task: Task = {
      taskId,
      userId: userId || 'anonymous',
      goal,
      constraints: constraints || {},
      status: 'created',
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    taskStore.insert(task);
    eventBus.emit('task.created', { taskId, goal });

    // 异步执行规划和调度
    executeTask(taskId, goal, constraints, userId, planningEngine, dagScheduler).catch(err => {
      console.error(`[任务执行] 任务 ${taskId} 执行异常:`, err);
    });

    return reply.status(201).send({
      taskId,
      status: 'planning',
      createdAt: task.createdAt,
    });
  });

  // 任务列表
  app.get('/api/tasks', async (request) => {
    const { status, limit, offset } = request.query as any;
    let tasks = taskStore.getAll();

    if (status) {
      tasks = tasks.filter(t => t.status === status);
    }

    tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const start = parseInt(offset) || 0;
    const count = parseInt(limit) || 50;
    const paginated = tasks.slice(start, start + count);

    return {
      total: tasks.length,
      items: paginated,
    };
  });

  // 任务详情
  // v1.1.1：返回持久化的 agents 实例 + 合并内存 ring buffer 与 audit_logs 持久化事件
  // M1-9 桥接：id 命中 v2 run 时透明返回 run 详情（Task 形状）— 一套前端两种数据源
  app.get('/api/tasks/:taskId', async (request, reply) => {
    const { taskId } = request.params as any;

    const v1Task = taskStore.get(taskId);
    if (!v1Task && runEngine) {
      const detail = runEngine.getRunDetail(taskId);
      if (detail) {
        const { run, events } = detail;
        return {
          task: {
            taskId: run.id,
            goal: run.goal,
            status: run.status === 'waiting_human' ? 'waiting_human' : run.status,
            result: run.final_content ? { finalContent: run.final_content } : undefined,
            error: run.error ?? undefined,
            metadata: { kind: 'run', mode: run.mode, sessionId: run.session_id, budget: run.budget, tokensIn: run.tokens_in, tokensOut: run.tokens_out, endReason: run.end_reason },
            createdAt: run.created_at,
            updatedAt: run.updated_at,
            completedAt: run.completed_at ?? undefined,
          },
          plan: null,
          agents: [],
          events: events.map(runEventToCoralEvent),
        };
      }
    }

    const task = v1Task;

    if (!task) {
      return reply.status(404).send({ error: '任务不存在' });
    }

    const plan = task.currentPlanId ? planStore.get(task.currentPlanId) : null;

    // 持久化的 agents（含最终 status / output / skillResults / completedAt）
    const agents = agentStore.find(a => a.taskId === taskId)
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

    // 事件 = 持久化 audit（高层事件、产物事件）∪ 内存 ring buffer（含 skill.log/progress）
    // eventId 去重，按 timestamp 升序
    const liveEvents = eventBus.history({ taskId, limit: 1000 });
    const persistedEvents = auditStore.findByTaskId(taskId);
    const seen = new Set<string>();
    const merged: CoralEvent[] = [];
    for (const ev of [...persistedEvents, ...liveEvents]) {
      if (!ev?.eventId || seen.has(ev.eventId)) continue;
      seen.add(ev.eventId);
      merged.push(ev);
    }
    merged.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

    return { task, plan, agents, events: merged };
  });

  // 取消任务（M0-2：真取消 — 中止 LLM 调用 + 强杀脚本子进程 + 级联取消未启动的 Agent）
  app.post('/api/tasks/:taskId/cancel', async (request, reply) => {
    const { taskId } = request.params as any;
    const task = taskStore.get(taskId);

    if (!task) {
      return reply.status(404).send({ error: '任务不存在' });
    }

    // 终态幂等：已完成/失败/已取消的任务不重复处理，状态不回退
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      return { success: true, message: `任务已处于终态（${task.status}），无需取消` };
    }

    abortTask(taskId); // 立即中止执行管线（规划 LLM / 在跑脚本）

    taskStore.update(taskId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    eventBus.emit('task.cancelled', { taskId, reason: 'user_cancelled' });
    return { success: true, message: '任务已取消' };
  });

  // 自然语言聊天入口
  app.post('/api/chat', async (request, reply) => {
    const { message, userId } = request.body as any;

    if (typeof message !== 'string' || message.trim().length === 0) {
      return reply.status(400).send({ error: '缺少 message 参数' });
    }
    if (message.length > MAX_GOAL_LENGTH) {
      return reply.status(400).send({ error: `message 过长（${message.length} 字符，上限 ${MAX_GOAL_LENGTH}）` });
    }

    const taskId = nanoid();
    const task: Task = {
      taskId,
      userId: userId || 'anonymous',
      goal: message,
      constraints: {},
      status: 'created',
      metadata: { source: 'chat' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    taskStore.insert(task);
    eventBus.emit('task.created', { taskId, goal: message, source: 'chat' });

    executeTask(taskId, message, {}, userId, planningEngine, dagScheduler).catch(err => {
      console.error(`[聊天任务] 任务 ${taskId} 执行异常:`, err);
    });

    return reply.status(201).send({
      taskId,
      status: 'planning',
      message: '任务已创建，正在规划执行方案...',
    });
  });
}

async function executeTask(
  taskId: string,
  goal: string,
  constraints: Record<string, any> | undefined,
  userId: string | undefined,
  planningEngine: PlanningEngine,
  dagScheduler: DAGScheduler
): Promise<void> {
  const controller = createAbortController(taskId);
  const signal = controller.signal;

  try {
    // 启动竞态守卫：创建请求与真正开始执行之间用户已取消（abortTask 找不到 controller 的窗口）
    const initial = taskStore.get(taskId);
    if (!initial || initial.status === 'cancelled') return;

    // 规划阶段（M0-3：规划 LLM 调用挂死不再无限等待，复用 run 级上限）
    taskStore.update(taskId, { status: 'planning', updatedAt: new Date().toISOString() });

    const planning = linkAbortWithTimeout(signal, platformConfig.agentDefaultTimeoutMs);
    let plan;
    try {
      plan = await planningEngine.plan(taskId, goal, constraints, planning.signal);
    } catch (err: any) {
      if (signal.aborted) {
        markTaskCancelled(taskId);
        return;
      }
      if (planning.timedOut) {
        const message = `规划超时（${platformConfig.agentDefaultTimeoutMs}ms，LLM 无响应）`;
        taskStore.update(taskId, {
          status: 'failed',
          error: { code: 'PLANNING_TIMEOUT', message },
          updatedAt: new Date().toISOString(),
        });
        eventBus.emit('task.failed', { taskId, error: message });
        return;
      }
      throw err; // 其他错误交给外层统一置 failed
    } finally {
      planning.cleanup();
    }

    if (signal.aborted) {
      markTaskCancelled(taskId);
      return;
    }

    planStore.insert(plan);
    taskStore.update(taskId, {
      currentPlanId: plan.planId,
      status: 'executing',
      updatedAt: new Date().toISOString(),
    });

    eventBus.emit('task.executing', { taskId, planId: plan.planId });

    // 执行阶段 — 把 goal 与可选 companyProfileOverride 透传给 scheduler
    const result = await dagScheduler.execute(plan, taskId, userId, goal, constraints?.companyProfileOverride, signal);

    if (signal.aborted || result.cancelled) {
      markTaskCancelled(taskId);
      return;
    }

    if (result.success) {
      const aggregatedOutput: Record<string, any> = {};
      for (const [agentId, agent] of result.results) {
        if (agent.output) {
          aggregatedOutput[agent.name] = agent.output;
        }
      }

      // M0-5：demo 模式的任务结果醒目携带 mock 标记
      if (platformConfig.demoMode) {
        aggregatedOutput.mock = true;
      }

      taskStore.update(taskId, {
        status: 'completed',
        result: aggregatedOutput,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });

      eventBus.emit('task.completed', { taskId, result: aggregatedOutput });
    } else {
      taskStore.update(taskId, {
        status: 'failed',
        error: { message: result.error },
        updatedAt: new Date().toISOString(),
      });

      eventBus.emit('task.failed', { taskId, error: result.error });
    }
  } catch (err: any) {
    // 取消：状态置 cancelled，不发 task.failed（cancel API 已发 task.cancelled）
    if (signal.aborted || err?.name === 'AbortError') {
      markTaskCancelled(taskId);
      return;
    }
    taskStore.update(taskId, {
      status: 'failed',
      error: { message: err.message },
      updatedAt: new Date().toISOString(),
    });

    eventBus.emit('task.failed', { taskId, error: err.message });
  } finally {
    releaseAbortController(taskId);
  }
}

/** 取消收尾：幂等地把任务落到 cancelled 终态（事件由 cancel API 统一发出） */
function markTaskCancelled(taskId: string): void {
  const task = taskStore.get(taskId);
  if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) return;
  taskStore.update(taskId, {
    status: 'cancelled',
    updatedAt: new Date().toISOString(),
    completedAt: task.completedAt ?? new Date().toISOString(),
  });
}
