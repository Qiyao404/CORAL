import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import type { ChatMessage } from '../providers/types.js';

/**
 * 证据记录层（summary-first 结果管理）。
 *
 * 设计原则：
 *  · 大结果不进上下文 — 超过预算的工具结果整体落盘为不可变"证据记录"，
 *    上下文里只保留「摘要预览 + 记录 ID」；模型需要细节时用 evidence_read 翻页取回。
 *  · 不可变 — 记录一旦写入永不改写（追加式存储），可被后续轮次/其他工具引用。
 *  · 本地优先 — 记录就是 data/evidence/{runId}/ 下的 JSON 文件，用户可直接打开。
 *  · 零依赖 — 纯 fs 实现；配合按 run 归档，删除 run 时一并清理。
 */

/** 默认结果预算：超过此长度的工具结果转入证据记录（工具可用 maxResultSizeChars 覆盖） */
export const DEFAULT_EVIDENCE_THRESHOLD = 12_000;

export interface EvidenceRecord {
  id: string;
  runId: string;
  tool: string;
  /** 完整结果的 JSON 序列化文本（不可变） */
  content: string;
  chars: number;
  createdAt: string;
}

export class EvidenceStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir, 'evidence');
  }

  private runDir(runId: string): string {
    // runId 进入路径前消毒（只留安全字符，防路径注入）
    const safe = String(runId).replace(/[^a-zA-Z0-9_-]/g, '');
    return join(this.baseDir, safe);
  }

  private recordPath(runId: string, id: string): string {
    return join(this.runDir(runId), `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
  }

  /** 写入一条证据记录（不可变：同 ID 已存在则原样保留） */
  save(runId: string, tool: string, content: string): EvidenceRecord {
    const rec: EvidenceRecord = {
      id: `ev-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      runId: String(runId),
      tool: String(tool).slice(0, 64),
      content,
      chars: content.length,
      createdAt: new Date().toISOString(),
    };
    const dir = this.runDir(runId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = this.recordPath(runId, rec.id);
    if (!existsSync(path)) {
      writeFileSync(path, JSON.stringify(rec, null, 2), 'utf-8');
    }
    return rec;
  }

  /** 读取记录（分页：offset/limit 按字符） */
  read(runId: string, id: string, offset = 0, limit = 8000): { record: EvidenceRecord; page: string; offset: number; limit: number; hasMore: boolean } | null {
    const path = this.recordPath(runId, id);
    if (!existsSync(path)) return null;
    try {
      const rec = JSON.parse(readFileSync(path, 'utf-8')) as EvidenceRecord;
      const page = rec.content.slice(offset, offset + limit);
      return { record: rec, page, offset, limit, hasMore: offset + limit < rec.chars };
    } catch {
      return null;
    }
  }

  /** 列出某 run 的全部记录（新→旧） */
  list(runId: string): Array<Pick<EvidenceRecord, 'id' | 'tool' | 'chars' | 'createdAt'>> {
    const dir = this.runDir(runId);
    if (!existsSync(dir)) return [];
    const out: Array<Pick<EvidenceRecord, 'id' | 'tool' | 'chars' | 'createdAt'>> = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
        out.push({ id: rec.id, tool: rec.tool, chars: rec.chars, createdAt: rec.createdAt });
      } catch { /* 损坏记录跳过 */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 删除 run 时清理其全部记录 */
  deleteRun(runId: string): void {
    const dir = this.runDir(runId);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /** 清理超过 N 天未访问的 run 记录（配置自清理例程调用）；返回释放的目录数 */
  purgeOlderThanDays(days: number, now = Date.now()): number {
    if (!existsSync(this.baseDir)) return 0;
    let removed = 0;
    for (const entry of readdirSync(this.baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(this.baseDir, entry.name);
      try {
        const st = statSync(dir);
        if (now - st.mtimeMs > days * 86_400_000) {
          rmSync(dir, { recursive: true, force: true });
          removed++;
        }
      } catch { /* ignore */ }
    }
    return removed;
  }
}

/**
 * 把超预算的工具结果转成「摘要 + 证据 ID」的消息体。
 * 预览保留头尾（模型通常需要开头判断性质、结尾看结论）。
 */
export function summarizeForEvidence(rec: EvidenceRecord, previewHead = 900, previewTail = 400): string {
  const head = rec.content.slice(0, previewHead);
  const tail = rec.content.slice(-previewTail);
  return JSON.stringify({
    note: `结果过大（${rec.chars} 字符），完整内容已存为证据记录 ${rec.id}。需要更多细节时调用 evidence_read（evidence_id="${rec.id}"，可翻页 offset/limit）。`,
    totalChars: rec.chars,
    preview: rec.chars <= previewHead + previewTail ? rec.content : `${head}\n[...省略 ${rec.chars - previewHead - previewTail} 字符...]\n${tail}`,
    evidenceId: rec.id,
    evidenceTool: rec.tool,
  });
}

/** 结果预算：工具级 maxResultSizeChars 优先，未声明用全局默认 */
export function evidenceThreshold(tools: { name: string; maxResultSizeChars?: number }[], toolName: string): number {
  return tools.find(t => t.name === toolName)?.maxResultSizeChars ?? DEFAULT_EVIDENCE_THRESHOLD;
}

/** 从消息历史中提取「最近一次证据归档的 ID」（供 evidence_read 默认参数用） */
export function lastEvidenceId(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    const match = m.content.match(/"evidenceId":\s*"(ev-[a-z0-9-]+)"/);
    if (match) return match[1];
  }
  return null;
}
