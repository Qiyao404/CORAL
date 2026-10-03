import type { DB } from './db.js';
import { getDb } from './db.js';
import { nanoid } from 'nanoid';

/**
 * M1-5：runs 表仓储（v2 Free 模式运行记录）。
 * 002 迁移后含 session_id（D17 多会话）/ final_content / end_reason。
 */

export type RunStatus = 'created' | 'running' | 'waiting_human' | 'completed' | 'failed' | 'cancelled';
export type RunMode = 'free' | 'graph';

export interface RunRow {
  id: string;
  goal: string;
  mode: RunMode;
  status: RunStatus;
  session_id: string | null;
  parent_run_id: string | null;
  fork_from_seq: number | null;
  graph_json: string | null;
  model_profile_id: string | null;
  budget_json: string | null;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  error_json: string | null;
  final_content: string | null;
  end_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type Run = Omit<RunRow, 'budget_json' | 'error_json' | 'graph_json'> & {
  budget?: Record<string, any> | null;
  error?: Record<string, any> | null;
  graph?: Record<string, any> | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

export class RunStore {
  private dbProvider: () => DB;
  private cachedDb: DB | null = null;
  private stmts = new Map<string, import('better-sqlite3').Statement>();

  constructor(dbProvider: () => DB = getDb) {
    this.dbProvider = dbProvider;
  }

  private db(): DB {
    const db = this.dbProvider();
    if (db !== this.cachedDb) {
      this.stmts.clear();
      this.cachedDb = db;
    }
    return db;
  }

  private stmt(sql: string): import('better-sqlite3').Statement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db().prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  insert(input: {
    id: string;
    goal: string;
    mode: RunMode;
    sessionId?: string;
    budget?: Record<string, any>;
    modelProfileId?: string;
  }): void {
    const ts = nowIso();
    this.stmt(
      `INSERT INTO runs (id, goal, mode, status, session_id, budget_json, model_profile_id, cost_usd, tokens_in, tokens_out, created_at, updated_at)
       VALUES (?, ?, ?, 'created', ?, ?, ?, 0, 0, 0, ?, ?)`
    ).run(
      input.id,
      input.goal,
      input.mode,
      input.sessionId ?? null,
      input.budget ? JSON.stringify(input.budget) : null,
      input.modelProfileId ?? null,
      ts,
      ts
    );
  }

  get(id: string): Run | null {
    const row = this.stmt(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  update(id: string, partial: {
    status?: RunStatus;
    finalContent?: string;
    endReason?: string;
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
    error?: Record<string, any>;
  }): Run | null {
    const existing = this.get(id);
    if (!existing) return null;
    const ts = nowIso();
    this.stmt(
      `UPDATE runs SET status = ?, final_content = ?, end_reason = ?, tokens_in = ?, tokens_out = ?,
       cost_usd = ?, error_json = ?, updated_at = ?, completed_at = CASE WHEN ? IN ('completed','failed','cancelled') THEN COALESCE(completed_at, ?) ELSE completed_at END
       WHERE id = ?`
    ).run(
      partial.status ?? existing.status,
      partial.finalContent ?? existing.final_content ?? null,
      partial.endReason ?? existing.end_reason ?? null,
      partial.tokensIn ?? existing.tokens_in,
      partial.tokensOut ?? existing.tokens_out,
      partial.costUsd ?? existing.cost_usd,
      partial.error !== undefined ? (partial.error ? JSON.stringify(partial.error) : null) : (existing.error ? JSON.stringify(existing.error) : null),
      ts,
      partial.status ?? existing.status,
      ts,
      id
    );
    return this.get(id);
  }

  list(filter: { sessionId?: string; status?: string; limit?: number; offset?: number } = {}): { total: number; items: Run[] } {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.sessionId) {
      where.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.stmt(`SELECT COUNT(*) AS n FROM runs ${whereSql}`).get(...params) as any).n;
    const limit = Math.min(filter.limit ?? 50, 200);
    const offset = filter.offset ?? 0;
    const rows = this.stmt(
      `SELECT * FROM runs ${whereSql} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as RunRow[];
    return { total, items: rows.map(r => this.fromRow(r)) };
  }

  /** 删除 run（events/checkpoints 由外键级联清除）；不存在返回 false */
  delete(id: string): boolean {
    const info = this.stmt('DELETE FROM runs WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /** 删除整个会话（D17）— 按 session_id 批量删除，返回删除数量 */
  deleteSession(sessionId: string): number {
    const info = this.stmt('DELETE FROM runs WHERE session_id = ?').run(sessionId);
    return info.changes;
  }

  private fromRow(r: RunRow): Run {
    const { budget_json, error_json, graph_json, ...rest } = r;
    return {
      ...rest,
      budget: budget_json ? safeParse(budget_json) : null,
      error: error_json ? safeParse(error_json) : null,
      graph: graph_json ? safeParse(graph_json) : null,
    };
  }
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function newRunId(): string {
  return `r_${nanoid(12)}`;
}
