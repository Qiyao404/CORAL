import type { DB } from './db.js';
import { getDb } from './db.js';

/** 表名/列名只允许小写字母与下划线（防标识符注入；表名均来自本文件常量） */
const IDENT = /^[a-z_]+$/;

interface SqliteStoreOptions {
  /** db 提供者（默认进程单例；测试可注入临时库） */
  dbProvider?: () => DB;
  /** 从 item 提取创建时间的字段名（用于 created_at 索引列），默认 createdAt */
  createdAtKey?: string;
  /** 从 item 提取更新时间的字段名（用于 updated_at 列），默认 updatedAt */
  updatedAtKey?: string;
}

/**
 * 通用 JSON 文档表存储（id + json 两列 + 索引列）。
 * API 与 v1 JsonStore 对齐（insert/update/get/getAll/find/delete/count/clear），
 * 区别：每次写即持久（WAL），无 flush 定时器，无全量重写。
 * 表结构由 store/migrations 管理，本类不建表（找不到表时抛出明确错误）。
 */
export class SqliteStore<T extends Record<string, any>> {
  private table: string;
  private primaryKey: string;
  private dbProvider: () => DB;
  private createdAtKey: string;
  private updatedAtKey: string;

  /** 语句缓存 — db 实例变化时（测试场景）自动失效 */
  private cachedDb: DB | null = null;
  private stmts = new Map<string, import('better-sqlite3').Statement>();

  constructor(table: string, primaryKey: string, options: SqliteStoreOptions = {}) {
    if (!IDENT.test(table)) throw new Error(`非法表名: ${table}`);
    this.table = table;
    this.primaryKey = primaryKey;
    this.dbProvider = options.dbProvider ?? getDb;
    this.createdAtKey = options.createdAtKey ?? 'createdAt';
    this.updatedAtKey = options.updatedAtKey ?? 'updatedAt';

    const exists = this.db().prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`
    ).get(this.table);
    if (!exists) {
      throw new Error(`表 "${this.table}" 不存在 — 请先在 store/migrations 中定义`);
    }
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

  private now(): string {
    return new Date().toISOString();
  }

  /** 插入或整体替换（与 v1 JsonStore.insert 的 Map.set 语义一致） */
  insert(item: T): void {
    const id = item[this.primaryKey];
    if (id === undefined || id === null) {
      throw new Error(`insert 失败: 缺少主键字段 "${this.primaryKey}"`);
    }
    const createdAt = item[this.createdAtKey] ?? this.now();
    const updatedAt = item[this.updatedAtKey] ?? createdAt;
    this.stmt(
      `INSERT OR REPLACE INTO ${this.table} (id, json, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run(String(id), JSON.stringify(item), createdAt ?? null, updatedAt ?? null);
  }

  /** 部分更新（读-合并-写回），键不存在返回 null */
  update(key: string, partial: Partial<T>): T | null {
    const existing = this.get(key);
    if (!existing) return null;
    const updated: T = { ...existing, ...partial };
    Object.assign(updated, {
      [this.updatedAtKey]: (partial as any)[this.updatedAtKey] ?? this.now(),
    });
    this.insert(updated);
    return updated;
  }

  get(key: string): T | null {
    const row = this.stmt(`SELECT json FROM ${this.table} WHERE id = ?`).get(String(key)) as
      | { json: string }
      | undefined;
    return row ? JSON.parse(row.json) : null;
  }

  getAll(): T[] {
    const rows = this.stmt(`SELECT json FROM ${this.table} ORDER BY rowid`).all() as Array<{ json: string }>;
    return rows.map(r => JSON.parse(r.json));
  }

  find(predicate: (item: T) => boolean): T[] {
    return this.getAll().filter(predicate);
  }

  delete(key: string): boolean {
    const info = this.stmt(`DELETE FROM ${this.table} WHERE id = ?`).run(String(key));
    return info.changes > 0;
  }

  count(): number {
    const row = this.stmt(`SELECT COUNT(*) AS n FROM ${this.table}`).get() as { n: number };
    return row.n;
  }

  clear(): void {
    this.stmt(`DELETE FROM ${this.table}`).run();
  }
}
