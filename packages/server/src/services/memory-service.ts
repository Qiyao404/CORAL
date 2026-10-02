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

  read(name: string): { content: string; truncated: boolean; size: number } | null {
    const safe = this.sanitizeName(name);
    if (!safe) return null;
    const abs = join(this.dir, safe);
    if (!existsSync(abs)) return null;
    const text = readFileSync(abs, 'utf-8');
    // 读取上限比写入上限宽 1KB — 写入截断时追加的标记行（约 30 字符）不会被二次切掉
    const READ_LIMIT = MAX_CONTENT_CHARS + 1024;
    const truncated = text.length > READ_LIMIT;
    return {
      content: truncated ? text.slice(0, READ_LIMIT) : text,
      truncated,
      size: text.length,
    };
  }

  write(name: string, content: string, opts: { markTruncated?: boolean } = {}): { name: string; bytes: number; truncated: boolean } {
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
export async function distillMemory(
  llm: { complete(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, options?: any): Promise<{ content: string }> },
  service: MemoryService,
  transcript: string
): Promise<Array<{ name: string; bytes: number }>> {
  const system = `You maintain the long-term memory of a personal agent runtime. Given a finished task transcript, extract ONLY durable facts worth remembering across future sessions: user preferences, corrections, conventions, project facts, lessons learned.
Rules:
- Ignore volatile task details, one-off data, and anything derivable from the transcript's goal itself.
- Prefer updating an existing topic file over creating near-duplicates (existing files are listed in the transcript header).
- Filenames: short kebab-case English or pinyin topic names, e.g. user-preferences.md, project-x.md.
- Each file content: concise markdown, at most ~40 lines.
Output STRICT JSON: an array of {"filename": "...", "content": "..."} objects. Output [] if nothing is worth remembering. No prose, no code fences.`;

  const existing = service.list().map(m => m.name).join(', ') || '(empty)';
  const clipped = transcript.slice(0, 60_000);

  let raw: string;
  try {
    const r = await llm.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: `Existing memory files: ${existing}\n\n--- TRANSCRIPT ---\n${clipped}` },
      ],
      { temperature: 0.2, maxTokens: 2000 }
    );
    raw = r.content;
  } catch {
    return []; // 整理失败不影响 run
  }

  const items = parseDistillItems(raw);
  const written: Array<{ name: string; bytes: number }> = [];
  for (const item of items.slice(0, 10)) {
    const safe = service.sanitizeName(item.filename);
    if (!safe) continue;
    try {
      const w = service.write(safe, item.content);
      written.push(w);
    } catch { /* 跳过单文件失败 */ }
  }
  return written;
}

function parseDistillItems(raw: string): DistillItem[] {
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x: any) => x && typeof x.filename === 'string' && typeof x.content === 'string' && x.content.trim()
    );
  } catch {
    // 括号配对兜底
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        return Array.isArray(parsed) ? parsed.filter((x: any) => x?.filename && x?.content) : [];
      } catch { return []; }
    }
    return [];
  }
}
