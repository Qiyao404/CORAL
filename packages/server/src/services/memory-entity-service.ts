import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import type { MemoryService } from './memory-service.js';
import type { RunBudgetSettingsService } from './run-budget-settings.js';

/**
 * 记忆实体索引（B5）：给记忆库建"名字 → 出现在哪些文件"的索引，检索时同实体加成。
 *
 * 边界与联动：
 *  · LLM 抽取（上限高：跨记忆串联复杂实体；下限低：抽错被加成放大）——
 *    因此默认开但**阈值自动启用**（文件数 ≥ 阈值才生效：成本随写入即时发生、
 *    收益随库规模延迟兑现，阈值把两者对齐）；关闭保留索引不删（重开即用）
 *  · 实体索引生效时**放宽超量整理阈值**：检索能力决定库该多大——
 *    不是"库小所以检索简单"，是"检索强所以库可以大"
 *  · 中途启用对存量补建（人工触发按钮，闸门哲学）
 */

export interface EntityIndex {
  /** 实体 → 出现它的文件名列表 */
  entities: Record<string, string[]>;
  builtAt?: string;
  /** 索引覆盖的文件（file → 抽取时的实体数 — 变更检测用） */
  files?: Record<string, { entities: number; indexedAt: string }>;
}

interface LlmChat {
  chat(req: { messages: Array<{ role: 'user'; content: string }>; jsonMode?: boolean; maxTokens?: number }): Promise<{ content: string }>;
  isDemoMode?(): boolean;
}

export class MemoryEntityService {
  private path: string;
  private cache: EntityIndex | null = null;

  constructor(memoryDir: string) {
    this.path = join(resolve(memoryDir), '.entities.json');
  }

  private load(): EntityIndex {
    if (this.cache) return this.cache;
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, 'utf-8'));
        this.cache = parsed && typeof parsed === 'object' && typeof parsed.entities === 'object'
          ? parsed as EntityIndex
          : { entities: {} };
      } else {
        this.cache = { entities: {} };
      }
    } catch { this.cache = { entities: {} }; }
    return this.cache;
  }

  private persist(): void {
    try {
      mkdirSync(resolve(this.path, '..'), { recursive: true });
      const tmp = this.path + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.cache ?? {}, null, 2), 'utf-8');
      renameSync(tmp, this.path);
    } catch { /* 索引失败不伤记忆 */ }
  }

  /** 生效判定：开关开 且 文件数 ≥ 阈值（成本-收益对齐） */
  active(svc: MemoryService, settings: { entityIndexEnabled: boolean; entityIndexThreshold: number }): boolean {
    if (!settings.entityIndexEnabled) return false;
    return svc.list().length >= settings.entityIndexThreshold;
  }

  /** 检索加成视图：实体 → 文件列表（未生效/无索引返回空） */
  boostMap(): Record<string, string[]> {
    return this.load().entities ?? {};
  }

  summary(): { entityCount: number; fileCount: number; builtAt: string | null } {
    const idx = this.load();
    return {
      entityCount: Object.keys(idx.entities ?? {}).length,
      fileCount: Object.keys(idx.files ?? {}).length,
      builtAt: idx.builtAt ?? null,
    };
  }

  /** LLM 抽取一个文件的实体（人名/项目/产品/工具/域名等关键专名） */
  private async extractForFile(llm: LlmChat, content: string): Promise<string[]> {
    const prompt =
      `Extract the key named entities from this memory note: people, projects, products, tools, ` +
      `companies, domains, technical terms used as proper nouns. Exclude generic words.\n\n` +
      `${content.slice(0, 3000)}\n\nReply JSON only: {"entities":["..."]} (max 10, keep original language & spelling)`;
    const res = await llm.chat({ messages: [{ role: 'user', content: prompt }], jsonMode: true, maxTokens: 1000 });
    const t = String(res.content ?? '').trim();
    let parsed: any = null;
    try { parsed = JSON.parse(t); } catch {
      const s = t.indexOf('{'), e = t.lastIndexOf('}');
      if (s >= 0 && e > s) { try { parsed = JSON.parse(t.slice(s, e + 1)); } catch { /* */ } }
    }
    if (!Array.isArray(parsed?.entities)) return [];
    return parsed.entities
      .filter((x: unknown) => typeof x === 'string' && x.trim().length >= 2)
      .map((x: string) => x.trim().slice(0, 60))
      .slice(0, 10);
  }

  /** 索引单个文件（重建该文件的实体条目；写入路径 fire-and-forget 调用） */
  async indexFile(svc: MemoryService, llm: LlmChat, name: string): Promise<number> {
    const read = svc.read(name);
    if (!read) return 0;
    const idx = this.load();
    // 清掉该文件的旧条目再重加（内容变更时实体集可能变）
    for (const [ent, files] of Object.entries(idx.entities)) {
      idx.entities[ent] = files.filter(f => f !== name);
      if (idx.entities[ent].length === 0) delete idx.entities[ent];
    }
    let count = 0;
    try {
      const entities = await this.extractForFile(llm, read.content);
      for (const ent of entities) {
        const key = ent.toLowerCase();
        idx.entities[key] = [...new Set([...(idx.entities[key] ?? []), name])];
        count++;
      }
    } catch { /* 抽取失败 — 该文件保持无实体（不加成不添乱） */ }
    idx.files = idx.files ?? {};
    idx.files[name] = { entities: count, indexedAt: new Date().toISOString() };
    idx.builtAt = new Date().toISOString();
    this.persist();
    return count;
  }

  /** 存量补建（人工触发）：全部文件过一遍；单文件失败不中断 */
  async backfill(svc: MemoryService, llm: LlmChat): Promise<{ files: number; entities: number }> {
    if (llm.isDemoMode?.()) return { files: 0, entities: 0 };
    let entities = 0;
    const names = svc.list().map(f => f.name);
    for (const n of names) {
      try {
        entities += await this.indexFile(svc, llm, n);
      } catch { /* 单文件失败继续 */ }
    }
    return { files: names.length, entities };
  }
}
