import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDb, type DB } from '../db.js';
import { SqliteStore } from '../sqlite-store.js';

const tmp = mkdtempSync(join(tmpdir(), 'coral-store-test-'));
let db: DB;

afterAll(() => {
  db?.close();
  rmSync(tmp, { recursive: true, force: true });
});

function makeStore() {
  if (!db) db = createDb(join(tmp, 'store.db'));
  return new SqliteStore<any>('tasks', 'taskId', { dbProvider: () => db });
}

describe('SqliteStore — 与 v1 JsonStore 语义对齐', () => {
  it('insert / get / getAll / count 往返', () => {
    const store = makeStore();
    store.insert({ taskId: 't1', goal: '目标A', status: 'created', createdAt: '2026-10-01T00:00:00Z' });
    store.insert({ taskId: 't2', goal: '目标B', status: 'completed', createdAt: '2026-10-01T01:00:00Z' });

    expect(store.get('t1')?.goal).toBe('目标A');
    expect(store.count()).toBe(2);
    expect(store.getAll().map(t => t.taskId).sort()).toEqual(['t1', 't2']);
  });

  it('insert 同主键 = 整体替换（v1 Map.set 语义）', () => {
    const store = makeStore();
    store.insert({ taskId: 't1', goal: '目标A-改', status: 'executing', createdAt: '2026-10-01T00:00:00Z' });
    expect(store.count()).toBe(2);
    expect(store.get('t1')?.goal).toBe('目标A-改');
  });

  it('update 部分合并并刷新 updatedAt；键不存在返回 null', () => {
    const store = makeStore();
    const updated = store.update('t1', { status: 'completed' });
    expect(updated?.status).toBe('completed');
    expect(updated?.goal).toBe('目标A-改'); // 未覆盖字段保留
    expect(updated?.updatedAt).toBeTruthy(); // 自动补 updatedAt

    expect(store.update('不存在的键', { status: 'x' })).toBeNull();
  });

  it('find 谓词过滤', () => {
    const store = makeStore();
    const done = store.find(t => t.status === 'completed');
    expect(done.every(t => t.status === 'completed')).toBe(true);
    expect(done.length).toBeGreaterThan(0);
  });

  it('delete / clear', () => {
    const store = makeStore();
    expect(store.delete('t2')).toBe(true);
    expect(store.delete('t2')).toBe(false); // 重复删除
    expect(store.get('t2')).toBeNull();
    store.clear();
    expect(store.count()).toBe(0);
  });

  it('缺主键 insert 抛明确错误；表名注入被拦截', () => {
    const store = makeStore();
    expect(() => store.insert({ goal: '没有主键' })).toThrow(/主键/);
    expect(() => new SqliteStore<any>('tasks; DROP TABLE tasks', 'taskId', { dbProvider: () => db })).toThrow(/非法表名/);
  });

  it('写入即持久：新连接可见（WAL，无 flush 概念）', () => {
    const store = makeStore();
    store.insert({ taskId: 't9', goal: '持久化验证', createdAt: '2026-10-01T02:00:00Z' });
    const dbPath2 = (db as any).name;
    const db2 = createDb(dbPath2);
    const store2 = new SqliteStore<any>('tasks', 'taskId', { dbProvider: () => db2 });
    expect(store2.get('t9')?.goal).toBe('持久化验证');
    db2.close();
  });
});
