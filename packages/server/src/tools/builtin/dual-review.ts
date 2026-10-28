import { nanoid } from 'nanoid';
import { AgentLoop, type LoopLLM } from '../../kernel/agent-loop.js';
import type { Tool, ToolResult } from '../types.js';
import { toolOk, toolError } from '../types.js';

/**
 * 双盲会审 — 两个互相独立的评审 + 分歧仲裁。
 *
 *  · 双独立：两个子代理背靠背评审同一目标（同一标准、不同措辞框架去相关），
 *    彼此看不到对方的结论 — 共识才算通过，防单评审的口径漂移
 *  · 双通过 → pass；分歧 → 第三个仲裁评审；仲裁无结论 → escalate（交人工）
 *  * 评审产物结构化（pass/issues），解析失败视为该评审 fail-closed（不通过）
 */

export interface DualReviewDeps {
  llm: LoopLLM;
}

const TARGET_LIMIT = 20_000;
const FOCUS_LIMIT = 2000;

const RUBRICS = [
  {
    id: 'A',
    system:
      'You are an independent REVIEWER. Judge the work strictly against the review focus. ' +
      'Check: does it actually fulfill the requirement, is every claim grounded, are there gaps or errors?\n' +
      'Finish with STRICT JSON on the last line: {"pass": true|false, "issues": ["...", "..."]}\nNo prose after the JSON.',
  },
  {
    id: 'B',
    system:
      'You are a skeptical auditor reviewing a deliverable you did not produce. Your job is to find what is wrong or missing before anyone ships it. ' +
      'Be specific: name the exact gap, quote the part that fails.\n' +
      'Finish with STRICT JSON on the last line: {"pass": true|false, "issues": ["...", "..."]}\nNo prose after the JSON.',
  },
];

interface Verdict {
  pass: boolean;
  issues: string[];
  parseFailed?: boolean;
  raw: string;
}

export function makeDualReviewTool(deps: DualReviewDeps): Tool {
  return {
    name: 'dual_review',
    description:
      'Send a deliverable (your draft answer, a document, a plan) through TWO independent blind reviewers plus a tie-breaker. ' +
      'Returns pass only when reviewers reach consensus; disagreements list concrete issues. ' +
      'Use before delivering high-stakes output (final report, generated document, important decision) when the user asks for review/verification.',
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: { type: 'string', description: 'The content to review (text; the deliverable itself)' },
        focus: { type: 'string', description: 'What to check for (requirement, rubric, or concern). Default: fulfills the original task' },
      },
    },
    source: 'builtin',
    permission: 'auto',
    effects: { idempotent: true },

    async invoke(input: any, ctx): Promise<ToolResult> {
      const target = String(input?.target ?? '').trim();
      if (!target) return toolError('BAD_INPUT', 'target 必填（要评审的内容文本）');
      if (target.length > TARGET_LIMIT) return toolError('BAD_INPUT', `target 过长（${target.length}，上限 ${TARGET_LIMIT}）— 请分段评审`);
      const focus = String(input?.focus ?? 'the original task requirement').slice(0, FOCUS_LIMIT);

      const verdicts: Verdict[] = [];
      for (const rubric of RUBRICS) {
        const v = await runReviewer(deps.llm, ctx, rubric.id, rubric.system, target, focus);
        verdicts.push(v);
      }

      const [a, b] = verdicts;
      let consensus: 'pass' | 'fail' | 'escalate';
      let tiebreak: Verdict | undefined;

      if (a.parseFailed && b.parseFailed) {
        consensus = 'escalate';
      } else if (a.pass === b.pass) {
        consensus = a.pass ? 'pass' : 'fail';
      } else {
        // 分歧 → 仲裁评审（第三视角，明确知道双方分歧点）
        tiebreak = await runReviewer(
          deps.llm, ctx, 'T',
          'You are the TIE-BREAKER judge. Two reviewers disagreed on this deliverable. Examine it yourself and give the final verdict. ' +
          'Finish with STRICT JSON on the last line: {"pass": true|false, "issues": ["...", "..."]}\nNo prose after the JSON.',
          target,
          `${focus}\n\n(Reviewer A said ${a.pass ? 'PASS' : 'FAIL'}: ${a.issues.join('; ') || 'no issues listed'}\nReviewer B said ${b.pass ? 'PASS' : 'FAIL'}: ${b.issues.join('; ') || 'no issues listed'} — judge independently, do not just average.)`
        );
        consensus = tiebreak.parseFailed ? 'escalate' : tiebreak.pass ? 'pass' : 'fail';
      }

      const issues = [...new Set([...a.issues, ...b.issues, ...(tiebreak?.issues ?? [])])].slice(0, 10);
      return toolOk({
        verdict: consensus,
        reviewers: verdicts.map(v => ({ pass: v.pass, issues: v.issues, parseFailed: v.parseFailed ?? false })),
        ...(tiebreak ? { tiebreak: { pass: tiebreak.pass, issues: tiebreak.issues } } : {}),
        issues,
        advice:
          consensus === 'pass'
            ? '双评审共识通过，可交付'
            : consensus === 'fail'
              ? '评审未通过 — 按 issues 修订后可再次送审'
              : '评审无法达成结论（输出格式异常）— 建议人工复核或调整后重试',
      });
    },
  };
}

async function runReviewer(
  llm: LoopLLM,
  ctx: { runId: string; signal: AbortSignal; emit(ev: { type: string; payload?: Record<string, any> }): void },
  id: string,
  system: string,
  target: string,
  focus: string
): Promise<Verdict> {
  const subId = `review-${id}-${nanoid(4)}`;
  ctx.emit({ type: 'subagent.started', payload: { agentId: subId, depth: 1, goalPreview: `双盲会审 ${id}: ${focus.slice(0, 80)}` } });
  const loop = new AgentLoop(llm, {
    runId: ctx.runId,
    agentId: subId,
    goal: `Review focus: ${focus}\n\n--- DELIVERABLE UNDER REVIEW ---\n${target}`,
    tools: [],
    budget: { maxSteps: 2, maxTokens: 8_000 },
    signal: ctx.signal,
    extraSystem: system,
    onEvent: ev => ctx.emit(ev),
    qualityGate: false, // 评审产出是结构化 JSON，不适用收工门
  });
  const result = await loop.run();
  ctx.emit({
    type: result.status === 'failed' ? 'subagent.failed' : 'subagent.completed',
    payload: { agentId: subId, status: result.status },
  });
  const parsed = parseVerdict(result.finalContent);
  return parsed;
}

/** 从评审回答中提取 JSON 判定（取最后一个 JSON 对象；解析失败 fail-closed） */
function parseVerdict(content: string): Verdict {
  const text = String(content ?? '');
  const matches = [...text.matchAll(/\{[^{}]*"pass"[^{}]*\}/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(matches[i][0]);
      if (typeof obj.pass === 'boolean') {
        return {
          pass: obj.pass,
          issues: Array.isArray(obj.issues) ? obj.issues.filter((x: any) => typeof x === 'string').slice(0, 6) : [],
          raw: text.slice(0, 200),
        };
      }
    } catch { /* try next */ }
  }
  // 宽松兜底：明确的 PASS/FAIL 字样
  if (/\bPASS\b/.test(text) && !/\bFAIL\b/.test(text)) return { pass: true, issues: [], raw: text.slice(0, 200) };
  if (/\bFAIL\b/.test(text) && !/\bPASS\b/.test(text)) return { pass: false, issues: [text.slice(0, 200)], raw: text.slice(0, 200) };
  return { pass: false, issues: [], parseFailed: true, raw: text.slice(0, 200) };
}
