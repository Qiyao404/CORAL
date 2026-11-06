/**
 * Teams — 多代理协作内核（run 级作用域）。
 *
 * 三个原语：
 *  · 任务板（task board）：带 revision 乐观锁的共享任务 DAG（blockedBy 无环校验），
 *    writeScopes 概念以"重叠警告"呈现（提示性，不锁）
 *  · 邮箱（mailbox）：代理间直接消息；投递语义 = 步边界（Step-boundary Steer）—
 *    运行中的代理在下一轮请求前收到（不丢、不打断当前步骤），由 AgentLoop 的
 *    pollInbox 钩子在压缩之后、请求组装之前排空
 *  · 运行注册表（roster）：teammate 名字永久占用（含失败的，不复用），
 *    后台执行句柄与终态结果可查询（wait 用）
 *
 * 边界（防失控开团）：成员 ≤16 / 任务 ≤256 / 单消息 ≤16KB。
 * 持久化：全量事件（team.*）进 run 事件流（TimeTravel 可回放）；内存态随 run 结束回收。
 */

export interface TeamTask {
  id: string;
  revision: number;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  owner?: string;
  blockedBy: string[];
}

export interface TeamMessage {
  from: string;
  content: string;
  ts: number;
}

export interface TeammateHandle {
  name: string;
  agentId: string;
  status: 'running' | 'completed' | 'failed';
  result?: { status: string; finalContent: string; steps?: number; tokensIn?: number; tokensOut?: number };
}

export const TEAM_LIMITS = {
  maxTeammates: 16,
  maxTasks: 256,
  maxMessageChars: 16_000,
} as const;

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,23}$/;

export class TeamService {
  private tasks: TeamTask[] = [];
  private nextTaskId = 1;
  private usedNames = new Set<string>(['main']);
  private teammates = new Map<string, TeammateHandle>();
  private inboxes = new Map<string, TeamMessage[]>();
  // Watchdog：整队 token 账本（全部 teammate 累计；主循环预算独立）
  private tokensUsed = 0;
  private budgetWarned = false;

  constructor(
    private runId: string,
    private emit: (ev: { type: string; payload?: Record<string, any> }) => void,
    /** 整队 token 上限（缺省 1000 万 = 平台默认 run 预算量级；Infinity = 不限） */
    private budgetTokens: number = 10_000_000,
  ) {}

  /** Watchdog 闸门：新 spawn 前检查整队预算；80% 预警一次性，100% 拒绝 */
  checkSpawnTokens(): { ok: true; warn?: boolean } | { ok: false; reason: string } {
    if (this.budgetTokens === Infinity || this.tokensUsed < this.budgetTokens) {
      const warn = !this.budgetWarned && this.budgetTokens !== Infinity && this.tokensUsed >= this.budgetTokens * 0.8;
      if (warn) {
        this.budgetWarned = true;
        this.emit({
          type: 'team.budget_warning',
          payload: { usedTokens: this.tokensUsed, budgetTokens: this.budgetTokens, pct: Math.round((this.tokensUsed / this.budgetTokens) * 100) },
        });
      }
      return { ok: true, ...(warn ? { warn } : {}) };
    }
    return {
      ok: false,
      reason: `整队 token 预算已耗尽（${this.tokensUsed} / ${this.budgetTokens}）— 先用 team_wait 收割已完成队友的结果，避免继续扩大并行`,
    };
  }

  teamUsage(): { usedTokens: number; budgetTokens: number } {
    return { usedTokens: this.tokensUsed, budgetTokens: this.budgetTokens };
  }

  // ─── 成员注册表 ─────────────────────────────────────────────

  /** 名字合法性 + 永久占用（失败也占用，永不复用 — 避免身份混淆） */
  claimName(name: string): { ok: true } | { ok: false; error: string } {
    const n = String(name ?? '').trim().toLowerCase();
    if (!NAME_RE.test(n)) {
      return { ok: false, error: `名字须为 2-24 位小写字母/数字/-/_（收到 "${n}"）` };
    }
    if (this.usedNames.has(n)) {
      return { ok: false, error: `名字 "${n}" 已被占用（含已结束的 teammate — 名字不复用）` };
    }
    if (this.usedNames.size - 1 >= TEAM_LIMITS.maxTeammates) { // 减去内置 'main'
      return { ok: false, error: `teammate 数量已达上限（${TEAM_LIMITS.maxTeammates}）` };
    }
    this.usedNames.add(n);
    return { ok: true };
  }

  registerTeammate(name: string, agentId: string): void {
    this.teammates.set(name, { name, agentId, status: 'running' });
    this.emit({ type: 'team.teammate_started', payload: { name, agentId } });
  }

  settleTeammate(name: string, status: 'completed' | 'failed', result?: TeammateHandle['result']): void {
    const t = this.teammates.get(name);
    if (!t) return;
    t.status = status;
    t.result = result;
    // Watchdog 账本：teammate 终态时把 token 消耗计入整队预算
    if (result?.tokensIn || result?.tokensOut) {
      this.tokensUsed += (result.tokensIn ?? 0) + (result.tokensOut ?? 0);
    }
    this.emit({
      type: status === 'completed' ? 'team.teammate_completed' : 'team.teammate_failed',
      payload: {
        name, agentId: t.agentId,
        ...(result ? { status: result.status, steps: result.steps } : {}),
        ...(this.budgetTokens !== Infinity ? { teamTokensUsed: this.tokensUsed } : {}),
      },
    });
  }

  listTeammates(): Array<TeammateHandle & { undelivered: number }> {
    return [...this.teammates.values()].map(t => ({
      ...t,
      undelivered: this.inboxes.get(t.agentId)?.length ?? 0,
    }));
  }

  getTeammate(name: string): TeammateHandle | undefined {
    return this.teammates.get(name);
  }

  // ─── 邮箱（步边界投递） ─────────────────────────────────────

  /** 发送：目标为 teammate 名或 'main'（主循环）。存入目标 agentId 的收件箱。 */
  send(from: string, to: string, content: string): { ok: true; queued: true } | { ok: false; error: string } {
    const text = String(content ?? '').trim();
    if (!text) return { ok: false, error: 'content 不能为空' };
    if (text.length > TEAM_LIMITS.maxMessageChars) {
      return { ok: false, error: `消息过长（${text.length}，上限 ${TEAM_LIMITS.maxMessageChars}）` };
    }
    const targetName = String(to ?? '').trim().toLowerCase();
    let agentId: string;
    if (targetName === 'main') {
      agentId = 'main';
    } else {
      const t = this.teammates.get(targetName);
      if (!t) {
        const known = ['main', ...this.teammates.keys()].join(', ');
        return { ok: false, error: `目标 "${to}" 不存在（当前成员: ${known}）` };
      }
      agentId = t.agentId;
    }
    const box = this.inboxes.get(agentId) ?? [];
    box.push({ from, content: text, ts: Date.now() });
    this.inboxes.set(agentId, box);
    this.emit({ type: 'team.message_queued', payload: { from, to: targetName, agentId, chars: text.length } });
    return { ok: true, queued: true };
  }

  /** 排空收件箱（AgentLoop 每步调用 — 步边界投递的取件端） */
  drain(agentId: string): TeamMessage[] {
    const box = this.inboxes.get(agentId);
    if (!box || box.length === 0) return [];
    this.inboxes.set(agentId, []);
    return box;
  }

  // ─── 任务板（CAS + DAG） ────────────────────────────────────

  createTask(input: { subject: string; description?: string; blockedBy?: string[]; owner?: string }): { ok: true; task: TeamTask } | { ok: false; error: string } {
    const subject = String(input.subject ?? '').trim();
    if (!subject) return { ok: false, error: 'subject 不能为空' };
    if (this.tasks.length >= TEAM_LIMITS.maxTasks) {
      return { ok: false, error: `任务数已达上限（${TEAM_LIMITS.maxTasks}）` };
    }
    const blockedBy = (Array.isArray(input.blockedBy) ? input.blockedBy : [])
      .map(String)
      .filter(b => b && b !== 'none');
    // 引用存在性：blockedBy 必须指向已知任务
    const known = new Set(this.tasks.map(t => t.id));
    const unknown = blockedBy.filter(b => !known.has(b));
    if (unknown.length > 0) {
      return { ok: false, error: `blockedBy 引用了不存在的任务: ${unknown.join(', ')}` };
    }
    const task: TeamTask = {
      id: `t${this.nextTaskId++}`,
      revision: 1,
      subject: subject.slice(0, 200),
      description: String(input.description ?? '').slice(0, 2000),
      status: 'pending',
      blockedBy,
      ...(input.owner ? { owner: String(input.owner) } : {}),
    };
    if (this.wouldCycle(task.id, task.blockedBy)) {
      return { ok: false, error: 'blockedBy 会形成环（任务图必须无环）' };
    }
    this.tasks.push(task);
    this.emit({ type: 'team.task_created', payload: { id: task.id, subject: task.subject, blockedBy: task.blockedBy } });
    return { ok: true, task };
  }

  updateTask(input: {
    id: string;
    expectedRevision?: number;
    status?: 'pending' | 'in_progress' | 'completed' | 'deleted';
    owner?: string | null;
    description?: string;
    addBlockedBy?: string[];
  }): { ok: true; task: TeamTask } | { ok: false; error: string } {
    const task = this.tasks.find(t => t.id === input.id);
    if (!task) return { ok: false, error: `任务 ${input.id} 不存在` };
    if (typeof input.expectedRevision === 'number' && input.expectedRevision !== task.revision) {
      return { ok: false, error: `版本冲突：任务 ${task.id} 当前 revision=${task.revision}（你基于 ${input.expectedRevision}）— 请重读后再改` };
    }
    if (input.status) {
      const order = ['pending', 'in_progress', 'completed', 'deleted'];
      if (!order.includes(input.status)) return { ok: false, error: `非法状态: ${input.status}` };
      task.status = input.status;
    }
    if (input.owner !== undefined) {
      if (input.owner === null) delete task.owner;
      else task.owner = String(input.owner);
    }
    if (typeof input.description === 'string') task.description = input.description.slice(0, 2000);
    if (Array.isArray(input.addBlockedBy) && input.addBlockedBy.length > 0) {
      const known = new Set(this.tasks.map(t => t.id));
      const unknown = input.addBlockedBy.map(String).filter(b => !known.has(b));
      if (unknown.length > 0) return { ok: false, error: `addBlockedBy 引用了不存在的任务: ${unknown.join(', ')}` };
      const merged = [...new Set([...task.blockedBy, ...input.addBlockedBy.map(String)])];
      if (this.wouldCycle(task.id, merged)) {
        return { ok: false, error: '新增依赖会形成环（任务图必须无环）' };
      }
      task.blockedBy = merged;
    }
    task.revision++;
    this.emit({ type: 'team.task_updated', payload: { id: task.id, revision: task.revision, status: task.status, owner: task.owner } });
    return { ok: true, task };
  }

  /** 视图：含就绪态派生（blockedBy 全部 completed 才 ready） */
  listTasks(): Array<TeamTask & { ready: boolean; blockersPending: string[] }> {
    const byId = new Map(this.tasks.map(t => [t.id, t]));
    return this.tasks
      .filter(t => t.status !== 'deleted')
      .map(t => {
        const blockersPending = t.blockedBy
          .map(b => byId.get(b))
          .filter(b => b && b.status !== 'completed')
          .map(b => b!.id);
        return { ...t, ready: blockersPending.length === 0, blockersPending };
      });
  }

  /** 等待：轮询直到指定成员全部终态或超时（team_wait 工具的数据源） */
  async wait(names: string[], timeoutMs: number): Promise<Array<TeammateHandle>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const handles = names.map(n => this.teammates.get(n)).filter(Boolean) as TeammateHandle[];
      const settled = handles.every(h => h.status !== 'running');
      if (settled || Date.now() >= deadline) return handles;
      await new Promise(r => setTimeout(r, 400));
    }
  }

  /** 新依赖是否会成环：从候选边出发 DFS，能否走回自己 */
  private wouldCycle(selfId: string, blockedBy: string[]): boolean {
    const edges = new Map<string, string[]>();
    for (const t of this.tasks) edges.set(t.id, t.blockedBy);
    edges.set(selfId, blockedBy); // 假设变更已生效
    const seen = new Set<string>();
    const stack = [...blockedBy];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === selfId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(edges.get(cur) ?? []));
    }
    return false;
  }
}
