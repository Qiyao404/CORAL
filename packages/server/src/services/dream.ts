import type { MemoryService } from './memory-service.js';
import type { SearchStore } from '../store/search-store.js';
import type { EvolutionService } from './evolution-service.js';

/**
 * 离线对账（Dreaming）：记忆库 ↔ 历史执行轨迹的夜间核对。
 *
 * 在线写入的记忆是"易腐烂的二次加工缓存"——当时任务压力大、归因仓促，
 * 错误一旦入库就会像病毒一样污染后续所有独立会话。对账在空闲时进行：
 * 穿透到原始轨迹（FTS5 检索库 = 事件流的检索投影），让模型拿着底账
 * 逐条核对上层记忆，发现矛盾 → 生成改写提议。
 *
 * 边界纪律（与自进化闭环一致）：
 *  · 对账**只提议不落盘** — 改写仍走演化队列的人审闸门
 *  · 判定者是 LLM（同源偏差仍在），所以证据必须原文引用、人可复核
 *  · 每文件每次审计最多 1 条提议；同文件已有未决提议不重复提
 */

export interface LlmChat {
  chat(req: { messages: Array<{ role: 'user'; content: string }>; jsonMode?: boolean; maxTokens?: number }): Promise<{ content: string }>;
  isDemoMode?(): boolean;
}

export interface DreamAuditResult {
  audited: number;
  consistent: number;
  contradictory: number;
  unverified: number;
  proposals: number; // 实际入队数（有未决提议时改写不会重复入队）
  skipped?: string;
}

const MAX_FILES_PER_AUDIT = 8;
const MAX_MEMORY_CHARS = 3000;

/** 从记忆内容提取检索词（标题行 + 出现频次最高的实词，取 3-6 个） */
export function searchTerms(content: string): string[] {
  const heading = (content.match(/^#{1,3}\s+(.+)$/m)?.[1] ?? '').trim();
  const freq = new Map<string, number>();
  for (const w of content.toLowerCase().match(/[\u4e00-\u9fa5]{2,}|[a-z][a-z0-9-]{2,}/g) ?? []) {
    if (w.length < 2 || ['the', 'and', 'for', 'with', 'that', 'this'].includes(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(e => e[0]);
  return [...new Set([heading.toLowerCase(), ...top].filter(Boolean))].slice(0, 5);
}

/**
 * 审计一轮：逐文件检索相关历史轨迹 → LLM 对照判定 → 矛盾入队改写提议。
 * 单文件失败不中断整轮（审计是可重入的批处理）。
 */
export async function auditMemory(deps: {
  svc: MemoryService;
  llm: LlmChat;
  search: SearchStore;
  evolution: EvolutionService;
  maxFiles?: number;
}): Promise<DreamAuditResult> {
  const { svc, llm, search, evolution } = deps;
  const result: DreamAuditResult = { audited: 0, consistent: 0, contradictory: 0, unverified: 0, proposals: 0 };
  if (!llm || llm.isDemoMode?.()) return { ...result, skipped: 'LLM 不可用（演示模式），跳过' };

  const files = svc.list().slice(0, deps.maxFiles ?? MAX_FILES_PER_AUDIT);
  for (const meta of files) {
    try {
      const mem = svc.read(meta.name);
      if (!mem) continue;
      result.audited++;

      // 证据面：从历史轨迹（FTS5）捞相关片段 — 底账是"当时真实发生了什么"
      const hits: string[] = [];
      for (const term of searchTerms(mem.content)) {
        for (const h of search.search(term, 4)) {
          hits.push(`[run ${h.runId.slice(0, 10)} / ${h.kind}] ${h.snippet}`);
        }
        if (hits.length >= 8) break;
      }
      const evidenceBlock = hits.length > 0 ? hits.join('\n') : '(无相关历史轨迹命中)';

      const prompt =
        `You are auditing a long-term memory entry of a personal agent runtime AGAINST the raw evidence of what actually happened in past runs.\n\n` +
        `== Memory entry (${meta.name}) ==\n${mem.content.slice(0, MAX_MEMORY_CHARS)}\n\n` +
        `== Evidence: full-text search hits from historical run transcripts ==\n${evidenceBlock}\n\n` +
        `Judge: does the evidence CONTRADICT any factual claim in the memory entry? A claim is contradicted only when ` +
        `the evidence directly shows the opposite of what the memory asserts. Missing evidence is NOT contradiction.\n` +
        `Reply JSON only: {"verdict":"consistent"|"contradictory"|"unverified",` +
        `"contradictedClaim":"<the exact claim, when contradictory>",` +
        `"evidenceQuote":"<the exact snippet(s) supporting the contradiction>",` +
        `"correctedMarkdown":"<when contradictory: the full corrected memory file, preserving all unaffected content exactly>"}\n` +
        `Use "unverified" when the evidence neither confirms nor contradicts (e.g. no hits). Never invent corrections without evidence.`;
      const res = await llm.chat({ messages: [{ role: 'user', content: prompt }], jsonMode: true, maxTokens: 16384 });
      const parsed = safeJson(res.content);
      const verdict = parsed?.verdict;
      if (verdict === 'contradictory' && typeof parsed.correctedMarkdown === 'string' && parsed.correctedMarkdown.length > 30) {
        result.contradictory++;
        const proposal = evolution.proposeMemoryRewrite({
          file: meta.name,
          current: mem.content,
          proposed: parsed.correctedMarkdown,
          evidence: String(parsed.evidenceQuote ?? '').slice(0, 300),
          rationale: `离线对账发现矛盾：${String(parsed.contradictedClaim ?? '').slice(0, 200)}`,
        });
        if (proposal) result.proposals++;
      } else if (verdict === 'consistent') {
        result.consistent++;
      } else {
        result.unverified++;
      }
    } catch { /* 单文件失败不中断整轮 */ }
  }
  return result;
}

function safeJson(text: string): any | null {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* */ }
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; } }
  return null;
}
