import type {
  ExecutionPlan, AgentInstance,
  SkillExecutionResult, DependencyEdge,
  ParsedSkillManifest
} from '../types/index.js';
import { eventBus } from '../event/event-bus.js';
import { agentStore } from '../store/index.js';
import type { SkillExecutor } from '../skill-runtime/skill-executor.js';
import type { FilesystemSkillRegistry } from '../skill-runtime/filesystem-registry.js';
import { platformConfig } from '../services/config.js';
import { linkAbortWithTimeout } from '../services/linked-abort.js';
import { jitterDelayMs, type RetryPolicy } from '../providers/retry.js';

/**
 * M0-4：Skill 失败（含重试耗尽）时抛出，携带 Skill 层的错误码与可重试性，
 * 调度器据此给 Agent 定性 —— 不再整体重跑 Agent 的全部 Skill（A5 后半修复）。
 */
class SkillFailureError extends Error {
  constructor(
    public skillName: string,
    public skillError: { code: string; message: string; retryable: boolean }
  ) {
    super(`Skill "${skillName}" 执行失败: ${skillError.message}`);
    this.name = 'SkillFailureError';
  }
}

/**
 * DAG 并发调度器 — 基于拓扑排序的入度驱动调度
 */
export class DAGScheduler {
  private executor: SkillExecutor;
  private maxConcurrency: number;
  private registry?: FilesystemSkillRegistry;
  /** M0-4：Skill 粒度重试策略（与 Agent 超时重试共用退避参数与抖动） */
  private readonly skillRetryPolicy: RetryPolicy = {
    maxRetries: platformConfig.agentMaxRetries,
    baseDelayMs: 500,
    maxDelayMs: 8000,
  };

  constructor(executor: SkillExecutor, registry?: FilesystemSkillRegistry) {
    this.executor = executor;
    this.maxConcurrency = platformConfig.maxConcurrentAgentsPerTask;
    this.registry = registry;
  }

  async execute(plan: ExecutionPlan, taskId: string, userId?: string, taskGoal?: string, companyProfileOverride?: Record<string, any>, signal?: AbortSignal): Promise<{
    success: boolean;
    results: Map<string, AgentInstance>;
    error?: string;
    /** M0-2：任务被取消时为 true（区别于执行失败） */
    cancelled?: boolean;
  }> {
    const agents = this.initializeAgents(plan, taskId, taskGoal);
    const inDegree = this.computeInDegree(plan.edges, agents);
    const completed = new Map<string, AgentInstance>();
    const running = new Set<string>();
    const failed = new Set<string>();
    const skipped = new Set<string>();
    const isAborted = () => signal?.aborted === true;

    // 入度 0 的节点构成初始就绪队列
    const readyQueue: AgentInstance[] = [];
    for (const agent of agents.values()) {
      if (inDegree.get(agent.agentId) === 0) {
        readyQueue.push(agent);
      }
    }
    readyQueue.sort((a, b) => (a as any).priority - (b as any).priority);

    while (readyQueue.length > 0 || running.size > 0) {
      // 启动就绪的 Agent（受并发上限控制；已取消则不再启动新 Agent）
      while (readyQueue.length > 0 && running.size < this.maxConcurrency && !isAborted()) {
        const agent = readyQueue.shift()!;
        // 跳过已被上游短路的 agent
        if (skipped.has(agent.agentId) || agent.status === 'cancelled') continue;
        running.add(agent.agentId);

        this.runAgent(agent, completed, plan.edges, userId, companyProfileOverride, signal).then(result => {
          running.delete(agent.agentId);

          if (result.status === 'completed') {
            completed.set(agent.agentId, result);

            // FR-I 优雅短路：检查上游产物是否「为空」，若是 → 后继直接 skipped
            const upstreamEmpty = this.isOutputEmpty(result, this.findManifestForAgent(agent));

            for (const edge of plan.edges) {
              if (edge.from === agent.agentId) {
                const successor = agents.get(edge.to);
                if (!successor) continue;

                if (upstreamEmpty) {
                  // 标记该 successor 为 skipped（cancelled），其下游也会同步 skipped
                  this.cascadeSkip(edge.to, agents, plan.edges, completed, skipped, agent.agentId);
                  continue;
                }

                const newDegree = (inDegree.get(edge.to) || 1) - 1;
                inDegree.set(edge.to, newDegree);

                if (newDegree === 0 && successor.status === 'pending') {
                  this.injectUpstreamData(successor, plan.edges, completed);
                  readyQueue.push(successor);
                  readyQueue.sort((a, b) => (a as any).priority - (b as any).priority);
                }
              }
            }
          } else if (result.status === 'cancelled') {
            // 已被上游 skip 或任务取消的节点不算失败
            completed.set(agent.agentId, result);
            skipped.add(agent.agentId);
          } else {
            failed.add(agent.agentId);
            completed.set(agent.agentId, result);
          }
        });
      }

      // 等待任一 Agent 完成或就绪队列有新元素（M2 将改为事件驱动）
      await new Promise(resolve => setTimeout(resolve, 200));

      // 任务已取消且在跑的 Agent 都已收敛 → 退出
      if (isAborted() && running.size === 0) break;
    }

    // 取清扫尾：未启动（pending）与滞留（running）的 Agent 全部标记 cancelled
    if (isAborted()) {
      for (const agent of agents.values()) {
        if (agent.status === 'pending' || agent.status === 'running') {
          this.cancelAgent(agent, 'task_cancelled');
        }
        if (!completed.has(agent.agentId)) completed.set(agent.agentId, agent);
      }
      return { success: false, results: completed, error: '任务已取消', cancelled: true };
    }

    const allSuccess = failed.size === 0;
    return {
      success: allSuccess,
      results: completed,
      error: allSuccess ? undefined : `${failed.size} 个 Agent 执行失败`,
    };
  }

  private initializeAgents(plan: ExecutionPlan, taskId: string, taskGoal?: string): Map<string, AgentInstance> {
    const agents = new Map<string, AgentInstance>();

    for (const planned of plan.agents) {
      const agent: AgentInstance = {
        agentId: planned.agentId,
        taskId,
        planId: plan.planId,
        name: planned.name,
        role: planned.role,
        status: 'pending',
        assignedSkills: planned.assignedSkills,
        skillResults: {},
        dependsOn: planned.dependsOn,
        retryCount: 0,
        maxRetries: platformConfig.agentMaxRetries,
        timeoutMs: platformConfig.agentDefaultTimeoutMs,
        createdAt: new Date().toISOString(),
      };

      // 保存规划阶段的输入模板和任务目标，供执行时使用
      (agent as any).skillInputTemplates = planned.skillInputTemplates || {};
      (agent as any).taskGoal = taskGoal;

      agents.set(agent.agentId, agent);
      agentStore.insert(agent);

      eventBus.emit('agent.spawned', {
        taskId,
        agentId: agent.agentId,
        name: agent.name,
        role: agent.role,
      });
    }

    return agents;
  }

  private computeInDegree(edges: DependencyEdge[], agents: Map<string, AgentInstance>): Map<string, number> {
    const inDegree = new Map<string, number>();
    for (const agent of agents.values()) {
      inDegree.set(agent.agentId, 0);
    }
    for (const edge of edges) {
      inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
    }
    return inDegree;
  }

  private async runAgent(
    agent: AgentInstance,
    completed: Map<string, AgentInstance>,
    edges: DependencyEdge[],
    userId?: string,
    companyProfileOverride?: Record<string, any>,
    signal?: AbortSignal,
    /** M0-4：超时重试时传入此前已成功的 Skill 结果 — 已完成的绝不重跑（A5 修复） */
    resumeFrom?: Record<string, SkillExecutionResult>
  ): Promise<AgentInstance> {
    // M0-2：重试重入前复查取消（退避等待期间任务可能已被取消）
    if (signal?.aborted) {
      this.cancelAgent(agent, 'task_cancelled');
      return agent;
    }

    // M0-3：Agent 级超时 — 每次尝试独立 deadline；超时经 abort 机制中止在跑的 LLM/脚本，
    // 与用户取消共用同一中止通道，由 timedOut 区分定性（超时=失败可重试，取消=cancelled）
    const attempt = linkAbortWithTimeout(signal, agent.timeoutMs || platformConfig.agentDefaultTimeoutMs);

    agent.status = 'running';
    agent.startedAt = new Date().toISOString();
    agentStore.update(agent.agentId, { status: 'running', startedAt: agent.startedAt });

    eventBus.emit('agent.started', {
      taskId: agent.taskId,
      agentId: agent.agentId,
      name: agent.name,
    });

    // M0-4：声明在 try 之外 — 超时重试时 catch 块能拿到本轮已成功的 Skill 结果用于恢复
    const skillResults: Record<string, SkillExecutionResult> = {};
    try {
      let lastOutput: Record<string, any> = {};
      const templates: Record<string, any> = (agent as any).skillInputTemplates || {};
      const taskGoal: string = (agent as any).taskGoal || '';

      for (const skillName of agent.assignedSkills) {
        attempt.signal.throwIfAborted?.();

        // M0-4：超时重试恢复 — 上一轮已成功的 Skill 直接复用结果
        const prior = resumeFrom?.[skillName];
        if (prior?.success) {
          skillResults[skillName] = prior;
          if (prior.data) lastOutput = { ...lastOutput, ...prior.data };
          continue;
        }

        // 构造输入：规划模板 → 上游注入 → 前序 Skill 输出，层层覆盖
        const templateInput = templates[skillName] || {};
        const upstreamInput = (agent as any).injectedInput || {};
        const skillInput = { ...templateInput, ...upstreamInput, ...lastOutput };

        // 如果所有来源都没提供有效数据，把任务目标作为兜底文本注入
        const hasData = Object.values(skillInput).some(
          v => v !== undefined && v !== null && v !== '' && !(typeof v === 'object' && Object.keys(v).length === 0)
        );
        if (!hasData && taskGoal) {
          skillInput.text = taskGoal;
          skillInput.data = { goal: taskGoal };
          skillInput.transform_rules = taskGoal;
        }

        // M0-4：Skill 粒度重试（可重试错误退避重试；不可重试立即出局）
        const result = await this.executeSkillWithRetry(
          agent, skillName, skillInput, userId, companyProfileOverride, attempt.signal
        );

        if (!result.success) {
          throw new SkillFailureError(skillName, {
            code: result.error?.code || 'EXECUTION_ERROR',
            message: result.error?.message || '未知错误',
            retryable: Boolean(result.error?.retryable),
          });
        }

        skillResults[skillName] = result;
        if (result.data) {
          lastOutput = { ...lastOutput, ...result.data };
        }
      }

      agent.status = 'completed';
      agent.skillResults = skillResults;
      agent.output = lastOutput;
      agent.completedAt = new Date().toISOString();

      agentStore.update(agent.agentId, {
        status: 'completed',
        skillResults,
        output: lastOutput,
        completedAt: agent.completedAt,
      });

      eventBus.emit('agent.completed', {
        taskId: agent.taskId,
        agentId: agent.agentId,
        name: agent.name,
        output: lastOutput,
      });

      return agent;
    } catch (err: any) {
      // 用户取消：以外层任务信号为唯一判定（超时中止不算取消）
      if (signal?.aborted) {
        this.cancelAgent(agent, 'task_cancelled');
        return agent;
      }

      // M0-3：超时 → AGENT_TIMEOUT；重试从失败 Skill 恢复（已完成 Skill 不重跑）
      if (attempt.timedOut) {
        agent.retryCount++;
        if (agent.retryCount <= agent.maxRetries) {
          const delay = jitterDelayMs(agent.retryCount - 1, this.skillRetryPolicy);
          console.log(`[DAG 调度器] Agent "${agent.name}" 超时，${delay}ms 后第 ${agent.retryCount} 次重试（从失败 Skill 恢复）`);
          await new Promise(resolve => setTimeout(resolve, delay));
          // 合并「上一轮恢复来的」与「本轮新完成的」成功结果
          const resume: Record<string, SkillExecutionResult> = { ...resumeFrom };
          for (const [name, result] of Object.entries(skillResults)) {
            if (result?.success) resume[name] = result;
          }
          return this.runAgent(agent, completed, edges, userId, companyProfileOverride, signal, resume);
        }

        this.failAgent(agent, 'AGENT_TIMEOUT', `Agent 执行超时（${agent.timeoutMs}ms，已中止在跑工作）`, true);
        return agent;
      }

      // M0-4：Skill 失败（其粒度重试已用尽）→ Agent 直接失败，不整体重跑
      if (err instanceof SkillFailureError) {
        this.failAgent(agent, err.skillError.code, err.message, err.skillError.retryable);
        return agent;
      }

      // 其他意外错误（executor 抛出异常等）
      this.failAgent(agent, 'AGENT_FAILED', err?.message || '未知错误', false);
      return agent;
    } finally {
      attempt.cleanup();
    }
  }

  /**
   * M0-4：Skill 粒度重试 — 只重试失败的 Skill，成功的 Skill 结果保留在调用方。
   * 规则：result.error.retryable=false → 不重试；可重试 → 抖动退避后重试（最多 maxRetries 次）。
   */
  private async executeSkillWithRetry(
    agent: AgentInstance,
    skillName: string,
    skillInput: Record<string, any>,
    userId?: string,
    companyProfileOverride?: Record<string, any>,
    signal?: AbortSignal
  ): Promise<SkillExecutionResult> {
    let lastResult: SkillExecutionResult | null = null;

    for (let attemptNo = 0; attemptNo <= this.skillRetryPolicy.maxRetries; attemptNo++) {
      if (attemptNo > 0) {
        const delay = jitterDelayMs(attemptNo - 1, this.skillRetryPolicy);
        console.log(`[DAG 调度器] Skill "${skillName}" 失败（可重试），${delay}ms 后第 ${attemptNo} 次重试`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      signal?.throwIfAborted?.();

      const result = await this.executor.execute({
        skillName,
        input: skillInput,
        context: {
          taskId: agent.taskId,
          agentId: agent.agentId,
          userId,
          abortSignal: signal,
          companyProfileOverride,
        },
      });

      if (result.success) return result;
      lastResult = result;
      if (!result.error?.retryable) return result; // 不可重试 → 立即出局
    }

    return lastResult!;
  }

  /** Agent 终态失败：状态 + 持久化 + 事件（M0-4 抽出，消除三处重复） */
  private failAgent(agent: AgentInstance, code: string, message: string, retryable: boolean): void {
    agent.status = 'failed';
    agent.error = { code, message, retryable };
    agent.completedAt = new Date().toISOString();

    agentStore.update(agent.agentId, {
      status: 'failed',
      error: agent.error,
      retryCount: agent.retryCount,
      completedAt: agent.completedAt,
    });

    eventBus.emit('agent.failed', {
      taskId: agent.taskId,
      agentId: agent.agentId,
      name: agent.name,
      error: message,
    });
  }

  /** M0-2：取消单个 Agent（状态 + 持久化 + 事件；不触发重试/失败路径） */
  private cancelAgent(agent: AgentInstance, reason: string): void {
    if (agent.status === 'completed' || agent.status === 'failed' || agent.status === 'cancelled') return;
    agent.status = 'cancelled';
    agent.error = { code: 'TASK_CANCELLED', message: '任务已取消', retryable: false };
    agent.completedAt = new Date().toISOString();

    agentStore.update(agent.agentId, {
      status: 'cancelled',
      error: agent.error,
      completedAt: agent.completedAt,
    });

    eventBus.emit('agent.cancelled', {
      taskId: agent.taskId,
      agentId: agent.agentId,
      name: agent.name,
      reason,
    });
  }

  private injectUpstreamData(
    agent: AgentInstance,
    edges: DependencyEdge[],
    completed: Map<string, AgentInstance>
  ): void {
    const injected: Record<string, any> = {};

    for (const edge of edges) {
      if (edge.to !== agent.agentId) continue;
      const upstream = completed.get(edge.from);
      if (!upstream?.output) continue;

      if (edge.dataMapping) {
        for (const [fromKey, toKey] of Object.entries(edge.dataMapping)) {
          injected[toKey] = upstream.output[fromKey];
        }
      } else {
        Object.assign(injected, upstream.output);
      }
    }

    (agent as any).injectedInput = injected;
  }

  /** FR-I 优雅短路：判断 manifest.empty_when 是否命中 */
  private isOutputEmpty(agent: AgentInstance, manifest?: ParsedSkillManifest | null): boolean {
    if (!manifest?.emptyWhen || manifest.emptyWhen.length === 0) return false;
    const out = agent.output || {};
    for (const cond of manifest.emptyWhen) {
      const value = (out as any)[cond.field];
      switch (cond.op) {
        case 'eq': if (value === cond.value) return true; break;
        case 'neq': if (value !== cond.value) return true; break;
        case 'lt': if (typeof value === 'number' && value < cond.value) return true; break;
        case 'gt': if (typeof value === 'number' && value > cond.value) return true; break;
      }
    }
    return false;
  }

  private findManifestForAgent(agent: AgentInstance): ParsedSkillManifest | null {
    if (!this.registry) return null;
    const skillName = agent.assignedSkills[0];
    if (!skillName) return null;
    return this.registry.getByName(skillName);
  }

  private cascadeSkip(
    agentId: string,
    agents: Map<string, AgentInstance>,
    edges: DependencyEdge[],
    completed: Map<string, AgentInstance>,
    skipped: Set<string>,
    upstreamId: string
  ): void {
    const agent = agents.get(agentId);
    if (!agent || agent.status === 'completed' || agent.status === 'failed') return;
    agent.status = 'cancelled';
    agent.error = {
      code: 'UPSTREAM_EMPTY',
      message: `上游 ${upstreamId} 产物为空，已优雅短路`,
      retryable: false,
    };
    agent.completedAt = new Date().toISOString();
    skipped.add(agentId);
    completed.set(agentId, agent);
    agentStore.update(agentId, {
      status: 'cancelled',
      error: agent.error,
      completedAt: agent.completedAt,
    });
    eventBus.emit('agent.cancelled', {
      taskId: agent.taskId,
      agentId,
      name: agent.name,
      reason: 'upstream_empty',
      upstream: upstreamId,
    });
    // 递归 skip 下游
    for (const e of edges) {
      if (e.from === agentId) {
        this.cascadeSkip(e.to, agents, edges, completed, skipped, agentId);
      }
    }
  }
}
