/**
 * CORAL_PROGRESS 协议解析器（T-104）
 *
 * 协议规范（详见 docs/DESIGN.md §4）：
 *   stderr 单行 JSON，前缀 `[CORAL_PROGRESS]`，例如：
 *     [CORAL_PROGRESS] {"phase":"scraping","step":3,"total":8,"percent":37,"message":"正在抓取佛山政数局"}
 *
 * 非协议行作为普通日志（skill.log）下发。
 */

export interface ProgressEvent {
  phase: string;
  step?: number;
  total?: number;
  percent?: number;
  message: string;
  detail?: Record<string, any>;
}

export interface LogLine {
  message: string;
  level?: 'info' | 'warn' | 'error' | 'debug';
}

export interface ParseResult {
  progressEvents: ProgressEvent[];
  logLines: LogLine[];
}

const PROGRESS_PREFIX = /^\s*\[CORAL_PROGRESS\]\s+(\{.*\})\s*$/;
const ERROR_HEUR = /\b(error|exception|traceback|failed|❌|fatal)\b/i;
const WARN_HEUR = /\b(warn|warning|deprecated|⚠)\b/i;

/** P3 加固：无换行残留的内存上限 — 二进制垃圾/巨型单行不能无限吃内存 */
const MAX_BUFFER_CHARS = 64 * 1024;

/**
 * 增量缓冲解析器 —— 用于 stderr 流式分行解析。
 * 不直接抛异常；非法 JSON / 非协议行都会落到 logLines。
 */
export class ProgressParser {
  private buffer = '';

  /** 喂入新到达的 chunk，返回从中分离出的 progress + log */
  feed(chunk: string | Buffer): ParseResult {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');

    const progressEvents: ProgressEvent[] = [];
    const logLines: LogLine[] = [];

    // 按行切；最后一段如果没换行则继续保留在 buffer 里（防止 JSON 跨 chunk 截断）
    const segments = this.buffer.split(/\r?\n/);
    this.buffer = segments.pop() ?? '';

    // 超过上限仍无换行 → 视为损坏输出，告警并只保留尾部（协议行若恰好在尾部仍可解析）
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      logLines.push({
        message: `[corrupt] 超长无换行输出已截断丢弃（${this.buffer.length} 字符，上限 ${MAX_BUFFER_CHARS}）`,
        level: 'warn',
      });
      this.buffer = this.buffer.slice(-1024);
    }

    for (const raw of segments) {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) continue;
      const m = line.match(PROGRESS_PREFIX);
      if (m) {
        try {
          const obj = JSON.parse(m[1]);
          const phase = String(obj.phase ?? 'unknown');
          const message = String(obj.message ?? '');
          const ev: ProgressEvent = {
            phase,
            message,
            ...(typeof obj.step === 'number' ? { step: obj.step } : {}),
            ...(typeof obj.total === 'number' ? { total: obj.total } : {}),
            ...(typeof obj.percent === 'number'
              ? { percent: clampPercent(obj.percent) }
              : (typeof obj.step === 'number' && typeof obj.total === 'number'
                ? { percent: clampPercent((obj.step / Math.max(1, obj.total)) * 100) }
                : {})),
            ...(obj.detail && typeof obj.detail === 'object' ? { detail: obj.detail } : {}),
          };
          progressEvents.push(ev);
        } catch {
          // JSON 不合法 —— 当成普通日志下发
          logLines.push({ message: line, level: 'warn' });
        }
        continue;
      }
      logLines.push({ message: line, level: heuristicLevel(line) });
    }

    return { progressEvents, logLines };
  }

  /** 调用方关闭流时把残留 buffer 清空（按 log 处理）*/
  flush(): ParseResult {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return { progressEvents: [], logLines: [] };
    }
    const tail = this.buffer;
    this.buffer = '';
    return this.feed(tail + '\n');
  }
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  if (p < 0) return 0;
  if (p > 100) return 100;
  return Math.round(p * 100) / 100;
}

function heuristicLevel(line: string): 'info' | 'warn' | 'error' {
  if (ERROR_HEUR.test(line)) return 'error';
  if (WARN_HEUR.test(line)) return 'warn';
  return 'info';
}

/** 单次（非流式）便捷 API：用于一次性解析完整文本 */
export function parseProgressText(text: string): ParseResult {
  const parser = new ProgressParser();
  const a = parser.feed(text.endsWith('\n') ? text : text + '\n');
  return a;
}
