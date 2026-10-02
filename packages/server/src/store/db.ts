import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { platformConfig } from '../services/config.js';
import { migrate } from './migrate.js';

export type DB = Database.Database;

/**
 * 打开（或创建）SQLite 数据库并应用全部迁移。
 * WAL 模式：写入即持久（修复 v1 JsonStore 全量重写 + 崩溃丢数据的 A7 缺陷）。
 */
export function createDb(filePath: string): DB {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

let instance: DB | null = null;

/** 进程级单例 — 数据库路径来自 platformConfig.databasePath（默认 data/coral.db） */
export function getDb(): DB {
  if (!instance) instance = createDb(platformConfig.databasePath);
  return instance;
}

/** 优雅关闭：应在 app.close() 之后调用（避免关闭期间新事件写入失败） */
export function closeDb(): void {
  if (instance) {
    try { instance.close(); } catch { /* 已关闭 */ }
    instance = null;
  }
}
