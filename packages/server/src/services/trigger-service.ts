import { getDb } from '../store/db.js';
import { nanoid } from 'nanoid';

/**
 * M3-5：TriggerService — 个人 agent 的自动化入口（D21）。
 *
 *  · schedules 表三种子：interval（每 N 秒）/ cron（5 段）/ webhook（POST /api/hooks/:id）
 *  · action：{ mode: 'free', goal } 或 { mode: 'graph', graph: <yaml>, goal?, workspaceId? }
 *    — fire 即创建 run（执行交给 RunEngine/GraphRunService，服务本身不执行）
 *  · 调度循环：60s 一拍扫 due 的 interval/cron（时间驱动天然周期检查，非 v1 的忙等轮询）；
 *    webhook 由路由直接 fire（带 body 注入 goal 模板）
 *  · 安全：webhook id 是不可枚举的 nanoid；触发记录 fire_count/last_fired_at/last_error
 */

export type TriggerKind = 'interval' | 'cron' | 'webhook';

export interface TriggerAction {
  mode: 'free' | 'graph';
  goal: string;
  graph?: string;      // mode=graph 时的 YAML
  workspaceId?: string;
}

export interface ScheduleRow {
  id: string;
  name: string;
  enabled: number;
  kind: TriggerKind;
  spec: string;         // interval: 秒数；cron: 表达式；webhook: 空
  action_json: string;
  last_fired_at: string | null;
  next_fire_at: string | null;
  fire_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface FireContext {
  /** RunEngine.startRun（free）与 GraphRunService.startGraphRun（graph） */
  startRun: (action: TriggerAction, vars: Record<string, any>) => Promise<{ runId: string }>;
}

function nowIso() { return new Date().toISOString(); }
function stmt(sql: string) { return getDb().prepare(sql); }

/** cron 5 段（分 时 日 月 周）→ 下一触发时间；支持 * / 数字 , - （够用的子集，无 L W 等扩展） */
export function nextCronTime(expr: string, from = new Date()): Date | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const fields = parts.map((p, i) => parseField(p, ranges[i]));
  if (fields.some(f => f === null)) return null;

  // 从下一分钟开始逐分钟前进（上限 366 天 — 个人调度足够）
  // 日(DOM)与周(DOW)字段：标准 cron 语义 — 两者都受限(*)时取 OR；其一受限时取 AND
  const domRestricted = !fields[2]!.has(0) || !fields[2]!.has(31) || fields[2]!.size < 31;
  const dowRestricted = fields[4]!.size < 7;
  const useOr = domRestricted && dowRestricted;
  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const dom = fields[2]!.has(t.getDate());
    const dow = fields[4]!.has(t.getDay());
    const dayMatch = useOr ? (dom || dow) : (dom && dow);
    if (
      fields[0]!.has(t.getMinutes()) &&
      fields[1]!.has(t.getHours()) &&
      fields[3]!.has(t.getMonth() + 1) &&
      dayMatch
    ) return t;
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

function parseField(field: string, [lo, hi]: [number, number]): Set<number> | null {
  const out = new Set<number>();
  for (const chunk of field.split(',')) {
    const m = chunk.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    const [, base, stepStr] = m;
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (step < 1) return null;
    let start = lo, end = hi;
    if (base !== '*') {
      const [a, b] = base.split('-').map(Number);
      start = b !== undefined ? a : a;
      end = b !== undefined ? b : a;
      if (start < lo || end > hi || start > end) return null;
    }
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return out;
}

export class TriggerService {
  private ctx: FireContext | null = null;
  private timer: NodeJS.Timeout | null = null;

  /** 注入 run 启动器（index.ts 接线时调用 — 服务不依赖具体引擎） */
  bind(ctx: FireContext): void {
    this.ctx = ctx;
  }

  startLoop(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stopLoop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ─── CRUD ───

  list(): ScheduleRow[] {
    return stmt(`SELECT * FROM schedules ORDER BY created_at DESC`).all() as ScheduleRow[];
  }

  get(id: string): ScheduleRow | null {
    return (stmt(`SELECT * FROM schedules WHERE id = ?`).get(id) as ScheduleRow) ?? null;
  }

  create(input: {
    name: string;
    kind: TriggerKind;
    spec: string;
    action: TriggerAction;
  }): { ok: boolean; message: string; schedule?: ScheduleRow } {
    if (!input.name?.trim()) return { ok: false, message: '名称必填' };
    // 校验 spec
    if (input.kind === 'interval') {
      const sec = parseInt(input.spec, 10);
      if (!Number.isInteger(sec) || sec < 60) return { ok: false, message: 'interval 须为 ≥60 的整数秒（防误配高频）' };
    } else if (input.kind === 'cron') {
      if (!nextCronTime(input.spec)) return { ok: false, message: 'cron 表达式非法（5 段：分 时 日 月 周，支持 * , - /）' };
    } else if (input.kind === 'webhook') {
      // spec 留空（id 即密钥）
    }
    if (!input.action?.goal?.trim()) return { ok: false, message: 'action.goal 必填' };
    if (input.action.mode === 'graph' && !input.action.graph?.trim()) {
      return { ok: false, message: 'graph 模式需要 action.graph（YAML）' };
    }

    const id = input.kind === 'webhook' ? `hook_${nanoid(12)}` : `sch_${nanoid(10)}`;
    const ts = nowIso();
    const next = this.computeNext(input.kind, input.spec);
    stmt(`INSERT INTO schedules (id, name, enabled, kind, spec, action_json, next_fire_at, created_at, updated_at)
          VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`).run(
      id, input.name.trim(), input.kind,
      input.kind === 'webhook' ? '' : input.spec,
      JSON.stringify(input.action),
      next ? next.toISOString() : null, ts, ts
    );
    return { ok: true, message: `已创建 ${id}`, schedule: this.get(id)! };
  }

  setEnabled(id: string, enabled: boolean): { ok: boolean; message: string } {
    const row = this.get(id);
    if (!row) return { ok: false, message: '触发器不存在' };
    const next = enabled ? this.computeNext(row.kind, row.spec) : null;
    stmt(`UPDATE schedules SET enabled = ?, next_fire_at = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, next ? next.toISOString() : null, nowIso(), id);
    return { ok: true, message: enabled ? '已启用' : '已停用' };
  }

  remove(id: string): { ok: boolean; message: string } {
    const info = stmt(`DELETE FROM schedules WHERE id = ?`).run(id);
    return info.changes > 0 ? { ok: true, message: '已删除' } : { ok: false, message: '触发器不存在' };
  }

  // ─── 触发 ───

  /** 调度循环一拍：扫 due 的 interval/cron 并 fire */
  async tick(now = new Date()): Promise<number> {
    if (!this.ctx) return 0;
    const due = (stmt(`SELECT * FROM schedules WHERE enabled = 1 AND kind IN ('interval','cron') AND next_fire_at IS NOT NULL AND next_fire_at <= ?`)
      .all(now.toISOString()) as ScheduleRow[]);
    let fired = 0;
    for (const row of due) {
      const ok = await this.fire(row, {});
      if (ok) fired++;
    }
    return fired;
  }

  /** webhook 入站：POST /api/hooks/:id → fire（body 变量注入 goal 模板） */
  async fireWebhook(id: string, body: Record<string, any>): Promise<{ ok: boolean; message: string; runId?: string }> {
    const row = this.get(id);
    if (!row || row.kind !== 'webhook') return { ok: false, message: 'webhook 不存在' };
    if (!row.enabled) return { ok: false, message: 'webhook 已停用' };
    const runId = await this.fire(row, { body });
    return runId
      ? { ok: true, message: '已触发', runId }
      : { ok: false, message: row.last_error ?? '触发失败' };
  }

  private async fire(row: ScheduleRow, vars: Record<string, any>): Promise<string | null> {
    if (!this.ctx) return null;
    try {
      const action = JSON.parse(row.action_json) as TriggerAction;
      // webhook body 变量：goal 里的 {{key}} 替换（浅层字符串替换即可）
      let goal = action.goal;
      for (const [k, v] of Object.entries(vars.body ?? {})) {
        goal = goal.split(`{{${k}}}`).join(typeof v === 'string' ? v : JSON.stringify(v));
      }
      const { runId } = await this.ctx.startRun({ ...action, goal }, vars);
      const next = this.computeNext(row.kind, row.spec);
      stmt(`UPDATE schedules SET last_fired_at = ?, next_fire_at = ?, fire_count = fire_count + 1, last_error = NULL, updated_at = ? WHERE id = ?`)
        .run(nowIso(), next ? next.toISOString() : null, nowIso(), row.id);
      return runId;
    } catch (err: any) {
      stmt(`UPDATE schedules SET last_error = ?, updated_at = ? WHERE id = ?`)
        .run(String(err?.message ?? err).slice(0, 500), nowIso(), row.id);
      return null;
    }
  }

  private computeNext(kind: TriggerKind, spec: string): Date | null {
    if (kind === 'interval') {
      const sec = parseInt(spec, 10);
      return Number.isInteger(sec) ? new Date(Date.now() + sec * 1000) : null;
    }
    if (kind === 'cron') return nextCronTime(spec);
    return null; // webhook 由入站驱动
  }
}
