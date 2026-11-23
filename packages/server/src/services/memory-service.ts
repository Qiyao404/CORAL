import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
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
    this.ensure();
    const abs = join(this.dir, safe);
    // REG-19：更新既有文件且调用方未显式指定信任级别 → 沿用原文件头部标记。
    // 此前只有显式传 trust 才写标记，于是并入/合并/蒸馏写回后，agent 写的
    // unreviewed 文件一律被洗成 reviewed（"无标记 = 用户手编"的语义被误用）。
    let trust = opts.trust;
    if (!trust && existsSync(abs)) {
      const prevMarker = TRUST_MARKER.exec(readFileSync(abs, 'utf-8').slice(0, 200));
      if (prevMarker && !TRUST_MARKER.test(content.slice(0, 200))) trust = prevMarker[1] as MemoryTrust;
    }
    if (trust) {
      content = `<!-- trust: ${trust} -->\n\n${content}`;
    }
    writeFileSync(abs, content, 'utf-8');
    return { name: safe, bytes: Buffer.byteLength(content, 'utf-8'), truncated };
  }

  /** 改写前备份：原文件整份拷进 .history/<时间戳>--<文件名>（失败返回 null，不阻塞写入） */
  backup(name: string): string | null {
    const safe = this.sanitizeName(name);
    if (!safe) return null;
    const abs = join(this.dir, safe);
    if (!existsSync(abs)) return null;
    try {
      const histDir = join(this.dir, '.history');
      mkdirSync(histDir, { recursive: true });
      const target = join(histDir, `${new Date().toISOString().replace(/[:.]/g, '-')}--${safe}`);
      copyFileSync(abs, target);
      return target;
    } catch {
      return null;
    }
  }

  /** 关键词检索：空格分词，行内 AND 语义（全部命中才算匹配），大小写不敏感。
   *  混合排序（A3）：新近度加权（文件按修改时间倒序扫描 + 文件尾部"近期小节"加成——
   *  问现状优先取最新条）+ 实体加成（查询词命中已知实体索引——同一实体的零散记录被串起来） */
  search(query: string, maxMatches = 50, opts: { entityIndex?: Record<string, string[]> } = {}): { matches: (MemorySearchMatch & { score?: number })[]; scannedFiles: number; truncated: boolean } {
    const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return { matches: [], scannedFiles: 0, truncated: false };

    const matches: Array<MemorySearchMatch & { score: number }> = [];
    let scannedFiles = 0;
    let truncated = false;

    for (const meta of this.list()) { // list 已按修改时间倒序 — 文件级新近度天然有序
      scannedFiles++;
      const text = this.read(meta.name)?.content;
      if (!text) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const lower = lines[i].toLowerCase();
        if (terms.every(t => lower.includes(t))) {
          // ── 排序分 ──
          let score = 1;
          // 行级新近度：文件尾部的"近期小节"（追加式归档 — 越靠后越新）
          if (lines.length - i <= 40) score += 0.4;
          // 实体加成：查询词命中已知实体（B5 索引 — 同一实体的零散记录被串起来）
          for (const t of terms) {
            const known = opts.entityIndex?.[t];
            if (known?.includes(meta.name)) score += 0.5;
            else if (known) score += 0.2; // 实体存在但本文件未提 — 轻加成（同实体互串）
          }
          // 注：AND 行内匹配下"统计特异性"无法改变排序（匹配行必含全部查询词 →
          // 词在匹配文件中的分布恒同）— 不设该信号；语义级 OR 召回+排序留作后续
          matches.push({ file: meta.name, line: i + 1, text: lines[i].slice(0, 300), score });
          if (matches.length >= maxMatches * 2) break; // 收集超采样，排序后截断
        }
      }
      if (matches.length >= maxMatches * 2) { truncated = true; break; }
    }
    matches.sort((a, b) => b.score - a.score);
    const capped = matches.slice(0, maxMatches);
    if (matches.length > maxMatches) truncated = true;
    return { matches: capped, scannedFiles, truncated };
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
/** 长期记忆一次写入的落地方式：created 新建 / merged 全保留合并 / appended 原文不动只追加新增行 */
export type DistillWriteMode = 'created' | 'merged' | 'appended';

export interface DistillResult {
  longTermWritten: Array<{ name: string; bytes: number; mode?: DistillWriteMode }>;
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
- Existing memory files are listed below WITH their current content. If (and only if) the transcript adds a
  genuinely new long-term fact to one of them, output that file again as the COMPLETE merged file: keep every
  existing line that is still true VERBATIM, then add the new lines. Never drop, rephrase or shorten existing
  lines — a file that comes back shorter is treated as a lossy rewrite and only its new lines are kept.
  If the transcript adds nothing new to a file, omit that file from your output.
Output STRICT JSON:
{"long_term": [{"filename": "...", "content": "..."}], "session_files": [{"filename": "...", "summary": "..."}], "session_points": ["..."], "decisions": [{"what": "...", "why": "..."}], "handoff": {"left_off": "...", "next_steps": ["..."], "blockers": ["..."]}}
Output empty arrays / null handoff if nothing is worth remembering. No prose, no code fences.`;

  const existing = existingLibraryContext(service);
  const clipped = transcript.slice(0, 60_000);

  let raw: string;
  try {
    const r = await llm.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: `Existing memory files:\n${existing}\n\n--- TRANSCRIPT ---\n${clipped}` },
      ],
      { temperature: 0.2, maxTokens: 3500 }
    );
    raw = r.content;
  } catch {
    return { longTermWritten: [], sessionFiles: [], sessionPoints: [], decisions: [], handoff: null }; // 整理失败不影响 run
  }

  const parsed = parseTwoTierDistill(raw);
  const written: DistillResult['longTermWritten'] = [];
  // Tier 1: 写入长期记忆（agent 写入默认 unreviewed — 用户确认属实后可标记 reviewed）。
  // REG-19：既有文件走行级全保留合并 — 模型看不到原文时回一份"全新的短文件"，
  // 整篇覆盖会让老事实静默蒸发；现在原文一条不丢，只有新增行进得来。
  const seen = new Set<string>();
  for (const item of parsed.long_term.slice(0, 8)) {
    const safe = service.sanitizeName(item.filename);
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    try {
      if (service.exists(safe)) {
        const prev = service.read(safe);
        const merge = prev ? preserveMerge(prev.content, item.content) : null;
        if (!merge || merge.mode === 'unchanged') continue;
        service.backup(safe);
        const w = service.write(safe, merge.content);
        written.push({ ...w, mode: merge.mode });
      } else {
        const w = service.write(safe, item.content, { trust: 'unreviewed' });
        written.push({ ...w, mode: 'created' });
      }
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

// ─── REG-19：既有文件的全保留合并 ──────────────────────────────────────────

/** 蒸馏上下文里带正文展示的既有文件数（按最近修改优先）与单文件字符上限 */
const DISTILL_SHOW_FILES = 12;
const DISTILL_FILE_CHARS = 2_500;

const TRUST_MARKER_AT_TOP = /^<!--\s*trust:\s*(unreviewed|reviewed)\s*-->\s*/;
function stripTrustMarker(text: string): string {
  return text.replace(TRUST_MARKER_AT_TOP, '');
}

/** 既有记忆库快照：最近修改的若干个带正文，其余只列文件名（模型要合并就必须先看到原文） */
function existingLibraryContext(service: MemoryService): string {
  const files = service.list();
  if (files.length === 0) return '(empty)';
  const blocks = files.slice(0, DISTILL_SHOW_FILES).map(f => {
    const body = stripTrustMarker(service.read(f.name)?.content ?? '').trim();
    return `### ${f.name}\n${body.length > DISTILL_FILE_CHARS ? `${body.slice(0, DISTILL_FILE_CHARS)}\n…[truncated]` : body}`;
  });
  const rest = files.slice(DISTILL_SHOW_FILES).map(f => f.name);
  return blocks.join('\n\n') + (rest.length ? `\n\n### other files (content omitted)\n${rest.join(', ')}` : '');
}

const normLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const isHeading = (t: string) => /^#{1,6}\s/.test(t);
const isMarkerLine = (t: string) => /^<!--.*-->$/.test(t);

/** 事实行：非空、非标题、非信任标记的行（空白归一化后返回 — 逐行比较用） */
export function factLines(text: string): string[] {
  return String(text ?? '').split(/\r?\n/).map(normLine).filter(t => t && !isHeading(t) && !isMarkerLine(t));
}

/** 一条原文内容在改写稿里的"片段召回率"低于它 = 这条内容整个消失了 */
const ITEM_VANISHED_BELOW = 0.25;
/** 消失的条目超过这个比例 = 疑似丢内容（改写只应修正矛盾的那一两处） */
const MAX_VANISHED_RATIO = 1 / 3;
/** 整体召回率的兜底：防"每条都被砍掉一大半、却没有一条完全消失"绕过条目计数。
 *  取值在两组实测数据中间：正常改写 0.58～0.62，丢内容 0.17～0.36 */
const MIN_OVERALL_RECALL = 0.45;

export interface RewriteCoverage {
  /** 原文的事实行数 */
  total: number;
  /** 在改写稿里原样保留的事实行数（空白差异忽略）— 仅供参考，真实改写常整体换说法 */
  kept: number;
  /** 在改写稿里"整个消失"的条目数 */
  vanished: number;
  /** 整体片段召回率（0–1）：原文的字符片段有多少出现在改写稿里 */
  recall: number;
}

const normForRecall = (s: string) => String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

function charBigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** 片段召回率：original 的字符二元组有多少出现在 proposed 里（对换说法、重排不敏感；内容整块消失才会掉） */
function fragmentRecall(original: string, proposed: string): number {
  const a = charBigrams(normForRecall(original));
  if (a.size === 0) return 1;
  const b = charBigrams(normForRecall(proposed));
  let common = 0;
  let total = 0;
  for (const [g, n] of a) {
    total += n;
    common += Math.min(n, b.get(g) ?? 0);
  }
  return total > 0 ? common / total : 1;
}

/**
 * 改写稿对原文的覆盖情况（REG-38）。为什么不用"逐行原样保留率"：真实数据校准发现，
 * 模型对记忆文件的正常改写会把每一条都换个说法（逐行保留率 0%），但没有任何一条内容消失；
 * 而丢内容的改写，特征是整条整条地不见。所以判定看"消失的条目"与"整体召回"。
 */
export function rewriteCoverage(existing: string, proposed: string): RewriteCoverage {
  const items = factLines(existing);
  const proposedText = String(proposed ?? '');
  const incoming = new Set(factLines(proposedText));
  return {
    total: items.length,
    kept: items.filter(line => incoming.has(line)).length,
    vanished: items.filter(line => fragmentRecall(line, proposedText) < ITEM_VANISHED_BELOW).length,
    recall: items.length > 0 ? fragmentRecall(items.join('\n'), proposedText) : 1,
  };
}

/**
 * 改写稿是否"疑似丢内容"。原文不足 3 条时不构成判断依据（改掉唯一那条正是改写的用途）。
 * 校准（阈值取自实测）：真实接受的一次正常改写 — 逐行原样保留 0/4，但消失 0/4 条、整体召回 0.62；
 * 内容等价的换说法 0 条消失、0.58；丢一半 3/5 条消失、0.36；丢大半 4/5、0.17。
 */
export function isLossyRewrite(c: RewriteCoverage): boolean {
  if (c.total < 3) return false;
  return c.vanished / c.total > MAX_VANISHED_RATIO || c.recall < MIN_OVERALL_RECALL;
}

/**
 * 行级全保留合并。判定只看"事实行"（非空、非标题、非信任标记），空白差异忽略：
 *  · incoming 覆盖了原文全部事实行且有新增 → merged：采用 incoming（标题可重组，事实可增补）
 *  · incoming 丢了事实行 → appended：原文一字不动，只把 incoming 里原文没有的行追加到尾部带日期的小节
 *  · 没有任何新增行 → unchanged（调用方跳过写入）
 * incoming 为空 → null（非法输出，跳过）。
 */
export function preserveMerge(
  existing: string,
  incoming: string,
  now = new Date(),
): { content: string; mode: 'merged' | 'appended' | 'unchanged' } | null {
  const inc = stripTrustMarker(String(incoming ?? '')).trim();
  if (!inc) return null;
  const existingLines = existing.split(/\r?\n/);
  const incomingLines = inc.split(/\r?\n/);
  // 与 factLines 同一套判定，只是这里手里已经是行数组
  const factsOf = (lines: string[]) => lines.map(normLine).filter(t => t && !isHeading(t) && !isMarkerLine(t));
  const incomingFacts = new Set(factsOf(incomingLines));
  const lost = factsOf(existingLines).filter(t => !incomingFacts.has(t));

  // 新增行：incoming 里原文没有的行（去重；标题与事实行同等对待 — 新小节连同标题一起追加）
  const known = new Set(existingLines.map(normLine));
  const fresh: string[] = [];
  for (const raw of incomingLines) {
    const n = normLine(raw);
    if (!n || known.has(n) || fresh.includes(n) || isMarkerLine(n)) continue;
    fresh.push(n);
  }

  if (lost.length === 0 && fresh.length === 0) return { content: existing, mode: 'unchanged' };
  if (lost.length === 0) return { content: inc, mode: 'merged' };
  if (fresh.length === 0) return { content: existing, mode: 'unchanged' };
  return {
    content: `${existing.trimEnd()}\n\n## ${now.toISOString().slice(0, 10)} · 会话结束整理新增\n${fresh.join('\n')}\n`,
    mode: 'appended',
  };
}


