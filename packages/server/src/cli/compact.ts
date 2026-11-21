import { statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { migrate } from '../store/migrate.js';
import { compactDatabase } from '../store/compact.js';

/**
 * coral compact — 数据库一次性压实（停服/空闲时执行）：
 *  · 存量 checkpoint 迁移为消息去重格式（O(n²) → O(n)）
 *  · 清理孤儿行（run 已不存在的 events/checkpoints/checkpoint_messages/search_docs）
 *  · VACUUM 把空间真正还给磁盘
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DB_PATH = process.env.CORAL_DB ?? join(REPO_ROOT, 'data', 'coral.db');

export async function runCompact(): Promise<void> {
  const before = statSync(DB_PATH).size;
  console.log(`数据库: ${DB_PATH}`);
  console.log(`压实前: ${(before / 1024 / 1024).toFixed(1)} MB`);

  const db = new Database(DB_PATH);
  try {
    db.pragma('foreign_keys = ON');
    migrate(db);
    const t0 = Date.now();
    const result = compactDatabase(db);
    const after = statSync(DB_PATH).size;
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const savedMb = ((before - after) / 1024 / 1024).toFixed(1);
    console.log(`✓ 存量迁移: ${result.migrated} 个 checkpoint 改写为去重格式`);
    console.log(`✓ 孤儿清理: ${result.orphanRowsCleaned} 行`);
    console.log(`✓ VACUUM 完成（${dt}s）`);
    console.log(`压实后: ${(after / 1024 / 1024).toFixed(1)} MB（节省 ${savedMb} MB / ${(((before - after) / before) * 100).toFixed(1)}%）`);
  } finally {
    db.close();
  }
}
