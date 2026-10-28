import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

/**
 * M1-11（D18）：文件式长期记忆 — `data/memory/` 目录 + Markdown 文件。
 *
 * 设计原则：
 *  · 零新依赖：search 是关键词 grep（空格分词 AND 语义），个人量级足够
 *  · 透明可编辑：记忆就是用户能直接打开修改的文本（个人工具的信任基础）
 *  · 不做向量库（M4 后可议 sqlite-vec 插件位）
 */

const MAX_CONTENT_CHARS = 64 * 1024;
const MAX_FILES = 500;
const MAX_NAME_CHARS = 64;
const NAME_ALLOWED = /[^\w\u4e00-\u9fa5.-]/g; // 允许：字母数字下划线连字符点号与中文

/** 信任分级：agent 写入默认 unreviewed；用户确认过内容属实 → reviewed */
export type MemoryTrust = 'unreviewed' | 'reviewed';

const TRUST_MARKER = /<!--\s*trust:\s*(unreviewed|reviewed)\s*-->/;

export interface MemoryFileMeta {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface MemorySearchMatch {
  file: string;
  line: number;
  text: string;
}

export interface MemoryReadResult {
  content: string;
  truncated: boolean;
  size: number;
  /** 文件头部的信任标记（无标记 = 用户手工创建/编辑过，视为 reviewed） */
  trust: MemoryTrust;
}

export class MemoryService {
  private dir: string;

  constructor(memoryDir: string) {
    this.dir = resolve(memoryDir);
  }

  get dirPath(): string {
    return this.dir;
  }

  private ensure(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  /** 文件名消毒：去路径分隔符与非法字符，补 .md 后缀；非法（清洗后为空/仅点号）返回 null */
  sanitizeName(raw: string): string | null {
    let name = String(raw ?? '').trim().replace(NAME_ALLOWED, '-').replace(/\/|\\/g, '-');
    if (!name || /^[.-]+$/.test(name)) return null;
    if (name.length > MAX_NAME_CHARS) name = name.slice(0, MAX_NAME_CHARS);
    if (!name.endsWith('.md')) name += '.md';
    return name;
  }

  list(): MemoryFileMeta[] {
    if (!existsSync(this.dir)) return [];
    const out: MemoryFileMeta[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.md')) continue;
      const abs = join(this.dir, f);
      try {
        const st = statSync(abs);
        out.push({ name: f, size: st.size, modifiedAt: st.mtime.toISOString() });
      } catch { /* 并发删除竞态，跳过 */ }
      if (out.length >= MAX_FILES) break;
    }
    out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return out;
  }

  read(name: string): MemoryReadResult | null {
    const safe = this.sanitizeName(name);
    if (!safe) return null;
    const abs = join(this.dir, safe);
    if (!existsSync(abs)) return null;
    const text = readFileSync(abs, 'utf-8');
    // 读取上限比写入上限宽 1KB — 写入截断时追加的标记行（约 30 字符）不会被二次切掉
    const READ_LIMIT = MAX_CONTENT_CHARS + 1024;
    const truncated = text.length > READ_LIMIT;
    const marker = TRUST_MARKER.exec(text.slice(0, 200));
    return {
      content: truncated ? text.slice(0, READ_LIMIT) : text,
      truncated,
      size: text.length,
      // 无标记 = 用户手工维护的内容，天然可信
      trust: marker ? (marker[1] as MemoryTrust) : 'reviewed',
    };
  }

  /** 文件是否已存在（防覆盖守卫用） */
  exists(name: string): boolean {
    const safe = this.sanitizeName(name);
    return Boolean(safe && existsSync(join(this.dir, safe)));
  }

  /**
   * 标记信任级别：reviewed = 用户确认内容属实（重写头部标记；无标记则插入）。
   * 只动头部标记行，不碰正文 — 用户编辑过的内容保持原样。
   */
  setTrust(name: string, trust: MemoryTrust): boolean {
    const safe = this.sanitizeName(name);
    if (!safe) return false;
    const abs = join(this.dir, safe);
    if (!existsSync(abs)) return false;
    let text = readFileSync(abs, 'utf-8');
    const marker = `<!-- trust: ${trust} -->`;
    if (TRUST_MARKER.test(text.slice(0, 200))) {
      text = text.replace(TRUST_MARKER, marker);
    } else {
      text = `${marker}\n\n${text}`;
    }
    writeFileSync(abs, text, 'utf-8');
    return true;
  }

  write(name: string, content: string, opts: { markTruncated?: boolean; trust?: MemoryTrust } = {}): { name: string; bytes: number; truncated: boolean } {
    const safe = this.sanitizeName(name);
    if (!safe) throw new Error(`非法记忆文件名: ${name}`);
    let truncated = false;
    if (content.length > MAX_CONTENT_CHARS) {
      content = content.slice(0, MAX_CONTENT_CHARS);
      truncated = true;
      if (opts.markTruncated !== false) {
        content += '\n\n[...写入时超长，已截断]';
      }
    }
    if (opts.trust) {
      content = `<!-- trust: ${opts.trust} -->\n\n${content}`;
    }
    this.ensure();
    writeFileSync(join(this.dir, safe), content, 'utf-8');
    return { name: safe, bytes: Buffer.byteLength(content, 'utf-8'), truncated };
  }

  /** 关键词检索：空格分词，行内 AND 语义（全部命中才算匹配），大小写不敏感 */
  search(query: string, maxMatches = 50): { matches: MemorySearchMatch[]; scannedFiles: number; truncated: boolean } {
    const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return { matches: [], scannedFiles: 0, truncated: false };

    const matches: MemorySearchMatch[] = [];
    let scannedFiles = 0;
    let truncated = false;

    for (const meta of this.list()) {
      scannedFiles++;
      const text = this.read(meta.name)?.content;
      if (!text) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const lower = lines[i].toLowerCase();
        if (terms.every(t => lower.includes(t))) {
          matches.push({ file: meta.name, line: i + 1, text: lines[i].slice(0, 300) });
          if (matches.length >= maxMatches) {
            truncated = true;
            return { matches, scannedFiles, truncated };
          }
        }
      }
    }
    return { matches, scannedFiles, truncated };
  }
}

// ─── 会话结束记忆整理（可选，默认开启；demo 模式跳过）──────────────────────

export interface DistillItem {
  filename: string;
  content: string;
}

/**
 * LLM 提炼本次 run 值得长期保留的内容并写入 memory/。
 * 返回写入结果；LLM 输出非法/无值得保留 → 空数组（绝不因整理失败影响 run）。
 */
export interface DistillResult {
  longTermWritten: Array<{ name: string; bytes: number }>;
  sessionFiles: Array<{ filename: string; summary: string }>;
  sessionPoints: string[];
  /** 本次 run 中做出的决策（what + why — 决策带原因才能指导后续会话） */
  decisions: Array<{ what: string; why: string }>;
  /** 接力记录：中断处/下一步/阻塞（下次续接会话的开场简报） */
  handoff: { leftOff: string; nextSteps: string[]; blockers: string[] } | null;
}

export async function distillMemory(
  llm: { complete(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, options?: any): Promise<{ content: string }> },
  service: MemoryService,
  transcript: string,
  sessionContext?: {
    addFileSummary(sessionId: string, filename: string, summary: string): void;
    addKeyPoint(sessionId: string, point: string): void;
    addDecision?(sessionId: string, what: string, why: string): void;
    setHandoff?(sessionId: string, handoff: { leftOff: string; nextSteps: string[]; blockers: string[] }): void;
  },
  sessionId?: string
): Promise<DistillResult> {
  const system = `You maintain TWO memory tiers of a personal agent runtime.

TIER 1 — LONG-TERM MEMORY (data/memory/): ONLY universal facts that apply across ALL future sessions:
- User preferences (output format, language, tone, review style)
- Corrections the user made ("don't do X, do Y instead")
- Project conventions and facts (names, goals, tech stack of ongoing projects)
- Lessons learned (tool quirks, environment issues encountered repeatedly)
- STICTLY EXCLUDE: file contents, file summaries, document analysis results, task-specific data.
  These are SESSION-scoped and belong in Tier 2. If the transcript is mostly about analyzing
  a specific document, the only long-term memory should be things like "user prefers tables"
  — NOT what the document said.

TIER 2 — SESSION CONTEXT: File summaries and task-specific facts from THIS conversation.
- Summarize each analyzed file in 2-5 sentences (what it contains, key conclusions)
- Record task progress points ("completed X, pending Y")
- Record DECISIONS made in this run: each with what was decided AND why (the why is what
  makes a decision useful later — without it the next session cannot judge whether to keep it)
- Record a HANDOFF for the next session: where work left off (left_off, ≤20 words),
  concrete next steps (next_steps), and anything blocked (blockers). Empty if fully done.

Rules:
- Prefer updating an existing topic file over creating near-duplicates.
- Long-term filenames: short kebab-case, e.g. user-preferences.md, project-x.md.
- Each long-term file: concise markdown, at most ~40 lines.
Output STRICT JSON:
{"long_term": [{"filename": "...", "content": "..."}], "session_files": [{"filename": "...", "summary": "..."}], "session_points": ["..."], "decisions": [{"what": "...", "why": "..."}], "handoff": {"left_off": "...", "next_steps": ["..."], "blockers": ["..."]}}
Output empty arrays / null handoff if nothing is worth remembering. No prose, no code fences.`;

  const existing = service.list().map(m => m.name).join(', ') || '(empty)';
  const clipped = transcript.slice(0, 60_000);

  let raw: string;
  try {
    const r = await llm.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: `Existing memory files: ${existing}\n\n--- TRANSCRIPT ---\n${clipped}` },
      ],
      { temperature: 0.2, maxTokens: 3500 }
    );
    raw = r.content;
  } catch {
    return { longTermWritten: [], sessionFiles: [], sessionPoints: [], decisions: [], handoff: null }; // 整理失败不影响 run
  }

  const parsed = parseTwoTierDistill(raw);
  const written: Array<{ name: string; bytes: number }> = [];
  // Tier 1: 写入长期记忆（agent 写入默认 unreviewed — 用户确认属实后可标记 reviewed）
  for (const item of parsed.long_term.slice(0, 8)) {
    const safe = service.sanitizeName(item.filename);
    if (!safe) continue;
    try {
      const existed = service.exists(safe);
      const w = service.write(safe, item.content, existed ? {} : { trust: 'unreviewed' });
      written.push(w);
    } catch { /* 跳过单文件失败 */ }
  }
  // Tier 2: 写入会话上下文
  if (sessionContext && sessionId) {
    for (const f of parsed.session_files.slice(0, 10)) {
      try { sessionContext.addFileSummary(sessionId, f.filename, f.summary); } catch { /* ignore */ }
    }
    for (const p of parsed.session_points.slice(0, 10)) {
      try { sessionContext.addKeyPoint(sessionId, p); } catch { /* ignore */ }
    }
    for (const d of parsed.decisions.slice(0, 10)) {
      try { sessionContext.addDecision?.(sessionId, d.what, d.why); } catch { /* ignore */ }
    }
    if (parsed.handoff) {
      try {
        sessionContext.setHandoff?.(sessionId, {
          leftOff: parsed.handoff.left_off,
          nextSteps: parsed.handoff.next_steps,
          blockers: parsed.handoff.blockers,
        });
      } catch { /* ignore */ }
    }
  }
  return {
    longTermWritten: written,
    sessionFiles: parsed.session_files,
    sessionPoints: parsed.session_points,
    decisions: parsed.decisions,
    handoff: parsed.handoff
      ? { leftOff: parsed.handoff.left_off, nextSteps: parsed.handoff.next_steps, blockers: parsed.handoff.blockers }
      : null,
  };
}

/** 解析两级输出 JSON */
function parseTwoTierDistill(raw: string): {
  long_term: DistillItem[];
  session_files: Array<{ filename: string; summary: string }>;
  session_points: string[];
  decisions: Array<{ what: string; why: string }>;
  handoff: { left_off: string; next_steps: string[]; blockers: string[] } | null;
} {
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const tryParse = (text: string) => {
    try {
      const obj = JSON.parse(text);
      const handoffRaw = obj.handoff;
      const handoff =
        handoffRaw && typeof handoffRaw === 'object' && typeof handoffRaw.left_off === 'string'
          ? {
              left_off: String(handoffRaw.left_off).slice(0, 200),
              next_steps: Array.isArray(handoffRaw.next_steps) ? handoffRaw.next_steps.filter((x: any) => typeof x === 'string').slice(0, 6) : [],
              blockers: Array.isArray(handoffRaw.blockers) ? handoffRaw.blockers.filter((x: any) => typeof x === 'string').slice(0, 6) : [],
            }
          : null;
      return {
        long_term: Array.isArray(obj.long_term) ? obj.long_term.filter((x: any) => x?.filename && x?.content) : [],
        session_files: Array.isArray(obj.session_files) ? obj.session_files.filter((x: any) => x?.filename && x?.summary) : [],
        session_points: Array.isArray(obj.session_points) ? obj.session_points.filter((x: any) => typeof x === 'string') : [],
        decisions: Array.isArray(obj.decisions)
          ? obj.decisions.filter((x: any) => x && typeof x.what === 'string' && typeof x.why === 'string')
          : [],
        handoff,
      };
    } catch { return null; }
  };
  const direct = tryParse(cleaned);
  if (direct) return direct;
  // 括号兜底
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const bracket = tryParse(cleaned.slice(start, end + 1));
    if (bracket) return bracket;
  }
  return { long_term: [], session_files: [], session_points: [], decisions: [], handoff: null };
}


