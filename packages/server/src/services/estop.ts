import { existsSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { platformConfig } from './config.js';

/**
 * ESTOP 急停哨兵 — 一个文件存在即停所有新工作（触发器/cron/新 run），
 * 正在跑的不杀（优雅降级而非硬中断）。
 *
 * 设计要点（哨兵文件式急停的三条铁律）：
 *  · 零开销：不存在时就是一次 existsSync，热路径无感
 *  · fail-safe：文件损坏/读不出来也视为"已拉闸"（宁可误停不可误跑）
 *  · 人因友好：`coral pause` / `coral resume` 就是创建/删除这个文件
 */

function estopPath(): string {
  return join(dirname(resolve(platformConfig.databasePath)), 'ESTOP');
}

/** 是否处于急停状态（文件存在即停；损坏的哨兵文件同样视为生效） */
export function isEstopped(): boolean {
  try {
    return existsSync(estopPath());
  } catch {
    return true; // 连探测都失败 — fail-safe 拉闸
  }
}

/** 拉闸（可在文件里写一句原因，急停提示会带上） */
export function engageEstop(reason?: string): string {
  const p = estopPath();
  writeFileSync(p, reason?.trim() || 'paused by user', 'utf-8');
  return p;
}

/** 解除 */
export function releaseEstop(): boolean {
  const p = estopPath();
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}

/** 急停原因（给报错信息用；无则给默认话术） */
export function estopReason(): string {
  try {
    const text = existsSync(estopPath()) ? readFileSync(estopPath(), 'utf-8').trim() : '';
    return text || '用户已暂停平台';
  } catch {
    return '用户已暂停平台';
  }
}
