import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join, resolve } from 'path';

/**
 * 验证工程（A1/B4/A2）：把"完成"从一句主张变成带级别、带证明的可审计交付。
 *
 *  · 清单生成（B4 标准前置）：从任务目标 + 工作区累积 CHECKS.md 生成 pass/fail 验收行。
 *    信息论保证：生成输入只有 goal 与累积检查，**永不含工作产物与执行轨迹**——
 *    清单不可能被产物反向裁剪（这是"标准先于工作"的本质属性，与时序无关）
 *  · 判定（A1 默认否）：独立一次 LLM 调用逐行判 PASS/FAIL/UNVERIFIABLE，
 *    失败必须带证据引用；循环门（agent-loop）负责打回与 3 轮上限
 *  · 分级（A2 六级 done）：全过带证据=L4 / 全过部分不可验=L3 / 有失败=L2
 *  · 累积（一错一规）：人工采纳的行追加进工作区 CHECKS.md，同类任务永久生效
 *
 * 合格验收行的标准：让未参与制作、只看产物与来源的第三方 30 秒内打出勾或叉。
 */

export interface VerifyLine {
  line: string;
  /** 这条来自哪：generated（本次任务生成）/ accumulated（CHECKS.md 累积） */
  source: 'generated' | 'accumulated';
}

export interface CriteriaResult {
  lines: VerifyLine[];
  /** 生成时发现的任务歧义（提示模型用 ask_user 澄清，而不是猜） */
  ambiguities: string[];
}

export interface VerifyLineResult {
  line: string;
  pass: boolean;
  unverifiable?: boolean;
  evidence: string;
  /** 这条判定是怎么归位到清单行的（审计用）：行号 / 完全相等 / 去标点后相等 / 包含 / 相似度 */
  matchedBy?: 'exact' | 'index' | 'normalized' | 'containment' | 'fuzzy';
}

export interface VerifyVerdict {
  passed: boolean;
  results: VerifyLineResult[];
  /** 六级 done：4=全过带证据 3=全过部分不可验 2=有失败（打回中） */
  level: 2 | 3 | 4;
  passedCount: number;
  totalCount: number;
}

export interface LlmChat {
  chat(req: { messages: Array<{ role: 'user'; content: string }>; jsonMode?: boolean; maxTokens?: number }): Promise<{ content: string }>;
  isDemoMode?(): boolean;
}

const MAX_CHECKS_CHARS = 4000;
const MAX_GOAL_CHARS = 2000;
const MAX_FINAL_CHARS = 6000;

/** 工作区累积检查文件路径（用户可直接编辑；一错一规的沉淀处） */
export function checksFilePath(workspaceDir: string): string {
  return join(resolve(workspaceDir), 'CHECKS.md');
}

export function readAccumulatedChecks(workspaceDir: string): string {
  try {
    const p = checksFilePath(workspaceDir);
    if (!existsSync(p)) return '';
    return readFileSync(p, 'utf8').slice(0, MAX_CHECKS_CHARS);
  } catch { return ''; }
}

/** 一错一规：把一条行追加进 CHECKS.md（dated；文件不存在则带表头创建） */
export function appendCheck(workspaceDir: string, line: string): { ok: boolean; message: string } {
  const text = String(line ?? '').trim();
  if (!text) return { ok: false, message: '检查行为空' };
  if (text.length > 300) return { ok: false, message: '检查行过长（上限 300 字符）' };
  try {
    const p = checksFilePath(workspaceDir);
    mkdirSync(resolve(workspaceDir), { recursive: true });
    if (!existsSync(p)) {
      writeFileSync(p, '# CHECKS — 任务验收清单（累积）\n\n> 每行一条可判定检查（pass/fail）；由人工采纳沉淀，同类任务自动加载。\n\n', 'utf8');
    }
    appendFileSync(p, `- ${text}\n`, 'utf8');
    return { ok: true, message: '已追加进 CHECKS.md' };
  } catch (err: any) {
    return { ok: false, message: `写入失败: ${err?.message ?? err}` };
  }
}

/**
 * 生成验收清单（标准前置）。输入严格限定：goal + 累积 CHECKS.md —— 不含产物与轨迹。
 * 写不出可判定行的地方返回 ambiguities（应触发 ask_user，而不是猜）。
 */
export async function generateCriteria(deps: { llm: LlmChat; goal: string; workspaceDir: string }): Promise<CriteriaResult> {
  const { llm, goal, workspaceDir } = deps;
  const accumulated = readAccumulatedChecks(workspaceDir);
  const prompt =
    `Convert this task into an acceptance checklist for an autonomous agent's deliverable.\n\n` +
    `== Task ==\n${goal.slice(0, MAX_GOAL_CHARS)}\n\n` +
    (accumulated ? `== Accumulated workspace checks (must ALL be included verbatim) ==\n${accumulated}\n\n` : '') +
    `Rules for each line:\n` +
    `- Binary pass/fail against the ARTIFACT (files produced, numbers, links) — never taste words like "professional" or "high quality"\n` +
    `- A third party who never saw the work must be able to judge it in 30 seconds\n` +
    `- 3-7 lines total; only include what the task actually demands\n\n` +
    `Report an ambiguity ONLY when two reasonable readings would produce SUBSTANTIALLY different deliverables ` +
    `(different scope, audience or output format) and the checklist depends on which one is meant — then put it in ` +
    `"ambiguities" instead of guessing. Do NOT report details that have an obvious conventional default (file names, ` +
    `units, decimal places, column order, wording): the agent decides those itself. Usually there are none; at most 2.\n` +
    `Reply JSON only: {"lines":["..."],"ambiguities":["..."]}`;
  const res = await llm.chat({ messages: [{ role: 'user', content: prompt }], jsonMode: true, maxTokens: 2000 });
  const parsed = safeJson(res.content);
  const lines: VerifyLine[] = [];
  if (Array.isArray(parsed?.lines)) {
    for (const l of parsed.lines.slice(0, 7)) {
      if (typeof l === 'string' && l.trim()) lines.push({ line: l.trim().slice(0, 300), source: 'generated' });
    }
  }
  if (accumulated) {
    // 累积检查必须原样并入（用户的历史标准优先于生成）
    for (const m of accumulated.matchAll(/^\s*-\s+(.+)$/gm)) {
      const t = m[1].trim();
      if (t && !lines.some(l => l.line === t)) lines.push({ line: t, source: 'accumulated' });
    }
  }
  const ambiguities = Array.isArray(parsed?.ambiguities)
    ? parsed.ambiguities.filter((a: unknown) => typeof a === 'string' && a.trim()).slice(0, 2).map((a: string) => a.slice(0, 200))
    : [];
  return { lines: lines.slice(0, 10), ambiguities };
}

/**
 * 逐行判定（默认否）：判定者只看 清单 + 最终回答 + 工作区文件清单 ——
 * 不看制作者的推理过程（制作者永不自评的反向实现：检查者永不知道"为什么这么做"）。
 */
export async function verifyDeliverable(deps: {
  llm: LlmChat;
  goal: string;
  criteria: VerifyLine[];
  finalContent: string;
  /** 工作区产物清单（名字+大小 — 检查者知道"有什么可查"，不知道内容细节） */
  artifacts: Array<{ rel: string; bytes: number; content?: string }>;
}): Promise<VerifyVerdict> {
  const { llm, goal, criteria, finalContent, artifacts } = deps;
  if (criteria.length === 0) {
    return { passed: true, results: [], level: 4, passedCount: 0, totalCount: 0 };
  }
  const prompt =
    `You are a skeptical acceptance checker. The maker claims the task is done; judge EACH checklist line strictly against the evidence below.\n\n` +
    `== Task ==\n${goal.slice(0, MAX_GOAL_CHARS)}\n\n` +
    `== Checklist ==\n${criteria.map((c, i) => `${i + 1}. ${c.line}`).join('\n')}\n\n` +
    `== Maker's final answer ==\n${finalContent.slice(0, MAX_FINAL_CHARS) || '(empty)'}\n\n` +
    `== Workspace artifacts (name, bytes; small text files include content) ==\n${artifacts.length > 0 ? artifacts.map(a => `- ${a.rel} (${a.bytes}B)${a.content ? `:\n${a.content}` : ''}`).join('\n') : '(none)'}\n\n` +
    `Rules: default answer is FAIL. A line passes ONLY if the final answer or artifacts directly show it. ` +
    `Judge against the artifact CONTENT where provided (it is the ground truth, overriding the maker's claims). ` +
    `If judging a line requires evidence you cannot see (e.g. opening an external link), mark it "unverifiable": true rather than guessing PASS. ` +
    `Every FAIL or unverifiable line MUST cite what you saw ("final answer says X but checklist requires Y" / "no artifact matching Z").\n` +
    `Reply JSON only: {"results":[{"index":<the checklist line number>,"line":"<verbatim>","pass":true|false,"unverifiable":true|false,"evidence":"<what you saw>"}]}`;
  const res = await llm.chat({ messages: [{ role: 'user', content: prompt }], jsonMode: true, maxTokens: 3000 });
  const parsed = safeJson(res.content);
  // 判定归位（REG-36）：检查者常把检查行"改写"一下再回传——只认完全相等的行文字，会把判过的行
  // 当成"判定缺失"按未通过处理（真实复现：2 行全过却被判 2/4 并打回）。按行号 → 文字匹配归位；
  // 归不了位的判定丢弃（不能凭空多出一条"通过"），漏判的行仍按默认否补齐
  const used = new Set<number>();
  const byIndex = new Map<number, { r: any; by: VerifyLineResult['matchedBy'] }>();
  if (Array.isArray(parsed?.results)) {
    for (const r of parsed.results) {
      if (!r || typeof r !== 'object') continue;
      const hasLine = typeof r.line === 'string' && r.line.trim().length > 0;
      const hasIndex = typeof r.index === 'number' && Number.isInteger(r.index);
      if (!hasLine && !hasIndex) continue;
      const m = matchCheckResult(hasLine ? r.line : '', hasIndex ? r.index : undefined, criteria, used);
      if (!m) continue;
      used.add(m.index); // 同一行重复判定：只认第一条
      byIndex.set(m.index, { r, by: m.matchedBy });
    }
  }
  const results: VerifyLineResult[] = criteria.map((c, i) => {
    const hit = byIndex.get(i);
    if (!hit) {
      // 清单行缺失判定结果的按 FAIL 补齐（默认否 — 宁可误退不可漏放）
      return { line: c.line, pass: false, unverifiable: false, evidence: '(判定缺失 — 按未通过处理)' };
    }
    return {
      line: c.line,
      pass: hit.r.pass === true && hit.r.unverifiable !== true,
      unverifiable: hit.r.unverifiable === true,
      evidence: typeof hit.r.evidence === 'string' ? hit.r.evidence.slice(0, 300) : '',
      matchedBy: hit.by,
    };
  });
  const passedCount = results.filter(r => r.pass).length;
  // 不可验 ≠ 失败（诚实而非猜 PASS）；硬失败 = 既未通过也不可验
  const unverifiable = results.filter(r => r.unverifiable && !r.pass).length;
  const hardFailed = results.filter(r => !r.pass && !r.unverifiable).length;
  const level: VerifyVerdict['level'] = hardFailed > 0 ? 2 : (unverifiable > 0 ? 3 : 4);
  return { passed: hardFailed === 0, results, level, passedCount, totalCount: results.length };
}

/** 归一化：小写 + 去掉空白与标点符号（只比较"内容字符"） */
function normalizeLine(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 字符二元组 Dice 相似度（0–1）：对中英混合都适用，不依赖分词 */
function bigramDice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const count = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) count.set(a.slice(i, i + 2), (count.get(a.slice(i, i + 2)) ?? 0) + 1);
  let common = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = count.get(g) ?? 0;
    if (n > 0) { common++; count.set(g, n - 1); }
  }
  return (2 * common) / (a.length - 1 + (b.length - 1));
}

/** 相似度门槛：低于它不算同一行；且必须"明显只有一个候选"（与第二名拉开差距），否则宁可不认 */
const FUZZY_MIN = 0.45;
const FUZZY_MARGIN = 0.15;

/**
 * 把检查者回传的一条判定归位到清单行；返回清单下标，归不了位返回 null。
 * 顺序：完全相等 → 行号 → 去标点后相等 → 包含（短的一方至少 6 个字符）→ 相似度（唯一明显的候选）。
 */
export function matchCheckResult(
  returnedLine: string,
  returnedIndex: number | undefined,
  criteria: VerifyLine[],
  used: Set<number>,
): { index: number; matchedBy: VerifyLineResult['matchedBy'] } | null {
  const raw = String(returnedLine ?? '').trim();
  const exact = criteria.findIndex((c, i) => !used.has(i) && c.line.trim() === raw);
  if (exact >= 0) return { index: exact, matchedBy: 'exact' };
  if (typeof returnedIndex === 'number' && Number.isInteger(returnedIndex)) {
    const i = returnedIndex - 1; // 清单在提示里是 1 起始编号
    if (i >= 0 && i < criteria.length && !used.has(i)) return { index: i, matchedBy: 'index' };
  }
  const norm = normalizeLine(raw);
  if (!norm) return null;
  const normIdx = criteria.findIndex((c, i) => !used.has(i) && normalizeLine(c.line) === norm);
  if (normIdx >= 0) return { index: normIdx, matchedBy: 'normalized' };
  const containIdx = criteria.findIndex((c, i) => {
    if (used.has(i)) return false;
    const n = normalizeLine(c.line);
    return n.length >= 6 && norm.length >= 6 && (n.includes(norm) || norm.includes(n));
  });
  if (containIdx >= 0) return { index: containIdx, matchedBy: 'containment' };
  let best = -1;
  let bestScore = 0;
  let runnerUp = 0;
  criteria.forEach((c, i) => {
    if (used.has(i)) return;
    const score = bigramDice(norm, normalizeLine(c.line));
    if (score > bestScore) { runnerUp = bestScore; bestScore = score; best = i; } else if (score > runnerUp) { runnerUp = score; }
  });
  if (best >= 0 && bestScore >= FUZZY_MIN && bestScore - runnerUp >= FUZZY_MARGIN) return { index: best, matchedBy: 'fuzzy' };
  return null;
}

function safeJson(text: string): any | null {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* */ }
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; } }
  return null;
}
