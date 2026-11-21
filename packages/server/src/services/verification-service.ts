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
    `If any requirement is too ambiguous to make checkable (e.g. "one page" — A4 or screen?), put it in "ambiguities" instead of guessing.\n` +
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
    ? parsed.ambiguities.filter((a: unknown) => typeof a === 'string' && a.trim()).slice(0, 3).map((a: string) => a.slice(0, 200))
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
    `Reply JSON only: {"results":[{"line":"<verbatim>","pass":true|false,"unverifiable":true|false,"evidence":"<what you saw>"}]}`;
  const res = await llm.chat({ messages: [{ role: 'user', content: prompt }], jsonMode: true, maxTokens: 3000 });
  const parsed = safeJson(res.content);
  const byLine = new Map(criteria.map(c => [c.line, c.line])); // 行文本 → 行文本（归位用）
  const results: VerifyLineResult[] = [];
  if (Array.isArray(parsed?.results)) {
    for (const r of parsed.results) {
      if (!r || typeof r.line !== 'string') continue;
      // 行文本对不上清单的（LLM 改写了）→ 按原清单行归位
      const orig = byLine.get(r.line.trim()) ?? criteria.find(c => c.line.includes(r.line.slice(0, 20)))?.line ?? r.line.trim();
      results.push({
        line: orig.slice(0, 300),
        pass: r.pass === true && r.unverifiable !== true,
        unverifiable: r.unverifiable === true,
        evidence: typeof r.evidence === 'string' ? r.evidence.slice(0, 300) : '',
      });
    }
  }
  // 清单行缺失判定结果的按 FAIL 补齐（默认否 — 宁可误退不可漏放）
  for (const c of criteria) {
    if (!results.some(r => r.line === c.line)) {
      results.push({ line: c.line, pass: false, unverifiable: false, evidence: '(判定缺失 — 按未通过处理)' });
    }
  }
  const passedCount = results.filter(r => r.pass).length;
  // 不可验 ≠ 失败（诚实而非猜 PASS）；硬失败 = 既未通过也不可验
  const unverifiable = results.filter(r => r.unverifiable && !r.pass).length;
  const hardFailed = results.filter(r => !r.pass && !r.unverifiable).length;
  const level: VerifyVerdict['level'] = hardFailed > 0 ? 2 : (unverifiable > 0 ? 3 : 4);
  return { passed: hardFailed === 0, results, level, passedCount, totalCount: results.length };
}

function safeJson(text: string): any | null {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* */ }
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; } }
  return null;
}
