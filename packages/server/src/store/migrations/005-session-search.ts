import type { Migration } from '../migrate.js';

/**
 * 005 — 会话全文检索（FTS5 trigram：支持中英混合的子串匹配）。
 * 索引对象为"检索文档"（run 的目标/最终回答/消息内容），非 events 原表——
 * 控制体积：每条消息截断入库，run 终态时一次性重建该 run 的文档（session_search 数据源）。
 */
export default {
  version: 5,
  name: 'session-search-fts',
  statements: [
    `CREATE VIRTUAL TABLE IF NOT EXISTS search_docs USING fts5(
      text,
      run_id UNINDEXED,
      kind UNINDEXED
    , tokenize='trigram')`,
  ],
} satisfies Migration;
