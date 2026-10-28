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
  updatedAt?: string;
}

const LIMITS = { maxTokens: { min: 100_000, max: 10_000_000 }, maxSteps: { min: 5, max: 200 } };

export class RunBudgetSettingsService {
  private path: string;

  constructor(baseDir?: string) {
    this.path = baseDir
      ? join(resolve(baseDir), 'run-budget.json')
      : join(dirname(resolve(platformConfig.databasePath)), 'run-budget.json');
  }

  get(): RunBudgetSettings {
    try {
      if (!existsSync(this.path)) return { maxTokens: null, maxSteps: null };
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8'));
      return {
        maxTokens: clampOrNull(parsed.maxTokens, LIMITS.maxTokens),
        maxSteps: clampOrNull(parsed.maxSteps, LIMITS.maxSteps),
        ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
      };
    } catch {
      return { maxTokens: null, maxSteps: null }; // 损坏按未设置处理
    }
  }

  /** 生效值解析（设置 > 平台默认），供 run-engine 直接取用 */
  effective(): { maxTokens: number; maxSteps: number } {
    const s = this.get();
    return {
      maxTokens: s.maxTokens ?? platformConfig.runMaxTokens,
      maxSteps: s.maxSteps ?? platformConfig.runMaxSteps,
    };
  }

  set(patch: { maxTokens?: number | null; maxSteps?: number | null }): RunBudgetSettings {
    const cur = this.get();
    const next: RunBudgetSettings = {
      maxTokens: patch.maxTokens === undefined ? cur.maxTokens : clampOrNull(patch.maxTokens, LIMITS.maxTokens),
      maxSteps: patch.maxSteps === undefined ? cur.maxSteps : clampOrNull(patch.maxSteps, LIMITS.maxSteps),
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
  return Math.min(Math.max(Math.round(n), lim.min), lim.max);
}
