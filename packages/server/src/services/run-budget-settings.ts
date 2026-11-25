import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { platformConfig } from './config.js';

/**
 * 运行预算的用户设置 — data/run-budget.json（设置页可改，立即生效于新 run）。
 *
 * 优先级：请求级 budget（API/触发器显式传参）> 本设置 > 平台默认（RUN_MAX_TOKENS 环境变量）。
 * 存储：JSON 文件（透明可编辑；与记忆/习惯同一哲学 — data/ 目录就是用户的手中物）。
 */

/**
 * 每个任务最多能派生多少个子代理 / 队友（agent_spawn 与 team_spawn 合计）的默认值。
 * 取 16 而不是文档里原先写的 8：接线修复前两个派生工具各拿一个计数器、实际各算 8 个（合计 16），
 * 修正接线时不应顺手把现有能力砍半。觉得太宽松可以在设置里调小，0 = 不允许派生。
 */
export const DEFAULT_MAX_SPAWNS = 16;
export const MAX_SPAWNS_LIMIT = 64;

export interface RunBudgetSettings {
  /** token 上限；null = 跟随平台默认 */
  maxTokens: number | null;
  /** 步数上限；null = 跟随平台默认 */
  maxSteps: number | null;
  /** 派生上限（agent_spawn + team_spawn 合计）；null = 跟随默认（16）；0 = 不允许派生 */
  maxSpawns: number | null;
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

const DEFAULTS: RunBudgetSettings = {
  maxTokens: null, maxSteps: null, maxSpawns: null, askUserTimeoutMin: 0,
  verificationEnabled: true, entityIndexEnabled: true, entityIndexThreshold: 8, consolidateMaxFiles: 15,
};

export class RunBudgetSettingsService {
  private path: string;

  constructor(baseDir?: string) {
    this.path = baseDir
      ? join(resolve(baseDir), 'run-budget.json')
      : join(dirname(resolve(platformConfig.databasePath)), 'run-budget.json');
  }

  get(): RunBudgetSettings {
    try {
      if (!existsSync(this.path)) return { ...DEFAULTS };
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8'));
      return {
        maxTokens: clampOrNull(parsed.maxTokens, LIMITS.maxTokens),
        maxSteps: clampOrNull(parsed.maxSteps, LIMITS.maxSteps),
        maxSpawns: clampSpawns(parsed.maxSpawns),
        askUserTimeoutMin: clampNonNeg(parsed.askUserTimeoutMin),
        verificationEnabled: parsed.verificationEnabled !== false,
        entityIndexEnabled: parsed.entityIndexEnabled !== false,
        entityIndexThreshold: clampNonNeg(parsed.entityIndexThreshold) || 8,
        consolidateMaxFiles: clampNonNeg(parsed.consolidateMaxFiles) || 15,
        ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
      };
    } catch {
      return { ...DEFAULTS }; // 损坏按未设置处理
    }
  }

  /** 生效值解析（设置 > 默认），供 run-engine 直接取用 */
  effective(): { maxTokens: number; maxSteps: number; maxSpawns: number; askUserTimeoutMin: number; verificationEnabled: boolean; entityIndexEnabled: boolean; entityIndexThreshold: number; consolidateMaxFiles: number } {
    const s = this.get();
    return {
      maxTokens: s.maxTokens ?? platformConfig.runMaxTokens,
      maxSteps: s.maxSteps ?? platformConfig.runMaxSteps,
      maxSpawns: s.maxSpawns ?? DEFAULT_MAX_SPAWNS,
      askUserTimeoutMin: s.askUserTimeoutMin ?? 0,
      verificationEnabled: s.verificationEnabled,
      entityIndexEnabled: s.entityIndexEnabled,
      entityIndexThreshold: s.entityIndexThreshold,
      consolidateMaxFiles: s.consolidateMaxFiles,
    };
  }

  set(patch: { maxTokens?: number | null; maxSteps?: number | null; maxSpawns?: number | null; askUserTimeoutMin?: number; verificationEnabled?: boolean; entityIndexEnabled?: boolean; entityIndexThreshold?: number; consolidateMaxFiles?: number }): RunBudgetSettings {
    const cur = this.get();
    const next: RunBudgetSettings = {
      maxTokens: patch.maxTokens === undefined ? cur.maxTokens : clampOrNull(patch.maxTokens, LIMITS.maxTokens),
      maxSteps: patch.maxSteps === undefined ? cur.maxSteps : clampOrNull(patch.maxSteps, LIMITS.maxSteps),
      maxSpawns: patch.maxSpawns === undefined ? cur.maxSpawns : clampSpawns(patch.maxSpawns),
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

/** 派生上限：空 / 非法 → null（跟随默认）；0 是合法值（不允许派生）；其余夹在 [1, 64] */
function clampSpawns(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n), MAX_SPAWNS_LIMIT);
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
