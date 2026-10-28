import { detectRationalization } from './quality-gate.js';

/**
 * 五轴自评验证器 — 对 run 的最终回答做质量评分。
 *
 * 双层结构（确定性启发式打底 + 可选 LLM 语义裁决）：
 *  · 层 1（确定性，永远跑）：话术审计/墙式文本/对冲密度/长度异常 — 分数可复现
 *  · 层 2（LLM，可选）：按同一评分标准语义裁决
 *
 * 铁律：任何 <5 的分数必须附证据（引用原文缺口）；逐轴独立评分，
 * 禁止先算平均再反推。低分无证据 → 标记 noEvidence（评审无效化该轴）。
 */

export type EvalAxis = 'accuracy' | 'completeness' | 'clarity' | 'actionability' | 'conciseness';

export interface AxisScore {
  axis: EvalAxis;
  score: number; // 1-5
  /** 扣分理由 — score<5 时必须给（引用原文） */
  evidence?: string;
  /** LLM 给了低分但没给证据 → 该轴评审无效化（回退启发式分） */
  noEvidence?: boolean;
  source: 'heuristic' | 'llm';
}

export interface SelfEvalResult {
  axes: AxisScore[];
  overall: number; // 五轴均分
  heuristicNotes: string[];
  judgedByLlm: boolean;
}

const HEDGES = /(可能|也许|大概|或许|应该是|maybe|probably|possibly|i think|i believe|it seems)/gi;

/** 层 1：确定性启发式评分 */
export function evaluateDeterministic(goal: string, answer: string): SelfEvalResult {
  const text = String(answer ?? '');
  const goalChars = String(goal ?? '').length;
  const notes: string[] = [];
  const axes: AxisScore[] = [];

  // accuracy：合理化话术直接扣
  const hits = detectRationalization(text);
  if (hits.length > 0) {
    notes.push(`合理化话术 ${hits.length} 处（${hits.map(h => h.id).join(', ')}）`);
  }
  axes.push({
    axis: 'accuracy',
    score: clampScore(5 - hits.length * 2),
    evidence: hits.length > 0 ? `话术命中: ${hits.map(h => `"${h.quote}"`).join('；').slice(0, 300)}` : undefined,
    source: 'heuristic',
  });

  // completeness：空/极短回答 vs 任务规模
  const isShort = text.trim().length < 50;
  const taskLooksBig = goalChars > 120 || /[并且|以及|然后|同时|;|；|1\.|2\.]/.test(goal ?? '');
  if (isShort) notes.push('回答过短（<50 字符）');
  if (!isShort && taskLooksBig && text.length < goalChars / 2) notes.push('回答长度与任务规模明显不成比例');
  axes.push({
    axis: 'completeness',
    score: isShort ? 2 : taskLooksBig && text.length < goalChars / 2 ? 3 : 5,
    evidence: isShort ? `回答仅 ${text.trim().length} 字符` : taskLooksBig && text.length < goalChars / 2 ? `任务 ${goalChars} 字符 vs 回答 ${text.length} 字符` : undefined,
    source: 'heuristic',
  });

  // clarity：墙式文本（超长无结构）
  const words = text.split(/\s+/).length + (text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0);
  const hasStructure = /^#{1,3} |\n[-*] |\n\d+\. |\|---|\n\n/m.test(text);
  const wallOfText = words > 600 && !hasStructure;
  if (wallOfText) notes.push(`墙式文本（约 ${words} 字/词，无任何结构标记）`);
  axes.push({
    axis: 'clarity',
    score: wallOfText ? 3 : 5,
    evidence: wallOfText ? `约 ${words} 字/词连续输出，无标题/列表/分段` : undefined,
    source: 'heuristic',
  });

  // actionability：对冲密度（回避明确结论）
  const hedgeCount = (text.match(HEDGES) ?? []).length;
  const hedgeRatio = words > 0 ? hedgeCount / words : 0;
  if (hedgeRatio > 0.02) notes.push(`对冲词密度 ${(hedgeRatio * 100).toFixed(1)}%（${hedgeCount} 处）`);
  axes.push({
    axis: 'actionability',
    score: hedgeRatio > 0.04 ? 3 : hedgeRatio > 0.02 ? 4 : 5,
    evidence: hedgeRatio > 0.02 ? `对冲词 ${hedgeCount} 处（${(hedgeRatio * 100).toFixed(1)}%）` : undefined,
    source: 'heuristic',
  });

  // conciseness：纯长度检查（启发式只标记极端值）
  const tooLong = words > 3000;
  if (tooLong) notes.push(`回答超长（约 ${words} 字/词）`);
  axes.push({
    axis: 'conciseness',
    score: tooLong ? 3 : 5,
    evidence: tooLong ? `约 ${words} 字/词` : undefined,
    source: 'heuristic',
  });

  return {
    axes,
    overall: axes.reduce((n, a) => n + a.score, 0) / axes.length,
    heuristicNotes: notes,
    judgedByLlm: false,
  };
}

/** 层 2：LLM 语义裁决（逐轴独立、低分必须给证据；无证据的低分无效化） */
export async function evaluateWithLlm(
  llm: { complete(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, options?: any): Promise<{ content: string }> },
  goal: string,
  answer: string,
  fallback: SelfEvalResult
): Promise<SelfEvalResult> {
  let raw: string;
  try {
    const r = await llm.complete(
      [
        {
          role: 'system',
          content:
            'You are a strict quality judge for an agent runtime. Score the ANSWER against the TASK on 5 axes, each independently 1-5:\n' +
            'accuracy (facts only from tool results, no rationalization), completeness (all parts of the task addressed), ' +
            'clarity (structure/readability), actionability (concrete next steps, low hedging), conciseness (no padding).\n' +
            'HARD RULE: any score < 5 MUST include evidence quoting the specific gap from the answer. A low score without quoted evidence is invalid.\n' +
            'Output STRICT JSON: {"axes": [{"axis": "accuracy|completeness|clarity|actionability|conciseness", "score": 1-5, "evidence": "..."}]}\n' +
            'Score each axis independently — never compute an average first. No prose, no code fences.',
        },
        { role: 'user', content: `TASK:\n${String(goal).slice(0, 4000)}\n\n--- ANSWER ---\n${String(answer).slice(0, 20_000)}` },
      ],
      { temperature: 0.1, maxTokens: 800 }
    );
    raw = r.content;
  } catch {
    return fallback; // 裁决失败回退启发式
  }

  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  let parsed: any;
  try {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    parsed = JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned);
  } catch {
    return fallback;
  }
  if (!Array.isArray(parsed?.axes)) return fallback;

  const llmByAxis = new Map<string, AxisScore>();
  for (const a of parsed.axes) {
    if (typeof a?.axis !== 'string' || typeof a?.score !== 'number') continue;
    const score = clampScore(a.score);
    const hasEvidence = typeof a.evidence === 'string' && a.evidence.trim().length > 0;
    // 低分无证据 → 无效化（回退该轴的启发式分）
    if (score < 5 && !hasEvidence) {
      llmByAxis.set(a.axis, { axis: a.axis as EvalAxis, score, noEvidence: true, source: 'llm' });
    } else {
      llmByAxis.set(a.axis, {
        axis: a.axis as EvalAxis,
        score,
        evidence: score < 5 ? String(a.evidence).slice(0, 400) : undefined,
        source: 'llm',
      });
    }
  }

  // 合成：LLM 有效轴优先；无效化轴与缺席轴用启发式兜底
  const axes = fallback.axes.map(h => {
    const l = llmByAxis.get(h.axis);
    if (!l) return h;
    if (l.noEvidence) return { ...h, source: 'heuristic' as const };
    return l;
  });
  return {
    axes,
    overall: axes.reduce((n, a) => n + a.score, 0) / axes.length,
    heuristicNotes: fallback.heuristicNotes,
    judgedByLlm: true,
  };
}

function clampScore(n: number): number {
  return Math.max(1, Math.min(5, Math.round(n)));
}
