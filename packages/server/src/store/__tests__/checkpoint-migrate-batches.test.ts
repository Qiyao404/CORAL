import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { migrate } from '../migrate.js';
import { CheckpointStore, MIGRATE_BATCH } from '../checkpoint-store.js';
import type { ChatMessage } from '../../providers/types.js';

/**
 * REG-42：`coral compact` 把旧内联格式 checkpoint 迁移成去重格式时，用 .all() 一次性把
 * **全部**内联 checkpoint（每条都带整份消息快照）读进内存 —— 最需要压实的库（上 GB、全是内联格式）
 * 正是迁移时内存占用最高的时刻。
 *
 * 修法：按主键分批取（每批一个事务），任何时刻内存里只有一批。
 * 这个迁移函数此前没有任何测试 —— 这里先把"迁移必须保持的正确性"钉住，再改加载方式。
 */

let dir: string;
let db: Database.Database;
let store: CheckpointStore;

const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content } as ChatMessage);
const now = () => new Date().toISOString();

function mkRun(id: string): void {
  db.prepare(`INSERT INTO runs (id, goal, mode, status, created_at, updated_at) VALUES (?, 'g', 'free', 'completed', ?, ?)`).run(id, now(), now());
}
const insertLegacyStmt = () => db.prepare(
  `INSERT INTO checkpoints (run_id, seq, kind, label, state_json, created_at) VALUES (?, ?, 'loop_step', ?, ?, ?)`
);
/** 直接写一行"旧格式"checkpoint（内联 messages），绕过 insert() 的自动去重 */
function insertLegacy(runId: string, seq: number, state: Record<string, unknown>, rawJson?: string): void {
  insertLegacyStmt().run(runId, seq, `step-${seq}`, rawJson ?? JSON.stringify(state), now());
}
/** 批量写入（一个事务）— 逐行写入时每行各落盘一次，光准备数据就要好几秒 */
function insertLegacyMany(runId: string, states: Array<Record<string, unknown>>): void {
  const stmt = insertLegacyStmt();
  db.transaction(() => {
    for (let i = 0; i < states.length; i++) stmt.run(runId, i + 1, `step-${i + 1}`, JSON.stringify(states[i]), now());
  })();
}
const legacyState = (seq: number) => ({
  messages: [msg('user', `目标 ${seq % 7}`), msg('assistant', `第 ${seq} 步的思考`), msg('tool', `结果 ${seq}`)],
  system: `system-prompt-${seq % 3}`,
  model: { model: 'm', provider: 'p' },
  contextOps: [{ step: seq, kind: 'shelve', reclaimedChars: 10, keptMessages: 4 }],
});
const inlineCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE state_json LIKE '%"messages"%'`).get() as any).n;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coral-ck-mig-'));
  db = new Database(join(dir, 'x.db'));
  migrate(db);
  store = new CheckpointStore(() => db as any);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('migrateInlineCheckpoints · 迁移的正确性', () => {
  it('跨越多个批次（远超一批的数量）：全部迁移，读出来的内容与迁移前一致，其余字段保留', () => {
    const perRun = MIGRATE_BATCH + 25; // 每个 run 跨 2 批，最后一批不满
    for (const runId of ['run-a', 'run-b']) {
      mkRun(runId);
      insertLegacyMany(runId, Array.from({ length: perRun }, (_, i) => legacyState(i + 1)));
    }
    const before = [1, 2, MIGRATE_BATCH, perRun - 1, perRun].map(seq => ({ seq, state: store.get('run-a', seq) }));

    const t0 = Date.now();
    expect(store.migrateInlineCheckpoints()).toBe(perRun * 2);
    const elapsed = Date.now() - t0;
    // 性能动机（REG-42）：旧实现每条写入各落盘一次，同样这批数据在本机要十几秒；
    // 这里只设一个宽松的上限，防止退化回"逐条事务"
    expect(elapsed).toBeLessThan(5000);
    expect(inlineCount()).toBe(0);
    for (const { seq, state } of before) expect(store.get('run-a', seq)).toEqual(state);
    // 再跑一次：没有可迁移的了（幂等）
    expect(store.migrateInlineCheckpoints()).toBe(0);
    // 消息按内容去重存储：每条唯一消息只存一份
    const msgRows = (db.prepare(`SELECT COUNT(*) AS n FROM checkpoint_messages`).get() as any).n;
    expect(msgRows).toBeLessThan(perRun * 2 * 3);
  }, 30_000); // 准备数据与迁移都在临时库上；慢机器留余量

  it('损坏的行（非法 JSON / messages 不是数组）被跳过且不阻塞其余行', () => {
    mkRun('run-c');
    insertLegacy('run-c', 1, legacyState(1));
    insertLegacy('run-c', 2, {}, '{"messages": [ 这后面是坏的'); // 含 "messages"（会被扫描选中）但不是合法 JSON
    insertLegacy('run-c', 3, {}, JSON.stringify({ messages: 'not-an-array', system: 'x' }));
    insertLegacy('run-c', 4, legacyState(4));

    expect(store.migrateInlineCheckpoints()).toBe(2);
    expect(inlineCount()).toBe(2); // 两行坏数据原样留着（可人工排查），没有丢
    expect(store.get('run-c', 1)?.messages).toEqual(legacyState(1).messages as any);
    expect(store.get('run-c', 4)?.messages).toEqual(legacyState(4).messages as any);
    expect(store.migrateInlineCheckpoints()).toBe(0); // 坏行不会被反复计成"已迁移"
  });

  it('已经是去重格式的行不受影响', () => {
    mkRun('run-d');
    insertLegacy('run-d', 1, legacyState(1));
    store.migrateInlineCheckpoints();
    const afterFirst = db.prepare(`SELECT state_json FROM checkpoints WHERE run_id = 'run-d' AND seq = 1`).get() as any;
    expect(String(afterFirst.state_json)).toContain('mrefs');
    expect(store.migrateInlineCheckpoints()).toBe(0);
    expect((db.prepare(`SELECT state_json FROM checkpoints WHERE run_id = 'run-d' AND seq = 1`).get() as any).state_json).toBe(afterFirst.state_json);
  });
});
