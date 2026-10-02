import type { DB } from './db.js';
import { getDb } from './db.js';
import type { ChatMessage } from '../providers/types.js';

/**
 * M1-5：checkpoint 仓储（checkpoints 表，§4.3）。
 * M1-3 loop 的 sink 落点；Time-Travel（M4-1）从这里读快照。
 */

export interface CheckpointRow {
  run_id: string;
  seq: number;
  kind: 'loop_step' | 'graph_node' | 'interrupt';
  label: string | null;
  state_json: string;
  created_at: string;
}

export interface CheckpointMeta {
  runId: string;
  seq: number;
  kind: string;
  label: string | null;
  createdAt: string;
}

export class CheckpointStore {
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
    runId: string;
    seq: number;
    kind: 'loop_step' | 'graph_node' | 'interrupt';
    label?: string;
    state: { messages?: ChatMessage[]; vars?: Record<string, unknown>; cursor?: string };
  }): void {
    this.stmt(
      `INSERT OR REPLACE INTO checkpoints (run_id, seq, kind, label, state_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      input.runId,
      input.seq,
      input.kind,
      input.label ?? null,
      JSON.stringify(input.state),
      new Date().toISOString()
    );
  }

  /** 元数据列表（不含 state — 详情单独取，避免大 payload） */
  listByRun(runId: string): CheckpointMeta[] {
    const rows = this.stmt(
      `SELECT run_id, seq, kind, label, created_at FROM checkpoints WHERE run_id = ? ORDER BY seq`
    ).all(runId) as any[];
    return rows.map(r => ({
      runId: r.run_id,
      seq: r.seq,
      kind: r.kind,
      label: r.label,
      createdAt: r.created_at,
    }));
  }

  /** 完整快照（Time-Travel 回滚/fork 的数据源，M4-1） */
  get(runId: string, seq: number): { messages?: ChatMessage[]; vars?: Record<string, unknown>; cursor?: string } | null {
    const row = this.stmt(
      `SELECT state_json FROM checkpoints WHERE run_id = ? AND seq = ?`
    ).get(runId, seq) as { state_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.state_json);
    } catch {
      return null;
    }
  }
}
