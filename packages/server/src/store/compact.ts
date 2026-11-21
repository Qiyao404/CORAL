import type { DB } from './db.js';
import { CheckpointStore } from './checkpoint-store.js';

/**
 * 数据库压实（一次性维护操作，`coral compact` 调用）：
 *
 *  1. 存量迁移：旧内联格式的 checkpoint 改写为消息去重格式（O(n²) → O(n)）
 *  2. 孤儿清理：run 已不存在的 events / checkpoints / checkpoint_messages /
 *     search_docs（级联删除的历史遗漏 + FTS 索引无外键）
 *  3. VACUUM：SQLite 删除不缩小文件 — 压实才真正把空间还给磁盘
 *
 * VACUUM 期间独占数据库 — 只应在停服或空闲时执行。
 */
export function compactDatabase(db: DB): {
  migrated: number;
  orphanRowsCleaned: number;
  vacuumed: boolean;
} {
  const cps = new CheckpointStore(() => db);
  const migrated = cps.migrateInlineCheckpoints();

  let orphanRowsCleaned = 0;
  orphanRowsCleaned += db.prepare(`DELETE FROM events WHERE run_id NOT IN (SELECT id FROM runs)`).run().changes;
  orphanRowsCleaned += db.prepare(`DELETE FROM checkpoints WHERE run_id NOT IN (SELECT id FROM runs)`).run().changes;
  orphanRowsCleaned += db.prepare(`DELETE FROM checkpoint_messages WHERE run_id NOT IN (SELECT id FROM runs)`).run().changes;
  orphanRowsCleaned += db.prepare(`DELETE FROM search_docs WHERE run_id NOT IN (SELECT id FROM runs)`).run().changes;

  db.exec('VACUUM');
  return { migrated, orphanRowsCleaned, vacuumed: true };
}
