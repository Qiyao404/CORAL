import type { DB } from './db.js';
import { getDb } from './db.js';
import type { LLMConfigProfile } from '../types/index.js';

interface ProfileRow {
  id: string;
  name: string;
  provider: string;
  base_url: string | null;
  model: string;
  api_key: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

/**
 * LLM 配置仓储（llm_profiles 表，v2 正式表）。
 * 对外保持 v1 LLMConfigProfile 形状（provider 字段 v1 没有，暂不外露，
 * 行内恒写 'openai-compat'，M1 providers 层落地后再启用多 provider）。
 * API 与 v1 JsonStore 用法对齐，llm-config-service 无需改动调用方式。
 */
export class LlmProfileStore {
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

  private toRow(p: LLMConfigProfile): any[] {
    return [
      p.profileId,
      p.name,
      p.provider ?? 'openai-compat',
      p.baseUrl,
      p.model,
      p.apiKey,
      p.isActive ? 1 : 0,
      p.createdAt,
      p.updatedAt,
    ];
  }

  private fromRow(r: ProfileRow): LLMConfigProfile {
    return {
      profileId: r.id,
      name: r.name,
      provider: r.provider === 'anthropic' ? 'anthropic' : 'openai-compat',
      baseUrl: r.base_url ?? '',
      apiKey: r.api_key,
      model: r.model,
      isActive: r.is_active === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  insert(profile: LLMConfigProfile): void {
    this.stmt(
      `INSERT OR REPLACE INTO llm_profiles
       (id, name, provider, base_url, model, api_key, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...this.toRow(profile));
  }

  get(profileId: string): LLMConfigProfile | null {
    const row = this.stmt(`SELECT * FROM llm_profiles WHERE id = ?`).get(profileId) as
      | ProfileRow
      | undefined;
    return row ? this.fromRow(row) : null;
  }

  getAll(): LLMConfigProfile[] {
    const rows = this.stmt(`SELECT * FROM llm_profiles ORDER BY rowid`).all() as ProfileRow[];
    return rows.map(r => this.fromRow(r));
  }

  /** 读-合并-写回；保留原 provider；键不存在返回 null */
  update(profileId: string, partial: Partial<LLMConfigProfile>): LLMConfigProfile | null {
    const existing = this.get(profileId);
    if (!existing) return null;
    const merged: LLMConfigProfile = { ...existing, ...partial };
    this.insert(merged);
    return merged;
  }

  delete(profileId: string): boolean {
    const info = this.stmt(`DELETE FROM llm_profiles WHERE id = ?`).run(profileId);
    return info.changes > 0;
  }

  find(predicate: (p: LLMConfigProfile) => boolean): LLMConfigProfile[] {
    return this.getAll().filter(predicate);
  }

  count(): number {
    const row = this.stmt(`SELECT COUNT(*) AS n FROM llm_profiles`).get() as { n: number };
    return row.n;
  }
}
