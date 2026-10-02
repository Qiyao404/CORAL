import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { createDb } from '../db.js';
import { migrate } from '../migrate.js';
import { MIGRATIONS } from '../migrations/index.js';

const tmp = mkdtempSync(join(tmpdir(), 'coral-migrate-test-'));
const dbPath = join(tmp, 'test.db');

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('migration runner', () => {
  it('全新库：应用全部迁移并记录版本', () => {
    const db = createDb(dbPath);
    const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as any[];
    expect(rows.map(r => r.version)).toEqual(MIGRATIONS.map(m => m.version));
    expect(existsSync(dbPath)).toBe(true);
    db.close();
  });

  it('重开同一个库：幂等，不重复应用', () => {
    const db = createDb(dbPath);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as any;
    expect(rows.n).toBe(MIGRATIONS.length);
    db.close();
  });

  it('001 包含 v2 内核表与过渡期 v1 表', () => {
    const db = createDb(join(tmp, 'fresh.db'));
    const tables = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all() as any[]).map(r => r.name);
    for (const t of [
      'runs', 'events', 'checkpoints', 'llm_profiles', 'mcp_servers', 'skill_stats', 'kv',
      'tasks', 'plans', 'agents', 'audit_events', 'schema_migrations',
    ]) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it('迁移失败整体回滚（事务性）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as any).n;
    const bad = [{ version: 99, name: 'bad', statements: ['CREATE TABLE ok_table (a)', 'THIS IS NOT SQL'] }];
    expect(() => migrate(db, bad)).toThrow();
    const after = (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as any).n;
    expect(after).toBe(before);
    // 坏迁移里的第一条语句也必须被回滚
    const hasOkTable = db.prepare(`SELECT name FROM sqlite_master WHERE name='ok_table'`).get();
    expect(hasOkTable).toBeUndefined();
    db.close();
  });
});
