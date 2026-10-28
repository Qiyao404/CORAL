import { existsSync, readdirSync, statSync, mkdirSync, renameSync, writeFileSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

/**
 * 配置自清理例程 — 把"垃圾回收"隐喻用到运行时数据目录。
 *
 * 原则（每一级都为"误删可恢复 + 永不批量连坐"设计）：
 *  · 只扫描不删除 — scan() 出清单，clean() 只处理用户逐项勾选的 ID（禁止全选默认）
 *  · 软删除 — 移入 data/.gc_trash/<时间戳>/，gc_log.md 记录每笔与撤销方法
 *  · 每轮上限 20 条 — GC 是周期性的，不是一次性的
 *
 * 扫描通道（各自独立过期信号）：
 *  · stale-evidence  — 超过 N 天未访问的证据记录 run 目录（默认 14 天）
 *  · orphan-session  — data/sessions/ 下已无任何 run 指向的会话目录
 *  · broken-skill    — skills/ 下缺 SKILL.md 或 frontmatter 损坏的目录
 *  · trash-bloat     — skills/.trash 体积超阈值
 */

export type GcChannel = 'stale-evidence' | 'orphan-session' | 'broken-skill' | 'trash-bloat';

export interface GcItem {
  id: string;
  channel: GcChannel;
  label: string;
  detail?: string;
  sizeBytes?: number;
  /** 清理动作说明（软删除目标） */
  action: string;
}

export interface GcScanResult {
  items: GcItem[];
  scannedAt: string;
}

export interface GcCleanResult {
  cleaned: Array<{ id: string; label: string; movedTo: string }>;
  skipped: Array<{ id: string; reason: string }>;
  logFile: string;
}

const MAX_ITEMS_PER_RUN = 20;
const EVIDENCE_STALE_DAYS = 14;
const TRASH_BLOAT_BYTES = 50 * 1024 * 1024;

interface RunStoreLike {
  list(opts: { sessionId?: string; limit: number }): { items: Array<{ id?: string; sessionId?: string | null }> };
}

function dirSize(p: string): number {
  let total = 0;
  try {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const child = join(p, e.name);
      if (e.isDirectory()) total += dirSize(child);
      else total += statSync(child).size;
    }
  } catch { /* ignore */ }
  return total;
}

function isBrokenSkillDir(dir: string): string | null {
  const md = join(dir, 'SKILL.md');
  if (!existsSync(md)) return '缺 SKILL.md';
  try {
    // CRLF 归一（Windows 下 frontmatter 匹配的行尾陷阱）
    const text = readFileSync(md, 'utf-8').replace(/\r\n/g, '\n');
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return 'frontmatter 缺失';
    if (!/^name:/m.test(fm[1]) || !/^description:/m.test(fm[1])) return 'frontmatter 缺 name/description';
    return null;
  } catch {
    return '读取失败';
  }
}

export class ConfigGcService {
  private dataDir: string;
  private skillsDir: string;

  constructor(dataDir: string, skillsDir: string, private runStore: RunStoreLike) {
    this.dataDir = resolve(dataDir);
    this.skillsDir = resolve(skillsDir);
  }

  /** 全通道扫描（只读，不删任何东西） */
  scan(): GcScanResult {
    const items: GcItem[] = [];
    const now = Date.now();

    // 通道 1：过期证据记录
    const evidenceDir = join(this.dataDir, 'evidence');
    if (existsSync(evidenceDir)) {
      for (const entry of readdirSync(evidenceDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(evidenceDir, entry.name);
        try {
          const mtime = statSync(dir).mtimeMs;
          if (now - mtime > EVIDENCE_STALE_DAYS * 86_400_000) {
            items.push({
              id: `evidence:${entry.name}`,
              channel: 'stale-evidence',
              label: `证据记录 run ${entry.name}`,
              detail: `最后访问 ${(new Date(mtime)).toLocaleDateString()}（>${EVIDENCE_STALE_DAYS} 天）`,
              sizeBytes: dirSize(dir),
              action: '移入回收站（对应 run 若仍存在，重跑时证据不可再取回）',
            });
          }
        } catch { /* ignore */ }
      }
    }

    // 通道 2：孤儿会话目录
    const sessionsDir = join(this.dataDir, 'sessions');
    if (existsSync(sessionsDir)) {
      for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const { items: runs } = this.runStore.list({ sessionId: entry.name, limit: 1 });
        if (runs.length === 0) {
          const dir = join(sessionsDir, entry.name);
          items.push({
            id: `session:${entry.name}`,
            channel: 'orphan-session',
            label: `会话目录 ${entry.name}`,
            detail: '已无任何 run 指向（会话与 run 已删除）',
            sizeBytes: dirSize(dir),
            action: '移入回收站（内含 context.json 会话上下文与决策记录）',
          });
        }
      }
    }

    // 通道 3：损坏技能目录
    if (existsSync(this.skillsDir)) {
      for (const entry of readdirSync(this.skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === '_lib') continue;
        const broken = isBrokenSkillDir(join(this.skillsDir, entry.name));
        if (broken) {
          items.push({
            id: `skill:${entry.name}`,
            channel: 'broken-skill',
            label: `技能目录 ${entry.name}`,
            detail: broken,
            action: '移入回收站（启动时本就会跳过它）',
          });
        }
      }
    }

    // 通道 4：回收站膨胀
    const trashDir = join(this.skillsDir, '.trash');
    if (existsSync(trashDir)) {
      const size = dirSize(trashDir);
      if (size > TRASH_BLOAT_BYTES) {
        items.push({
          id: 'trash:skills',
          channel: 'trash-bloat',
          label: 'skills/.trash 回收站',
          detail: `${(size / 1024 / 1024).toFixed(1)}MB（>${TRASH_BLOAT_BYTES / 1024 / 1024}MB）`,
          sizeBytes: size,
          action: '移入回收站的回收站（此动作不可再撤销，请确认里面没有要恢复的技能）',
        });
      }
    }

    return { items, scannedAt: new Date().toISOString() };
  }

  /**
   * 逐项清理（软删除）：只处理选中的 ID，上限 20 条/轮。
   * 每笔移入 data/.gc_trash/<时间戳>/ 并追加 gc_log.md。
   */
  clean(selectedIds: string[]): GcCleanResult {
    const { items } = this.scan();
    const byId = new Map(items.map(i => [i.id, i]));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trashRoot = join(this.dataDir, '.gc_trash', stamp);
    const cleaned: GcCleanResult['cleaned'] = [];
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const id of selectedIds.slice(0, MAX_ITEMS_PER_RUN)) {
      const item = byId.get(id);
      if (!item) { skipped.push({ id, reason: '清单中不存在（可能已被清理或状态已变）' }); continue; }
      try {
        const source = this.sourcePath(item.id);
        if (!source || !existsSync(source)) { skipped.push({ id, reason: '源路径不存在' }); continue; }
        // trash-bloat 特判：目标是回收站本身 — 直接种子式归档（保留一层）
        const destDir = join(trashRoot, item.channel);
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
        const dest = join(destRoot(destDir, item));
        renameSync(source, dest);
        cleaned.push({ id, label: item.label, movedTo: dest });
      } catch (err: any) {
        skipped.push({ id, reason: err?.message ?? String(err) });
      }
    }

    // gc_log.md（追加；含撤销说明）
    const logFile = join(this.dataDir, '.gc_trash', 'gc_log.md');
    try {
      if (!existsSync(join(this.dataDir, '.gc_trash'))) mkdirSync(join(this.dataDir, '.gc_trash'), { recursive: true });
      const lines = [
        `\n## ${stamp}`,
        ...cleaned.map(c => `- 清理: ${c.label}（${c.id}）→ ${c.movedTo}（撤销: 移回原位即可）`),
        ...skipped.map(s => `- 跳过: ${s.id} — ${s.reason}`),
      ];
      const existing = existsSync(logFile) ? readFileSync(logFile, 'utf-8') : '# 配置自清理日志\n';
      writeFileSync(logFile, existing + lines.join('\n') + '\n', 'utf-8');
    } catch { /* 日志失败不回滚清理 */ }

    return { cleaned, skipped, logFile };
  }

  /** GC 项 ID → 磁盘源路径 */
  private sourcePath(id: string): string | null {
    const [channel, ...rest] = id.split(':');
    const name = rest.join(':');
    switch (channel) {
      case 'evidence': return join(this.dataDir, 'evidence', name);
      case 'session': return join(this.dataDir, 'sessions', name);
      case 'skill': return join(this.skillsDir, name);
      case 'trash': return join(this.skillsDir, '.trash');
      default: return null;
    }
  }
}

/** 回收站内的去重目标名（同名冲突时自动加序号） */
function destRoot(destDir: string, item: GcItem): string {
  const base = item.id.split(':').pop() ?? item.id.replace(/:/g, '-');
  let dest = join(destDir, base);
  let n = 1;
  while (existsSync(dest)) {
    dest = join(destDir, `${base}.${n++}`);
  }
  return dest;
}
