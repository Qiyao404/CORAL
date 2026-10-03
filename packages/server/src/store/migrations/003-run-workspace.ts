import type { Migration } from '../migrate.js';

/**
 * 003 — runs 表增加 workspace_id（M2 实测：graph 产物落点）
 *  · graph run 可绑定工作区：技能脚本经 CORAL_OUTPUT_DIR 拿到目录，产物落用户可见位置
 *  · free 模式不写入（工作区在 run-engine 内存解析，事件流携带）
 */
export default {
  version: 3,
  name: 'run-workspace',
  statements: [
    `ALTER TABLE runs ADD COLUMN workspace_id TEXT`,
  ],
} as Migration;
