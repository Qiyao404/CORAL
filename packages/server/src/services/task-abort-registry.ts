/**
 * 任务级 AbortController 注册表（M0-2 — 修复 A1 假取消）：
 * cancel API → abortTask() → 规划 LLM 调用 / DAG 调度 / Skill 执行 / 脚本子进程全链路立即中止。
 * executeTask 的 finally 中调用 release，防止 Map 泄漏。
 */
const controllers = new Map<string, AbortController>();

export function createAbortController(taskId: string): AbortController {
  releaseAbortController(taskId);
  const controller = new AbortController();
  controllers.set(taskId, controller);
  return controller;
}

/** 中止任务；返回 false 表示该任务没有存活中的执行管线（已结束或从未启动） */
export function abortTask(taskId: string): boolean {
  const controller = controllers.get(taskId);
  if (!controller) return false;
  if (!controller.signal.aborted) controller.abort();
  return true;
}

/** 中止全部存活任务（服务关闭时用），返回中止数量 */
export function abortAll(): number {
  let count = 0;
  for (const controller of controllers.values()) {
    if (!controller.signal.aborted) {
      controller.abort();
      count++;
    }
  }
  return count;
}

export function isTaskAborted(taskId: string): boolean {
  return controllers.get(taskId)?.signal.aborted === true;
}

export function releaseAbortController(taskId: string): void {
  controllers.delete(taskId);
}
