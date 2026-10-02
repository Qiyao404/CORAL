import { nanoid } from 'nanoid';
import type { DB } from './db.js';
import { getDb } from './db.js';

/**
 * M1-5：run 事件仓储（events 表，§4.4 事件溯源）。
 * 每 run 内 seq 单调递增（由 run-engine 维护计数器）；支持 afterSeq 增量分页（M1-9）。
 */

export interface RunEventRow {
  id: string;
  run_id: string;
  seq: number;
  type: string;
  agent_id: string | null;
  tool_name: string | null;
  payload_json: string;
  created_at: string;
}

export interface RunEvent {
  eventId: string;
  runId: string;
  seq: number;
  type: string;
  agentId?: string | null;
  toolName?: string | null;
  payload: Record<string, any>;
  timestamp: string;
}

export class RunEventStore {
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
    type: string;
    agentId?: string;
    toolName?: string;
    payload?: Record<string, any>;
    timestamp?: string;
  }): RunEvent {
    const event: RunEvent = {
      eventId: nanoid(),
      runId: input.runId,
      seq: input.seq,
      type: input.type,
      agentId: input.agentId ?? null,
      toolName: input.toolName ?? null,
      payload: input.payload ?? {},
      timestamp: input.timestamp ?? new Date().toISOString(),
    };
    this.stmt(
      `INSERT INTO events (id, run_id, seq, type, agent_id, tool_name, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.eventId,
      event.runId,
      event.seq,
      event.type,
      event.agentId,
      event.toolName,
      JSON.stringify(event.payload),
      event.timestamp
    );
    return event;
  }

  /** 按 seq 升序；afterSeq 增量拉取（断线续传游标） */
  listByRun(runId: string, afterSeq = 0, limit = 500): RunEvent[] {
    const rows = this.stmt(
      `SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`
    ).all(runId, afterSeq, Math.min(limit, 2000)) as RunEventRow[];
    return rows.map(r => this.fromRow(r));
  }

  countByRun(runId: string): number {
    const row = this.stmt(`SELECT COUNT(*) AS n FROM events WHERE run_id = ?`).get(runId) as any;
    return row.n;
  }

  /** run 内当前最大 seq（断点恢复/校准用） */
  maxSeq(runId: string): number {
    const row = this.stmt(`SELECT MAX(seq) AS m FROM events WHERE run_id = ?`).get(runId) as any;
    return row.m ?? 0;
  }

  private fromRow(r: RunEventRow): RunEvent {
    return {
      eventId: r.id,
      runId: r.run_id,
      seq: r.seq,
      type: r.type,
      agentId: r.agent_id,
      toolName: r.tool_name,
      payload: safeParse(r.payload_json),
      timestamp: r.created_at,
    };
  }
}

function safeParse(s: string): Record<string, any> {
  try {
    return JSON.parse(s) ?? {};
  } catch {
    return {};
  }
}
