import type { Migration } from '../migrate.js';

/**
 * 006 — checkpoint 消息去重存储
 *
 * 背景：checkpoint 每步存全量消息快照，相邻步的消息数组 90%+ 重复 →
 * 单 run 存储 O(步数²)（实测 2GB 库 93% 是 checkpoint）。
 * 方案：消息按内容哈希存一次（每 run 一份），checkpoint 只存引用列表 → O(n²) → O(n)。
 * 兼容：旧 checkpoint 的内联 messages 读取路径原样支持；压实命令一次性迁移旧数据。
 */
export default {
  version: 6,
  name: 'checkpoint-message-dedup',
  statements: [
    `CREATE TABLE IF NOT EXISTS checkpoint_messages (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      hash TEXT NOT NULL,
      message_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, hash)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_cpm_run ON checkpoint_messages(run_id)`,
  ],
} satisfies Migration;
