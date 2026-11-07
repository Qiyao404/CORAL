import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync } from 'fs';
import { join, resolve, basename } from 'path';
import type { MemoryService } from './memory-service.js';

/**
 * 记忆自动归档（平台自治，目标：记忆库长期保持少量主题文件而非碎片增殖）：
 *
 *  · routeNewMemory：memory_write 新建文件前，LLM 对照现有文件的名称+预览判断
 *    这条内容属于哪个既有主题（并入）还是真正的新主题（新建）——模型给的文件名
 *    只是"建议"，归档决定权在平台
 *  · appendToMemory：并入 = 原文一字不动 + 追加带日期与来源标记的小节
 *  · autoConsolidate：文件数超过上限（默认 10）时自动整理——LLM 只做分组决策，
 *    组内合并沿用全保留纪律（一条事实不丢，仅按主题重组），原文件备份 .history/
 *  · mergeInto：全保留合并核心（API 的手动合并与自动整理共用）
 *
 * 兜底：LLM 不可用（演示模式/调用失败/输出异常）一律回落"按原名新建"——自治永不阻塞写入。
 */

export interface LlmChat {
  chat(req: { messages: Array<{ role: 'user'; content: string }>; jsonMode?: boolean; maxTokens?: number }): Promise<{ content: string }>;
  isDemoMode?(): boolean;
}

export interface RouteDecision {
  action: 'create' | 'append' | 'reject';
  target: string;
  reason?: string;
}

const PREVIEW_CHARS = 110;

function filePreviews(svc: MemoryService): string {
  return svc.list()
    .map(f => {
      const c = (svc.read(f.name)?.content ?? '').replace(/\s+/g, ' ').trim();
      return `- ${f.name}: ${c.slice(0, PREVIEW_CHARS)}`;
    })
    .join('\n');
}

/** 新记忆归档决策：并入既有主题文件（优先）、新建，或按准入标准拒绝 */
export async function routeNewMemory(
  svc: MemoryService,
  llm: LlmChat | undefined,
  proposedName: string,
  content: string,
  opts: { userInstructed?: boolean } = {},
): Promise<RouteDecision> {
  const fallback: RouteDecision = { action: 'create', target: proposedName };
  // 指令性输入（用户明确说"记住"）跳过准入门槛——路由只管模型自发记忆
  if (opts.userInstructed) return fallback;
  try {
    if (!llm || llm.isDemoMode?.()) return fallback;
    const files = svc.list();
    if (files.length === 0) return fallback;
    const prompt =
      `A new long-term memory note needs filing into the memory library.\n\n` +
      `Existing memory files (name + content preview):\n${filePreviews(svc)}\n\n` +
      `New note (the agent proposed filename "${proposedName}"):\n${content.slice(0, 900)}\n\n` +
      `Decide: APPEND into the thematically matching existing file (strongly preferred when related at all — ` +
      `the library should stay small), or CREATE a new file (only for a genuinely new topic nothing covers). ` +
      `ADMISSION RULES — REJECT the note if it is: (a) reconstructable from the environment (workspace file ` +
      `listings, skill inventories, config snapshots — tools like fs_list can rebuild these anytime), (b) a recap ` +
      `of what a conversation discussed (past conversations are already full-text searchable), or (c) volatile state. ` +
      `ACCEPT: user preferences, corrections, conventions, problem→solution lessons. ` +
      `Reply JSON only: {"action":"append"|"create"|"reject","target":"<exact existing filename, or a new kebab-case .md name>","reason":"<one short sentence>"}`;
    const res = await llm.chat({ messages: [{ role: 'user', content: prompt }], jsonMode: true, maxTokens: 16384 });
    const parsed = safeJson(res.content);
    // reject 优先判定（在 target 校验之前——reject 的 target 可为空或占位符）
    if (parsed?.action === 'reject' && typeof parsed.reason === 'string') {
      return { action: 'reject', target: '', reason: parsed.reason.slice(0, 300) };
    }
    if (!parsed || typeof parsed.target !== 'string' || !parsed.target.trim()) return fallback;
    const target = svc.sanitizeName(parsed.target) ?? proposedName;
    if (parsed.action === 'append' && svc.exists(target)) {
      return { action: 'append', target, reason: parsed.reason };
    }
    return { action: 'create', target, reason: parsed.reason };
  } catch {
    return fallback;
  }
}

/** 并入：原文不动 + 追加带日期与来源的小节 */
export function appendToMemory(svc: MemoryService, target: string, content: string, sourceName: string): { bytes: number } {
  const existing = svc.read(target);
  const stamp = new Date().toISOString().slice(0, 10);
  const merged = (existing?.content ?? '').trimEnd()
    + `\n\n## ${stamp} · 归档自 ${sourceName}\n${content.trim()}`;
  const w = svc.write(target, merged);
  return { bytes: w.bytes };
}

/** 全保留合并核心（手动 API 与自动整理共用）：内容一条不丢，仅按主题重组 */
export async function mergeInto(
  svc: MemoryService,
  llm: LlmChat,
  names: string[],
  target: string,
): Promise<{ mergedChars: number }> {
  const contents = names.map(n => ({ name: n, content: svc.read(n)?.content ?? '' }));
  const totalChars = contents.reduce((n, c) => n + c.content.length, 0);
  const prompt =
    `Merge the following memory note files into ONE well-organized Markdown document.\n` +
    `STRICT RULES: preserve EVERY fact, preference, date, name, and lesson — nothing may be dropped or summarized away; ` +
    `merge exact duplicates only; organize with clear topic headings (## level); keep each item's original language ` +
    `(Chinese stays Chinese, English stays English); keep source annotations like dates if present. ` +
    `Output ONLY the merged Markdown, no commentary.\n\n` +
    contents.map(c => `===== FILE: ${c.name} =====\n${c.content}`).join('\n\n');
  const res = await llm.chat({ messages: [{ role: 'user', content: prompt }], maxTokens: 16384 });
  const merged = String(res.content ?? '').trim();
  if (!merged || merged.length < totalChars * 0.3) {
    throw new Error('合并结果疑似丢内容（长度异常），已放弃写盘');
  }
  svc.write(target, merged);
  // 其余原文件备份进 .history/ 后删除（basename 防穿越 — 只操作记忆目录内的文件）
  const { mkdirSync: mk, copyFileSync: cp, unlinkSync: ul, existsSync: ex } = { mkdirSync, copyFileSync, unlinkSync, existsSync };
  const root = resolve(svcDirPath(svc));
  const histDir = join(root, '.history');
  mk(histDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const n of names) {
    if (n === target) continue;
    const safe = basename(n); // 强制限制在记忆目录内
    const abs = join(root, safe);
    if (ex(abs) && safe !== '.consolidate-state.json') {
      cp(abs, join(histDir, `${stamp}--${safe}`));
      ul(abs);
    }
  }
  return { mergedChars: merged.length };
}

function svcDirPath(svc: MemoryService): string {
  return (svc as any).dirPath as string;
}

/**
 * 超量自动整理：文件数 > maxFiles 时，LLM 分组（名称+预览决策）→ 组内全保留合并。
 * 节流：整理状态文件记录上次运行时间，间隔 < 1 小时不重复跑。
 */
export async function autoConsolidate(
  svc: MemoryService,
  llm: LlmChat | undefined,
  maxFiles = 15,
): Promise<{ ran: boolean; groups?: number; note?: string }> {
  try {
    if (!llm || llm.isDemoMode?.()) return { ran: false, note: 'LLM 不可用，跳过' };
    const files = svc.list().map(f => f.name);
    if (files.length <= maxFiles) return { ran: false };

    // 节流（1 小时）
    const statePath = join(resolve(svcDirPath(svc)), '.consolidate-state.json');
    try {
      if (existsSync(statePath)) {
        const last = Number(JSON.parse(readFileSync(statePath, 'utf-8')).lastRun ?? 0);
        if (Date.now() - last < 60 * 60 * 1000) return { ran: false, note: '节流中（1 小时内已整理过）' };
      }
    } catch { /* 状态损坏按未整理处理 */ }
    mkdirSync(join(resolve(svcDirPath(svc))), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ lastRun: Date.now() }), 'utf-8');

    // 分组决策（只看名称+预览，不看全文 — 决策轻量）
    const prompt =
      `The memory library has grown to ${files.length} files and needs consolidation down to 5-12 topic files (aim for fewer, keep topics natural).\n` +
      `Existing files (name + content preview):\n${filePreviews(svc)}\n\n` +
      `Group related files so each group merges into ONE file. Rules: every file must appear in exactly one group; ` +
      `groups of size 1 stay unchanged; choose the most descriptive name in each group as target (keep exact filename). ` +
      `Aim for the fewest sensible groups. Reply JSON only: {"groups":[{"target":"<filename>","sources":["a.md","b.md"]}]}`;
    const res = await llm.chat({ messages: [{ role: 'user', content: prompt }], jsonMode: true, maxTokens: 16384 });
    const parsed = safeJson(res.content);
    const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];
    // 安全校验：sources 和 target 必须都是记忆库内的真实文件（防 LLM 输出路径穿越）
    const knownFiles = new Set(svc.list().map(f => f.name));
    const valid = groups.filter((g: any) =>
      Array.isArray(g.sources) && g.sources.length > 1 &&
      typeof g.target === 'string' &&
      knownFiles.has(g.target) &&
      (g.sources as string[]).every((s: string) => knownFiles.has(s)) &&
      (g.sources as string[]).includes(g.target)
    ) as Array<{ target: string; sources: string[] }>;
    if (valid.length === 0) return { ran: false, note: '无有效分组建议' };

    let done = 0;
    for (const g of valid) {
      try {
        await mergeInto(svc, llm, g.sources, g.target);
        done++;
      } catch { /* 单组失败不影响其余组 */ }
    }
    return { ran: done > 0, groups: done };
  } catch (err: any) {
    return { ran: false, note: `整理失败: ${err?.message ?? err}` };
  }
}

function safeJson(text: string): any | null {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* */ }
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; } }
  return null;
}
