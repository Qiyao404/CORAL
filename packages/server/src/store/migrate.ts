import type { DB } from './db.js';
import { MIGRATIONS } from './migrations/index.js';

/** 一个迁移 = 一个版本号 + 一组按序执行的静态 SQL 语句 */
export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

/**
 * 极简迁移框架（M0-1）：
 *  · schema_migrations 表记录已应用版本
 *  · 每个迁移在单个事务内执行全部语句并记录版本号，失败整体回滚
 *  · 幂等：重复调用只应用未执行的迁移
 */
export function migrate(db: DB, migrations: Migration[] = MIGRATIONS): number {
  const list = migrations.slice().sort((a, b) => a.version - b.version);

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>)
      .map(r => r.version)
  );

  const apply = db.transaction((m: Migration) => {
    for (const stmt of m.statements) db.exec(stmt);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(m.version, m.name, new Date().toISOString());
  });

  let appliedNow = 0;
  for (const m of list) {
    if (applied.has(m.version)) continue;
    apply(m);
    appliedNow++;
    console.log(`[数据库迁移] 已应用 v${m.version} ${m.name}`);
  }
  return appliedNow;
}
