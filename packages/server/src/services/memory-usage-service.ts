import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, resolve } from 'path';
import type { MemoryService } from './memory-service.js';

/**
 * 记忆条目使用追踪（记忆生命周期的"免疫系统"数据面）：
 *
 *  · recordUse：memory_read / memory_search 命中即记账（useCount / lastUsedAt）
 *  · recordSuspect：读过该记忆的 run 以 failed 收尾 → misleads+1。
 *    这是**弱归因**（失败未必是记忆的锅）——因此只记录、只展示，绝不自动删除；
 *    连续误导的条目由人在设置页看到徽标后自行处置（人工闸门哲学）
 *  · stats：与文件列表合并，输出使用次数 / 疑似误导 / 陈旧度（久未使用提示）
 *
 * 存储：{memoryDir}/.usage.json（MemoryService.list 只认 *.md，不会混入列表）。
 */

export interface MemoryUsageRecord {
  useCount: number;
  lastUsedAt: string;
  misleads: number;
  lastSuspectAt?: string;
}

export interface MemoryUsageStat {
  name: string;
  useCount: number;
  lastUsedAt: string | null;
  misleads: number;
  /** 距上次使用的天数（从未使用 = null） */
  idleDays: number | null;
  /** misleads ≥ 阈值：多次伴随失败，建议人工复核 */
  flagged: boolean;
  /** 超过 staleDays 未使用：内容可能过期，建议复核 */
  stale: boolean;
}

const SUSPECT_THRESHOLD = 2;
const STALE_DAYS = 30;

export class MemoryUsageService {
  private path: string;
  private cache: Record<string, MemoryUsageRecord> | null = null;

  constructor(memoryDir: string) {
    this.path = join(resolve(memoryDir), '.usage.json');
  }

  private load(): Record<string, MemoryUsageRecord> {
    if (this.cache) return this.cache;
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, 'utf-8'));
        this.cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } else {
        this.cache = {};
      }
    } catch { this.cache = {}; }
    return this.cache!;
  }

  private persist(): void {
    try {
      mkdirSync(resolve(this.path, '..'), { recursive: true });
      const tmp = this.path + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.cache ?? {}, null, 2), 'utf-8');
      renameSync(tmp, this.path);
    } catch { /* 记账失败不影响主流程 */ }
  }

  /** 文件名消毒：与记忆库同规则（防 .usage.json 键名注入路径） */
  private key(name: string, svc?: MemoryService): string | null {
    return (svc ?? { sanitizeName: defaultSanitize } as any).sanitizeName(String(name ?? ''));
  }

  /** 命中记账（read/search 命中均算） */
  recordUse(names: string[], svc?: MemoryService, now = new Date()): void {
    if (names.length === 0) return;
    const db = this.load();
    let changed = false;
    for (const n of names) {
      const k = this.key(n, svc);
      if (!k) continue;
      const rec = db[k] ?? { useCount: 0, lastUsedAt: now.toISOString(), misleads: 0 };
      db[k] = { ...rec, useCount: rec.useCount + 1, lastUsedAt: now.toISOString() };
      changed = true;
    }
    if (changed) this.persist();
  }

  /** 误导记账：读过该记忆的 run 失败收尾（弱归因 — 只记录不处置） */
  recordSuspect(names: string[], svc?: MemoryService, now = new Date()): void {
    if (names.length === 0) return;
    const db = this.load();
    let changed = false;
    for (const n of names) {
      const k = this.key(n, svc);
      if (!k) continue;
      const rec = db[k] ?? { useCount: 0, lastUsedAt: now.toISOString(), misleads: 0 };
      db[k] = { ...rec, misleads: rec.misleads + 1, lastSuspectAt: now.toISOString() };
      changed = true;
    }
    if (changed) this.persist();
  }

  /** 与文件列表合并的统计视图（UI/API 用） */
  stats(svc: MemoryService, now = Date.now()): MemoryUsageStat[] {
    const db = this.load();
    return svc.list().map(f => {
      const rec = db[f.name];
      const lastMs = rec ? Date.parse(rec.lastUsedAt) : NaN;
      const idleDays = rec && Number.isFinite(lastMs)
        ? Math.floor((now - lastMs) / 86_400_000)
        : null;
      return {
        name: f.name,
        useCount: rec?.useCount ?? 0,
        lastUsedAt: rec?.lastUsedAt ?? null,
        misleads: rec?.misleads ?? 0,
        idleDays,
        flagged: (rec?.misleads ?? 0) >= SUSPECT_THRESHOLD,
        stale: idleDays !== null && idleDays >= STALE_DAYS,
      };
    });
  }
}

/** 兜底消毒（未注入 MemoryService 时）：与 memory-service 同规则的最小实现 */
function defaultSanitize(raw: string): string | null {
  let name = String(raw ?? '').trim().replace(/[^\w\u4e00-\u9fa5.-]/g, '-').replace(/\/|\\/g, '-');
  if (!name || /^[.-]+$/.test(name)) return null;
  if (name.length > 64) name = name.slice(0, 64);
  if (!name.endsWith('.md')) name += '.md';
  return name;
}
