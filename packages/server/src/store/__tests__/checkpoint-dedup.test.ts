import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { migrate } from '../migrate.js';
import { CheckpointStore } from '../checkpoint-store.js';
import { compactDatabase } from '../compact.js';
import type { ChatMessage } from '../../providers/types.js';

/**
 * checkpoint 消息去重（006 迁移）+ 数据库压实：
 *  · 相邻步共享的消息只存一份（O(n²) → O(n)）
 *  · 旧内联格式 get() 兼容；compact 存量迁移 + 孤儿清理 + VACUUM
 *  · run 级联删除清理 checkpoint_messages
 */

let dir: string;
let db: Database.Database;
let store: CheckpointStore;

const msg = (role: ChatMessage['role'], content: string): ChatMessage =>
  ({ role, content } as ChatMessage);

/** 生产顺序：run 行先于一切子记录存在（外键级联的根基） */
function mkRun(id: string): void {
  db.prepare(
    `INSERT INTO runs (id, goal, mode, status, created_at, updated_at) VALUES (?, 'g', 'free', 'completed', ?, ?)`
  ).run(id, new Date().toISOString(), new Date().toISOString());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coral-cpdedup-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  migrate(db);
  store = new CheckpointStore(() => db as any);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('CheckpointStore — 消息去重读写', () => {
  it('写入去重 + 读出重组装：消息内容一字不差（含顺序与特殊字段）', () => {
    const step1 = [msg('user', '任务目标'), msg('assistant', '开始'), { role: 'tool', content: '{"x":1}', toolCallId: 'c1', toolName: 'echo' } as any];
    // 步 2 = 步 1 全量 + 新增 2 条（相邻步 90% 重复的真实形态）
    const step2 = [...step1, msg('assistant', '继续'), msg('tool', '{"y":2}') as any];

    mkRun('r1');
    store.insert({ runId: 'r1', seq: 1, kind: 'loop_step', state: { messages: step1, system: 'SYS' } });
    store.insert({ runId: 'r1', seq: 2, kind: 'loop_step', state: { messages: step2, system: 'SYS', model: { model: 'glm' } } });

    const g1 = store.get('r1', 1)!;
    const g2 = store.get('r1', 2)!;
    expect(g1.messages).toEqual(step1);
    expect(g2.messages).toEqual(step2);
    expect(g1.system).toBe('SYS');
    expect(g2.model).toEqual({ model: 'glm' });
    // 精确重放关键字段不丢
    expect((g2.messages![2] as any).toolCallId).toBe('c1');
  });

  it('相邻步共享内容只存一份：checkpoint_messages 行数 = 唯一消息数', () => {
    const base = Array.from({ length: 10 }, (_, i) => msg('tool', `payload-${i}`) as any);
    mkRun('r2');
    for (let step = 1; step <= 10; step++) {
      store.insert({ runId: 'r2', seq: step, kind: 'loop_step', state: { messages: base.slice(0, step) } });
    }
    const rows = db.prepare('SELECT COUNT(*) n FROM checkpoint_messages WHERE run_id=?').get('r2') as any;
    expect(rows.n).toBe(10); // 10 步共 55 条消息引用，唯一消息只有 10 条
    // 旧结构（无去重）会存 55 份 —— 这就是 O(n²) → O(n)
  });

  it('跨 run 不共享（同内容不同 run 各存一份 — 删除级联干净）', () => {
    const m = [msg('user', '相同内容')];
    mkRun('ra');
    store.insert({ runId: 'ra', seq: 1, kind: 'loop_step', state: { messages: m } });
    mkRun('rb');
    store.insert({ runId: 'rb', seq: 1, kind: 'loop_step', state: { messages: m } });
    const n = (db.prepare('SELECT COUNT(*) n FROM checkpoint_messages').get() as any).n;
    expect(n).toBe(2);
    db.prepare('DELETE FROM runs WHERE id=?').run('ra');
    const left = (db.prepare('SELECT COUNT(*) n FROM checkpoint_messages').get() as any).n;
    expect(left).toBe(1); // run 级联删除带走自己的消息
  });

  it('graph 检查点（vars/cursor，无 messages）不受影响', () => {
    mkRun('rg');
    store.insert({ runId: 'rg', seq: 1, kind: 'graph_node', label: 'n1', state: { vars: { a: 1 }, cursor: 'x' } });
    const g = store.get('rg', 1)!;
    expect(g.vars).toEqual({ a: 1 });
    expect(g.cursor).toBe('x');
    expect(g.messages).toBeUndefined();
  });
});

describe('旧格式兼容 + 压实', () => {
  it('内联 messages 的旧 checkpoint：get 原样解析；compact 迁移后改走去重路径且内容不变', () => {
    // 手工构造旧格式行（模拟 006 之前的数据）
    const legacy = [msg('user', '旧任务'), msg('assistant', '旧回答')];
    mkRun('r3');
    db.prepare(
      `INSERT INTO checkpoints (run_id, seq, kind, label, state_json, created_at) VALUES (?,?,?,?,?,?)`
    ).run('r3', 1, 'loop_step', 'step-1', JSON.stringify({ messages: legacy, system: 'OLD_SYS' }), new Date().toISOString());

    // 迁移前：内联路径可读
    const before = store.get('r3', 1)!;
    expect(before.messages).toEqual(legacy);
    expect(before.system).toBe('OLD_SYS');

    // 压实：迁移 + 孤儿清理 + VACUUM
    const r = compactDatabase(db as any);
    expect(r.migrated).toBe(1);
    expect(r.vacuumed).toBe(true);

    // 迁移后：mrefs 路径读出的内容与迁移前一致
    const after = store.get('r3', 1)!;
    expect(after.messages).toEqual(legacy);
    expect(after.system).toBe('OLD_SYS');
    // 旧内联 key 已剥离
    const raw = db.prepare(`SELECT state_json FROM checkpoints WHERE run_id='r3'`).get() as any;
    const parsed = JSON.parse(raw.state_json);
    expect(parsed.messages).toBeUndefined();
    expect(Array.isArray(parsed.mrefs)).toBe(true);
  });

  it('compact 清理孤儿行（run 已删但 events/search_docs 残留）', () => {
    mkRun('ghost');
    db.prepare(`INSERT INTO events (id, run_id, seq, type, payload_json, created_at) VALUES ('e1','ghost',1,'x','{}','t')`).run();
    db.pragma('foreign_keys = OFF');
    db.prepare(`DELETE FROM runs WHERE id='ghost'`).run(); // 绕过级联，制造历史形态的孤儿
    db.pragma('foreign_keys = ON');
    db.prepare(`INSERT INTO search_docs (run_id, kind, text) VALUES ('ghost','goal','孤儿检索文档')`).run();
    const r = compactDatabase(db as any);
    expect(r.orphanRowsCleaned).toBeGreaterThanOrEqual(2);
    const e = db.prepare(`SELECT COUNT(*) n FROM events WHERE run_id='ghost'`).get() as any;
    const s = db.prepare(`SELECT COUNT(*) n FROM search_docs WHERE run_id='ghost'`).get() as any;
    expect(e.n).toBe(0);
    expect(s.n).toBe(0);
  });

  it('compact 幂等：二跑迁移数为 0，库可正常读写', () => {
    mkRun('r4');
    store.insert({ runId: 'r4', seq: 1, kind: 'loop_step', state: { messages: [msg('user', 'x')] } });
    const first = compactDatabase(db as any);
    const second = compactDatabase(db as any);
    expect(second.migrated).toBe(0);
    expect(store.get('r4', 1)!.messages).toEqual([msg('user', 'x')]);
  });
});
