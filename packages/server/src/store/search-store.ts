import type { DB } from './db.js';
import { getDb } from './db.js';
import type { ChatMessage } from '../providers/types.js';

/**
 * 会话全文检索仓储（FTS5 trigram，中英混合子串匹配）。
 *
 * 索引单位是"检索文档"：run 终态时从末次 checkpoint 提取 goal / 最终回答 / 各消息，
 * 每条截断后重建该 run 的文档行（幂等：先删后插）。session_search 工具按 MATCH
 * 检索，返回 run 定位信息 + 高亮片段 —— agent 由此获得"经历回溯"能力。
 */

export interface SearchDoc {
  runId: string;
  kind: string;      // goal | answer | user | assistant | tool
  text: string;
}

export interface SearchHit {
  runId: string;
  kind: string;
  snippet: string;
}

const MAX_DOC_CHARS = 4000;

export class SearchStore {
  private dbProvider: () => DB;
  private cachedDb: DB | null = null;
  private stmts = new Map<string, import('better-sqlite3').Statement>();

  constructor(dbProvider: () => DB = getDb) {
    this.dbProvider = dbProvider;
  }

  private db(): DB {
    const db = this.dbProvider();
    if (db !== this.cachedDb) {
      this.stmts.clear();
      this.cachedDb = db;
    }
    return db;
  }

  private stmt(sql: string): import('better-sqlite3').Statement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db().prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** run 终态时（重新）索引该 run：goal + 最终回答 + 末次 checkpoint 消息 */
  indexRun(runId: string, goal: string, finalContent: string, messages: ChatMessage[]): void {
    const del = this.stmt(`DELETE FROM search_docs WHERE run_id = ?`);
    const ins = this.stmt(`INSERT INTO search_docs (text, run_id, kind) VALUES (?, ?, ?)`);
    const docs: SearchDoc[] = [
      { runId, kind: 'goal', text: goal },
      ...(finalContent.trim() ? [{ runId, kind: 'answer', text: finalContent }] : []),
      ...messages
        .filter(m => m && typeof m.content === 'string' && m.content.trim())
        .map(m => ({
          runId,
          kind: m.role === 'tool' ? 'tool' : m.role,
          text: `${(m as any).toolName ? `[${(m as any).toolName}] ` : ''}${m.content}`,
        })),
    ];
    const tx = this.db().transaction(() => {
      del.run(runId);
      for (const d of docs) {
        if (!d.text.trim()) continue;
        ins.run(d.text.slice(0, MAX_DOC_CHARS), d.runId, d.kind);
      }
    });
    tx();
  }

  /**
   * 全文检索（trigram 子串匹配；查询过短 <3 字符时降级为 LIKE）。
   * 返回按 run 聚合的命中（每个 run 最多取 2 条片段），最新文档优先。
   */
  search(query: string, limit = 6): SearchHit[] {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const capped = Math.min(Math.max(limit, 1), 20);
    let rows: Array<{ run_id: string; kind: string; snippet: string }> = [];
    if (q.length >= 3) {
      const escaped = q.replace(/"/g, '""');
      rows = this.stmt(
        `SELECT run_id, kind, snippet(search_docs, 0, '⟦', '⟧', ' … ', 16) AS snippet
         FROM search_docs WHERE search_docs MATCH ?
         ORDER BY rank LIMIT ?`
      ).all(`"${escaped}"`, capped * 3) as any[];
    } else {
      const like = `%${q}%`;
      rows = this.stmt(
        `SELECT run_id, kind, text AS snippet FROM search_docs WHERE text LIKE ? LIMIT ?`
      ).all(like, capped * 3) as any[];
    }
    // run 聚合：每个 run 最多 2 片段
    const byRun = new Map<string, SearchHit[]>();
    for (const r of rows) {
      const list = byRun.get(r.run_id) ?? [];
      if (list.length < 2) list.push({ runId: r.run_id, kind: r.kind, snippet: String(r.snippet).slice(0, 300) });
      byRun.set(r.run_id, list);
    }
    return [...byRun.values()].flat().slice(0, capped);
  }
}
