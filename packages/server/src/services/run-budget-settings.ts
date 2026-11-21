import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { platformConfig } from './config.js';

/**
 * 运行预算的用户设置 — data/run-budget.json（设置页可改，立即生效于新 run）。
 *
 * 优先级：请求级 budget（API/触发器显式传参）> 本设置 > 平台默认（RUN_MAX_TOKENS 环境变量）。
 * 存储：JSON 文件（透明可编辑；与记忆/习惯同一哲学 — data/ 目录就是用户的手中物）。
 */

export interface RunBudgetSettings {
  /** token 上限；null = 跟随平台默认 */
  maxTokens: number | null;
  /** 步数上限；null = 跟随平台默认 */
  maxSteps: number | null;
  /** 反问等待超时（分钟）；0 = 无限等待（默认），>0 超时后按推荐/假设继续 */
  askUserTimeoutMin: number;
  /** 验证工程（交付验收）：默认 true — 工作区交互 run 开工生成验收清单、交付前独立验证 */
  verificationEnabled: boolean;
  /** 记忆实体索引：默认 true，记忆文件数 ≥ 阈值时自动生效 */
  entityIndexEnabled: boolean;
  /** 实体索引自动启用的文件数阈值（默认 8） */
  entityIndexThreshold: number;
  /** 记忆超量整理触发阈值（默认 15；实体索引生效时自动放宽到 max(此值, 30) — 检索变强，库可以大） */
  consolidateMaxFiles: number;
  updatedAt?: string;
}

/** 0 = 无上限；其余值夹在 [min, max] */
const LIMITS = { maxTokens: { min: 100_000, max: 1_000_000_000 }, maxSteps: { min: 5, max: 100_000 } };

export class RunBudgetSettingsService {
  private path: string;

  constructor(baseDir?: string) {
    this.path = baseDir
      ? join(resolve(baseDir), 'run-budget.json')
      : join(dirname(resolve(platformConfig.databasePath)), 'run-budget.json');
  }

  get(): RunBudgetSettings {
    try {
      if (!existsSync(this.path)) return { maxTokens: null, maxSteps: null, askUserTimeoutMin: 0, verificationEnabled: true, entityIndexEnabled: true, entityIndexThreshold: 8, consolidateMaxFiles: 15 };
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8'));
      return {
        maxTokens: clampOrNull(parsed.maxTokens, LIMITS.maxTokens),
        maxSteps: clampOrNull(parsed.maxSteps, LIMITS.maxSteps),
        askUserTimeoutMin: clampNonNeg(parsed.askUserTimeoutMin),
        verificationEnabled: parsed.verificationEnabled !== false,
        entityIndexEnabled: parsed.entityIndexEnabled !== false,
        entityIndexThreshold: clampNonNeg(parsed.entityIndexThreshold) || 8,
        consolidateMaxFiles: clampNonNeg(parsed.consolidateMaxFiles) || 15,
        ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
      };
    } catch {
      return { maxTokens: null, maxSteps: null, askUserTimeoutMin: 0, verificationEnabled: true, entityIndexEnabled: true, entityIndexThreshold: 8, consolidateMaxFiles: 15 }; // 损坏按未设置处理
    }
  }

  /** 生效值解析（设置 > 平台默认），供 run-engine 直接取用 */
  effective(): { maxTokens: number; maxSteps: number; askUserTimeoutMin: number; verificationEnabled: boolean; entityIndexEnabled: boolean; entityIndexThreshold: number; consolidateMaxFiles: number } {
    const s = this.get();
    return {
      maxTokens: s.maxTokens ?? platformConfig.runMaxTokens,
      maxSteps: s.maxSteps ?? platformConfig.runMaxSteps,
      askUserTimeoutMin: s.askUserTimeoutMin ?? 0,
      verificationEnabled: s.verificationEnabled,
      entityIndexEnabled: s.entityIndexEnabled,
      entityIndexThreshold: s.entityIndexThreshold,
      consolidateMaxFiles: s.consolidateMaxFiles,
    };
  }

  set(patch: { maxTokens?: number | null; maxSteps?: number | null; askUserTimeoutMin?: number; verificationEnabled?: boolean; entityIndexEnabled?: boolean; entityIndexThreshold?: number; consolidateMaxFiles?: number }): RunBudgetSettings {
    const cur = this.get();
    const next: RunBudgetSettings = {
      maxTokens: patch.maxTokens === undefined ? cur.maxTokens : clampOrNull(patch.maxTokens, LIMITS.maxTokens),
      maxSteps: patch.maxSteps === undefined ? cur.maxSteps : clampOrNull(patch.maxSteps, LIMITS.maxSteps),
      askUserTimeoutMin: patch.askUserTimeoutMin === undefined ? cur.askUserTimeoutMin : clampNonNeg(patch.askUserTimeoutMin),
      verificationEnabled: patch.verificationEnabled === undefined ? cur.verificationEnabled : patch.verificationEnabled === true,
      entityIndexEnabled: patch.entityIndexEnabled === undefined ? cur.entityIndexEnabled : patch.entityIndexEnabled === true,
      entityIndexThreshold: patch.entityIndexThreshold === undefined ? cur.entityIndexThreshold : (clampNonNeg(patch.entityIndexThreshold) || 8),
      consolidateMaxFiles: patch.consolidateMaxFiles === undefined ? cur.consolidateMaxFiles : (clampNonNeg(patch.consolidateMaxFiles) || 15),
      updatedAt: new Date().toISOString(),
    };
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(next, null, 2), 'utf-8');
    return next;
  }
}

function clampOrNull(v: unknown, lim: { min: number; max: number }): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return 0; // 0 = 无上限（合法特殊值）
  return Math.min(Math.max(Math.round(n), lim.min), lim.max);
}

/** 非负整数（负数/非法 → 0）；反问等待超时用：0 = 无限等待 */
function clampNonNeg(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n), 24 * 60);
}
