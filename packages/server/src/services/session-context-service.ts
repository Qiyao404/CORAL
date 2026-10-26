import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';

/**
 * 会话级上下文管理（用户实测需求：文件总结归会话，不归长期记忆）。
 *
 * 每个对话（session）有自己的上下文目录 `data/sessions/{sessionId}/`，
 * 存储：文件摘要、任务进展、会话内约定 — 这些信息跨 run 共享但跨会话隔离。
 * 长期记忆（data/memory/）只存通用偏好/项目约定/经验教训。
 */

export interface SessionFileSummary {
  filename: string;
  summary: string;
  addedAt: string;
}

export interface SessionContext {
  sessionId: string;
  /** 本会话讨论过的文件摘要 */
  fileSummaries: SessionFileSummary[];
  /** 会话要点（每轮 run 结束后可选追加） */
  keyPoints: string[];
  updatedAt: string;
}

const MAX_FILE_SUMMARIES = 20;
const MAX_KEY_POINTS = 30;
const MAX_SUMMARY_CHARS = 2000;
const MAX_TOTAL_CHARS = 64 * 1024;

export class SessionContextService {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir, 'sessions');
  }

  private sessionDir(sessionId: string): string {
    return join(this.baseDir, sessionId);
  }

  private contextPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'context.json');
  }

  /** 读取会话上下文（不存在返回空结构） */
  get(sessionId: string): SessionContext {
    const path = this.contextPath(sessionId);
    if (!existsSync(path)) {
      return { sessionId, fileSummaries: [], keyPoints: [], updatedAt: new Date().toISOString() };
    }
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        sessionId,
        fileSummaries: Array.isArray(parsed.fileSummaries) ? parsed.fileSummaries : [],
        keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      };
    } catch {
      return { sessionId, fileSummaries: [], keyPoints: [], updatedAt: new Date().toISOString() };
    }
  }

  /** 记录/更新文件摘要 */
  addFileSummary(sessionId: string, filename: string, summary: string): void {
    const ctx = this.get(sessionId);
    const trimmed = summary.slice(0, MAX_SUMMARY_CHARS);
    const existing = ctx.fileSummaries.findIndex(f => f.filename === filename);
    const entry: SessionFileSummary = { filename, summary: trimmed, addedAt: new Date().toISOString() };
    if (existing >= 0) {
      ctx.fileSummaries[existing] = entry;
    } else {
      ctx.fileSummaries.push(entry);
      if (ctx.fileSummaries.length > MAX_FILE_SUMMARIES) {
        ctx.fileSummaries = ctx.fileSummaries.slice(-MAX_FILE_SUMMARIES);
      }
    }
    this.save(sessionId, ctx);
  }

  /** 追加会话要点 */
  addKeyPoint(sessionId: string, point: string): void {
    const ctx = this.get(sessionId);
    ctx.keyPoints.push(point.slice(0, 500));
    if (ctx.keyPoints.length > MAX_KEY_POINTS) {
      ctx.keyPoints = ctx.keyPoints.slice(-MAX_KEY_POINTS);
    }
    this.save(sessionId, ctx);
  }

  /** 生成注入系统提示的上下文文本 */
  toPromptText(sessionId: string): string {
    const ctx = this.get(sessionId);
    if (ctx.fileSummaries.length === 0 && ctx.keyPoints.length === 0) return '';

    const parts: string[] = [];
    if (ctx.fileSummaries.length > 0) {
      parts.push('## 本会话已分析的文件（摘要）');
      for (const f of ctx.fileSummaries) {
        parts.push(`### ${f.filename}\n${f.summary}`);
      }
    }
    if (ctx.keyPoints.length > 0) {
      parts.push('## 本会话要点');
      ctx.keyPoints.forEach((p, i) => parts.push(`${i + 1}. ${p}`));
    }
    const text = parts.join('\n\n');
    return text.length > MAX_TOTAL_CHARS ? text.slice(0, MAX_TOTAL_CHARS) + '\n[...已截断]' : text;
  }

  /** 获取总字符量（上下文压缩判断用） */
  totalChars(sessionId: string): number {
    return this.toPromptText(sessionId).length;
  }

  /** 压缩：合并旧要点+文件摘要为精简版 */
  compress(sessionId: string, summary: string): void {
    const ctx: SessionContext = {
      sessionId,
      fileSummaries: [],
      keyPoints: [summary.slice(0, MAX_SUMMARY_CHARS)],
      updatedAt: new Date().toISOString(),
    };
    this.save(sessionId, ctx);
  }

  /** 删除会话上下文（删会话时调用） */
  delete(sessionId: string): void {
    const dir = this.sessionDir(sessionId);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  private save(sessionId: string, ctx: SessionContext): void {
    const dir = this.sessionDir(sessionId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    ctx.updatedAt = new Date().toISOString();
    writeFileSync(this.contextPath(sessionId), JSON.stringify(ctx, null, 2), 'utf-8');
  }
}
