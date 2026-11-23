import type { DB } from './db.js';
import { getDb } from './db.js';
import type { ChatMessage } from '../providers/types.js';
import { createHash } from 'crypto';

/**
 * M1-5：checkpoint 仓储（checkpoints 表，§4.3）。
 * M1-3 loop 的 sink 落点；Time-Travel（M4-1）从这里读快照。
 *
 * 消息去重存储（006 迁移）：loop_step 每步存全量消息快照时，相邻步的消息数组
 * 90%+ 内容重复（单 run 存储 O(步数²)，实测占库 93%）。因此消息按内容哈希
 * 存入 checkpoint_messages（每 run 一份，run 级联删除），checkpoint 的
 * state_json 只存 mrefs（哈希有序列表）——O(n²) → O(n)。
 * 兼容：内联 messages 的旧格式 get() 原样解析（压实命令负责存量迁移）。
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

/** 单条消息的内容哈希（同一对象在相邻步序列化结果一致 → 命中去重） */
function messageHash(m: ChatMessage): string {
  return createHash('sha256').update(JSON.stringify(m), 'utf-8').digest('hex').slice(0, 40);
}

/** 存量迁移每批读取的 checkpoint 行数（任何时刻内存里只留一批内联消息） */
export const MIGRATE_BATCH = 200;

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
    state: {
      messages?: ChatMessage[];
      vars?: Record<string, unknown>;
      cursor?: string;
      /** 精确重放：模型实际看到的系统提示（loop_step 携带；graph/interrupt 不用） */
      system?: string;
      model?: { model: string; provider?: string; baseUrl?: string; profileId?: string };
      contextOps?: Array<{ step: number; kind: string; reclaimedChars: number; keptMessages: number }>;
    };
  }): void {
    const { messages, ...rest } = input.state;
    // 消息去重：提取到 checkpoint_messages，state 只存引用（graph 的 vars/cursor 等原样保留）
    let stateJson: string;
    if (Array.isArray(messages)) {
      const hashes = messages.map(m => messageHash(m));
      const insMsg = this.stmt(
        `INSERT OR IGNORE INTO checkpoint_messages (run_id, hash, message_json, created_at) VALUES (?, ?, ?, ?)`
      );
      const now = new Date().toISOString();
      const tx = this.db().transaction(() => {
        for (let i = 0; i < messages.length; i++) {
          insMsg.run(input.runId, hashes[i], JSON.stringify(messages[i]), now);
        }
      });
      tx();
      stateJson = JSON.stringify({ mrefs: hashes, ...rest });
    } else {
      stateJson = JSON.stringify(rest);
    }
    this.stmt(
      `INSERT OR REPLACE INTO checkpoints (run_id, seq, kind, label, state_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      input.runId,
      input.seq,
      input.kind,
      input.label ?? null,
      stateJson,
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

  /** 完整快照（Time-Travel 回滚/fork 的数据源，M4-1；system/model 为精确重放字段） */
  get(runId: string, seq: number): {
    messages?: ChatMessage[];
    vars?: Record<string, unknown>;
    cursor?: string;
    system?: string;
    model?: { model: string; provider?: string; baseUrl?: string; profileId?: string };
    contextOps?: Array<{ step: number; kind: string; reclaimedChars: number; keptMessages: number }>;
  } | null {
    const row = this.stmt(
      `SELECT state_json FROM checkpoints WHERE run_id = ? AND seq = ?`
    ).get(runId, seq) as { state_json: string } | undefined;
    if (!row) return null;
    try {
      const state = JSON.parse(row.state_json);
      // 新格式：mrefs → 重组装消息（json_each 保持引用顺序）
      if (Array.isArray(state.mrefs) && state.mrefs.length > 0) {
        const rows = this.stmt(
          `SELECT je.key AS idx, je.value AS hash, m.message_json
           FROM json_each(?) je
           LEFT JOIN checkpoint_messages m ON m.run_id = ? AND m.hash = je.value
           ORDER BY je.key`
        ).all(JSON.stringify(state.mrefs), runId) as Array<{ idx: number; hash: string; message_json: string | null }>;
        const messages: ChatMessage[] = [];
        for (const r of rows) {
          if (r.message_json == null) {
            // 引用缺失（理论上不可能——同事务写入；防御：返回 null 让调用方走兜底）
            return null;
          }
          messages.push(JSON.parse(r.message_json));
        }
        const { mrefs, ...rest } = state;
        return { ...rest, messages };
      }
      // 旧格式：内联 messages 原样（压实命令负责迁移存量）
      return state;
    } catch {
      return null;
    }
  }

  /**
   * 存量迁移：旧内联 messages 格式的 checkpoint 全部改写为去重格式（mrefs）。
   * 由 store/compact.ts 的整体压实流程调用；返回迁移条数。
   *
   * 按主键分批取（keyset 分页）、每批一个事务（REG-42）：
   *  · 此前 .all() 一次性把全部内联 checkpoint（每条带整份消息快照）读进内存 —
   *    最需要压实的库（上 GB、全是内联格式）正是迁移时内存占用最高的时刻；
   *  · 此前每条写入都是独立事务（各落盘一次）：实测 450 条小 checkpoint 就要二十秒。
   * 翻页不会漏也不会重：更新只改已读过的行，迁移后它们不再匹配扫描条件；损坏的行保持原样，
   * 留给人工排查（不会被计成"已迁移"）。
   */
  migrateInlineCheckpoints(): number {
    const db = this.db();
    type LegacyRow = { rowid: number; run_id: string; state_json: string };
    const select = db.prepare(
      `SELECT rowid, run_id, state_json FROM checkpoints WHERE state_json LIKE '%"messages"%' AND rowid > ? ORDER BY rowid LIMIT ?`
    );
    const insMsg = db.prepare(
      `INSERT OR IGNORE INTO checkpoint_messages (run_id, hash, message_json, created_at) VALUES (?, ?, ?, ?)`
    );
    const upd = db.prepare(`UPDATE checkpoints SET state_json = ? WHERE rowid = ?`);
    const now = new Date().toISOString();
    const migrateBatch = db.transaction((rows: LegacyRow[]) => {
      let done = 0;
      for (const r of rows) {
        try {
          const state = JSON.parse(r.state_json);
          if (!Array.isArray(state.messages)) continue;
          const hashes = state.messages.map((m: ChatMessage) => messageHash(m));
          for (let i = 0; i < state.messages.length; i++) {
            insMsg.run(r.run_id, hashes[i], JSON.stringify(state.messages[i]), now);
          }
          const { messages, ...rest } = state;
          upd.run(JSON.stringify({ mrefs: hashes, ...rest }), r.rowid);
          done++;
        } catch { /* 单条损坏跳过（不阻塞整轮） */ }
      }
      return done;
    });

    let migrated = 0;
    let lastRowid = 0;
    for (;;) {
      const rows = select.all(lastRowid, MIGRATE_BATCH) as LegacyRow[];
      if (rows.length === 0) break;
      migrated += migrateBatch(rows);
      lastRowid = rows[rows.length - 1].rowid;
      if (rows.length < MIGRATE_BATCH) break;
    }
    return migrated;
  }
}
