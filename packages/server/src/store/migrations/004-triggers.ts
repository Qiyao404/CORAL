import type { Migration } from '../migrate.js';

/**
 * 004 — 触发器（M3-5 / D21）
 *  · schedules：定时触发（interval 秒 / cron 表达式）与入站 webhook 共用一张表
 *  · 触发动作 = 创建 run（free goal / graph），记录 fire 历史（最近 N 次内联 JSON）
 */
export default {
  version: 4,
  name: 'triggers',
  statements: [
    `CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      kind TEXT NOT NULL CHECK (kind IN ('interval','cron','webhook')),
      spec TEXT NOT NULL,
      action_json TEXT NOT NULL,
      last_fired_at TEXT,
      next_fire_at TEXT,
      fire_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled)`,
    // mcp_servers 补列（M3-2 遗留 — 幂等失败被迁移事务回滚？不：ALTER 已存在会抛错，
    // 所以 003 之外的这两列由服务层 ensureColumns 幂等处理；此处不再重复）
  ],
} as Migration;
