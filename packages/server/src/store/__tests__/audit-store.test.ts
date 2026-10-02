import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDb, type DB } from '../db.js';
import { AuditEventStore } from '../audit-store.js';
import type { CoralEvent } from '../../types/index.js';

const tmp = mkdtempSync(join(tmpdir(), 'coral-audit-test-'));
let db: DB;

afterAll(() => {
  db?.close();
  rmSync(tmp, { recursive: true, force: true });
});

function makeStore(): AuditEventStore {
  if (!db) db = createDb(join(tmp, 'audit.db'));
  return new AuditEventStore(() => db);
}

let seq = 0;
function event(overrides: Partial<CoralEvent> = {}): CoralEvent {
  seq++;
  return {
    eventId: `ev-${seq}`,
    type: 'task.created',
    payload: { goal: 'g' },
    timestamp: new Date(2026, 9, 1, 0, 0, seq).toISOString(),
    ...overrides,
  } as CoralEvent;
}

describe('AuditEventStore — 增量写入 + 索引查询', () => {
  it('insert + findByTaskId（按时间升序，只返回该任务）', () => {
    const store = makeStore();
    store.insert(event({ taskId: 'task-a' }));
    store.insert(event({ taskId: 'task-b', type: 'task.executing' }));
    store.insert(event({ taskId: 'task-a', type: 'task.executing' }));
    store.insert(event({ taskId: 'task-a', type: 'agent.spawned' }));
    store.insert(event({ taskId: undefined })); // 无 taskId 的事件不丢

    const a = store.findByTaskId('task-a');
    expect(a).toHaveLength(3);
    expect(a.map(e => e.type)).toEqual(['task.created', 'task.executing', 'agent.spawned']);
    expect(a.every(e => e.taskId === 'task-a')).toBe(true);
  });

  it('findByTypePrefix 前缀匹配 + 数量限制', () => {
    const store = makeStore();
    const agentEvents = store.findByTypePrefix('agent.');
    expect(agentEvents.every(e => e.type.startsWith('agent.'))).toBe(true);
    expect(agentEvents.length).toBeGreaterThan(0);
    expect(store.findByTypePrefix('agent.', 1)).toHaveLength(1);
  });

  it('eventId 去重（INSERT OR REPLACE 不报错）', () => {
    const store = makeStore();
    const before = store.count();
    store.insert(event({ eventId: 'ev-1', taskId: 'task-a' })); // 显式复用已存在的 id → 整行替换
    expect(store.count()).toBe(before);
  });

  it('count 与 find 兜底', () => {
    const store = makeStore();
    expect(store.count()).toBe(5);
    expect(store.find(e => e.type === 'task.executing')).toHaveLength(2);
  });
});
