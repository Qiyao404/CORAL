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

/** 会话内决策（what + why — 原因是决策能指导后续会话的关键） */
export interface SessionDecision {
  what: string;
  why: string;
  at: string;
}

/** 接力记录：下次续接会话的开场简报（中断处/下一步/阻塞） */
export interface SessionHandoff {
  goal: string;
  leftOff: string;
  nextSteps: string[];
  blockers: string[];
  updatedAt: string;
}

export interface SessionContext {
  sessionId: string;
  /** 本会话讨论过的文件摘要 */
  fileSummaries: SessionFileSummary[];
  /** 会话要点（每轮 run 结束后可选追加） */
  keyPoints: string[];
  /** 本会话累积的关键决策 */
  decisions: SessionDecision[];
  /** 上次 run 结束时的接力记录（有未竟工作才有） */
  handoff?: SessionHandoff;
  updatedAt: string;
}

const MAX_FILE_SUMMARIES = 20;
const MAX_KEY_POINTS = 30;
const MAX_DECISIONS = 20;
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

  /** 读取会话上下文（不存在返回空结构；旧版文件自动补默认字段） */
  get(sessionId: string): SessionContext {
    const path = this.contextPath(sessionId);
    if (!existsSync(path)) {
      return { sessionId, fileSummaries: [], keyPoints: [], decisions: [], updatedAt: new Date().toISOString() };
    }
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        sessionId,
        fileSummaries: Array.isArray(parsed.fileSummaries) ? parsed.fileSummaries : [],
        keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
        ...(parsed.handoff && typeof parsed.handoff === 'object' ? { handoff: parsed.handoff } : {}),
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      };
    } catch {
      return { sessionId, fileSummaries: [], keyPoints: [], decisions: [], updatedAt: new Date().toISOString() };
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

  /** 追加一条决策（what + why） */
  addDecision(sessionId: string, what: string, why: string): void {
    const ctx = this.get(sessionId);
    ctx.decisions.push({
      what: what.slice(0, 300),
      why: why.slice(0, 500),
      at: new Date().toISOString(),
    });
    if (ctx.decisions.length > MAX_DECISIONS) {
      ctx.decisions = ctx.decisions.slice(-MAX_DECISIONS);
    }
    this.save(sessionId, ctx);
  }

  /** 更新接力记录（每轮 run 结束时覆盖 — 永远反映最新中断点） */
  setHandoff(sessionId: string, handoff: { leftOff: string; nextSteps: string[]; blockers: string[] }): void {
    const ctx = this.get(sessionId);
    ctx.handoff = {
      goal: (ctx.handoff?.goal ?? '').slice(0, 300),
      leftOff: handoff.leftOff.slice(0, 300),
      nextSteps: handoff.nextSteps.map(s => String(s).slice(0, 200)).slice(0, 6),
      blockers: handoff.blockers.map(s => String(s).slice(0, 200)).slice(0, 6),
      updatedAt: new Date().toISOString(),
    };
    this.save(sessionId, ctx);
  }

  /** 记录会话总目标（首个 run 创建时） */
  setGoal(sessionId: string, goal: string): void {
    const ctx = this.get(sessionId);
    if (!ctx.handoff) {
      ctx.handoff = {
        goal: goal.slice(0, 300),
        leftOff: '',
        nextSteps: [],
        blockers: [],
        updatedAt: new Date().toISOString(),
      };
    } else if (!ctx.handoff.goal) {
      ctx.handoff.goal = goal.slice(0, 300);
    }
    this.save(sessionId, ctx);
  }

  /** 生成注入系统提示的上下文文本 */
  toPromptText(sessionId: string): string {
    const ctx = this.get(sessionId);
    if (ctx.fileSummaries.length === 0 && ctx.keyPoints.length === 0 && ctx.decisions.length === 0 && !ctx.handoff?.leftOff) return '';

    const parts: string[] = [];
    // 接力简报放最前 — 续接会话第一眼要看到"上次到哪了"
    if (ctx.handoff?.leftOff) {
      const h = ctx.handoff;
      parts.push(
        `## 上次中断处（本会话续接简报）\n` +
        `- 中断点: ${h.leftOff}` +
        (h.nextSteps.length ? `\n- 下一步: ${h.nextSteps.join('；')}` : '') +
        (h.blockers.length ? `\n- 阻塞: ${h.blockers.join('；')}` : '')
      );
    }
    if (ctx.fileSummaries.length > 0) {
      parts.push('## 本会话已分析的文件（摘要）');
      for (const f of ctx.fileSummaries) {
        parts.push(`### ${f.filename}\n${f.summary}`);
      }
    }
    if (ctx.decisions.length > 0) {
      parts.push('## 本会话关键决策');
      for (const d of ctx.decisions.slice(-8)) {
        parts.push(`- ${d.what}（原因: ${d.why}）`);
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

  /** 压缩：合并旧要点+文件摘要为精简版（决策与接力记录保留） */
  compress(sessionId: string, summary: string): void {
    const prev = this.get(sessionId);
    const ctx: SessionContext = {
      sessionId,
      fileSummaries: [],
      keyPoints: [summary.slice(0, MAX_SUMMARY_CHARS)],
      decisions: prev.decisions,
      ...(prev.handoff ? { handoff: prev.handoff } : {}),
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
