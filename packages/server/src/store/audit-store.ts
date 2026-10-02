import type { DB } from './db.js';
import { getDb } from './db.js';
import type { CoralEvent } from '../types/index.js';

/**
 * 审计事件存储（audit_events 表）— 替代 v1 的 audit_logs.json。
 * 事件总线每条非易失事件一次 INSERT（增量写入），按 task_id/type 建索引查询。
 */
export class AuditEventStore {
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

  insert(event: CoralEvent): void {
    this.stmt(
      `INSERT OR REPLACE INTO audit_events (id, task_id, type, json, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(
      event.eventId,
      event.taskId ?? null,
      event.type,
      JSON.stringify(event),
      event.timestamp ?? new Date().toISOString()
    );
  }

  /** 按任务查询（走 task_id 索引），按时间升序 */
  findByTaskId(taskId: string): CoralEvent[] {
    const rows = this.stmt(
      `SELECT json FROM audit_events WHERE task_id = ? ORDER BY created_at, rowid`
    ).all(taskId) as Array<{ json: string }>;
    return rows.map(r => JSON.parse(r.json) as CoralEvent);
  }

  /** 按类型前缀查询（如 'task.' / 'skill.'） */
  findByTypePrefix(typePrefix: string, limit = 200): CoralEvent[] {
    const rows = this.stmt(
      `SELECT json FROM audit_events WHERE type LIKE ? ORDER BY created_at DESC, rowid DESC LIMIT ?`
    ).all(`${typePrefix}%`, limit) as Array<{ json: string }>;
    return rows.reverse().map(r => JSON.parse(r.json) as CoralEvent);
  }

  find(predicate: (e: CoralEvent) => boolean): CoralEvent[] {
    const rows = this.stmt(`SELECT json FROM audit_events ORDER BY rowid`).all() as Array<{ json: string }>;
    return rows.map(r => JSON.parse(r.json) as CoralEvent).filter(predicate);
  }

  count(): number {
    const row = this.stmt(`SELECT COUNT(*) AS n FROM audit_events`).get() as { n: number };
    return row.n;
  }
}
