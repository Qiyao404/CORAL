import { nanoid } from 'nanoid';
import type { CoralEvent, CoralEventType } from '../types/index.js';
import { auditStore } from '../store/index.js';

type EventHandler = (event: CoralEvent) => void;

/** 不进 audit 持久化的高频事件（仅放进内存 ring buffer + 通过 WS/SSE 实时下发）*/
const VOLATILE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'skill.log',
  'skill.progress',
  // M1-5：v2 run/loop/tool 事件持久化在 events 表（事件溯源），不重复写 audit_events
  'run.created', 'run.started', 'run.completed', 'run.failed', 'run.cancelled', 'run.budget_exceeded',
  'loop.step_started', 'loop.step_completed', 'loop.context_compressed', 'loop.cancelled', 'loop.failed',
  'tool.call_started', 'tool.call_completed', 'tool.call_failed',
  'todo.updated', 'checkpoint.created',
  'subagent.started', 'subagent.completed', 'subagent.failed',
]);

/** 内存 ring buffer 的容量上限（防止长时间任务下日志事件爆内存） */
const RING_BUFFER_LIMIT = 4000;

/**
 * 进程内事件总线 — 支持发布订阅 + 通配符（`module.*` / `*`）+ WS 直推
 */
export class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private eventHistory: CoralEvent[] = [];
  private wsClients: Set<(event: CoralEvent) => void> = new Set();

  on(type: string, handler: EventHandler): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
  }

  off(type: string, handler: EventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  emit(type: CoralEventType, payload: Record<string, any> & { taskId?: string; agentId?: string; skillName?: string }): CoralEvent {
    const event: CoralEvent = {
      eventId: nanoid(),
      type,
      taskId: payload.taskId,
      agentId: payload.agentId,
      skillName: payload.skillName,
      payload,
      timestamp: new Date().toISOString(),
    };

    // ring buffer：保留最近 RING_BUFFER_LIMIT 条事件用于内存历史查询
    this.eventHistory.push(event);
    if (this.eventHistory.length > RING_BUFFER_LIMIT) {
      this.eventHistory.splice(0, this.eventHistory.length - RING_BUFFER_LIMIT);
    }

    // 高频日志/进度事件不进 audit_logs（避免文件爆掉）
    if (!VOLATILE_EVENT_TYPES.has(type)) {
      try { auditStore.insert(event); } catch { /* 持久化失败不阻塞主流程 */ }
    }

    this.dispatchHandler(this.handlers.get(type), event);

    const prefix = type.split('.')[0] + '.*';
    this.dispatchHandler(this.handlers.get(prefix), event);

    this.dispatchHandler(this.handlers.get('*'), event);

    for (const send of this.wsClients) {
      try { send(event); } catch { /* 忽略断开的连接 */ }
    }

    return event;
  }

  private dispatchHandler(handlers: Set<EventHandler> | undefined, event: CoralEvent) {
    if (!handlers) return;
    for (const handler of handlers) {
      try { handler(event); } catch (err) {
        console.error(`[事件总线] 处理器异常: ${event.type}`, err);
      }
    }
  }

  addWsClient(sender: (event: CoralEvent) => void): void {
    this.wsClients.add(sender);
  }

  removeWsClient(sender: (event: CoralEvent) => void): void {
    this.wsClients.delete(sender);
  }

  history(filter?: { taskId?: string; type?: string; limit?: number }): CoralEvent[] {
    let results = this.eventHistory;
    if (filter?.taskId) {
      results = results.filter(e => e.taskId === filter.taskId);
    }
    if (filter?.type) {
      const t = filter.type.replace('*', '');
      results = results.filter(e => e.type === filter.type || e.type.startsWith(t));
    }
    if (filter?.limit) {
      results = results.slice(-filter.limit);
    }
    return results;
  }

  /** 仅供测试/工具使用：清空内存历史 */
  clearHistory(): void {
    this.eventHistory = [];
  }
}

export const eventBus = new EventBus();
