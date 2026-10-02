import type { Migration } from '../migrate.js';

/**
 * 002 — runs 表 v2 运行时增列（M1-5 / D17）
 *  · session_id：D17 多会话模型 — Chat 会话列表/切换/继续历史的挂靠维度
 *  · final_content：run 最终回答（loop 的 finalContent / 预算耗尽总结）
 *  · end_reason：结束原因 — status 词表保持不变（completed/failed/cancelled），
 *    budget_exceeded 作为 end_reason + 事件而非独立状态（schema CHECK 未含它）
 */
export default {
  version: 2,
  name: 'run-session',
  statements: [
    `ALTER TABLE runs ADD COLUMN session_id TEXT`,
    `ALTER TABLE runs ADD COLUMN final_content TEXT`,
    `ALTER TABLE runs ADD COLUMN end_reason TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id)`,
  ],
} satisfies Migration;
