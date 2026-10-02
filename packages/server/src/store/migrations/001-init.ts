import type { Migration } from '../migrate.js';

/**
 * 001 — v2 初始 schema
 *
 * 分两组：
 *  1) v2 内核表：runs / events / checkpoints / llm_profiles / mcp_servers / skill_stats / kv
 *     （M1+ 的 run-engine / MCP / time-travel 使用；M0 阶段先建好，空表无害）
 *  2) 过渡期 v1 内核表：tasks / plans / agents / audit_events
 *     （支撑现有 Task/Plan/Agent 内核平滑运行在 SQLite 上；
 *       M1 run-engine 落地后由后续迁移版本收敛/删除）
 */
export default {
  version: 1,
  name: 'init',
  statements: [
    // ─────────── v2 内核表 ───────────
    `CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('free','graph')),
      status TEXT NOT NULL CHECK (status IN
        ('created','running','waiting_human','completed','failed','cancelled')),
      parent_run_id TEXT,
      fork_from_seq INTEGER,
      graph_json TEXT,
      model_profile_id TEXT,
      budget_json TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)`,
    `CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC)`,

    `CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      agent_id TEXT,
      tool_name TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq)`,

    `CREATE TABLE IF NOT EXISTS checkpoints (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('loop_step','graph_node','interrupt')),
      label TEXT,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    )`,

    `CREATE TABLE IF NOT EXISTS llm_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('openai-compat','anthropic')),
      base_url TEXT,
      model TEXT NOT NULL,
      api_key TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport TEXT NOT NULL CHECK (transport IN ('stdio','http')),
      command TEXT,
      url TEXT,
      env_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      tool_count INTEGER,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS skill_stats (
      name TEXT PRIMARY KEY,
      source TEXT,
      use_count INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      last_used_at TEXT,
      last_status TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    )`,

    // ─────────── 过渡期 v1 内核表（M0 → M1 期间使用） ───────────
    `CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC)`,

    `CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      json TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agents_task_id ON agents(task_id)`,

    `CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      type TEXT,
      json TEXT NOT NULL,
      created_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_audit_events_task_id ON audit_events(task_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_events_type ON audit_events(type)`,
  ],
} satisfies Migration;
