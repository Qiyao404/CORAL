import type { Tool } from '../types.js';
import { toolOk, toolError } from '../types.js';

/**
 * 反问工具（ask_user）：模型在高影响、不可逆或凭猜测代价大的分歧点上向用户提问。
 *
 * 设计要点：
 *  · **工具而非技能** — 工具定义随每次 LLM 请求在场（function calling 全程可见），
 *    不存在"该问却没调到技能"的错过问题（技能咨询是可选两步，实测有漏）
 *  · 选择题 + 推荐位 + 自由补充（UI 恒定追加"其他"伪选项）— 由 run-engine 挂起为
 *    waiting_human（与审批同生命周期），用户作答后工具返回继续
 *  · 纪律：仅用于高影响且廉价可确认的分歧（输出格式/范围边界/破坏性操作前确认）；
 *    能查到的别问 — 写在 description，模型每轮可见
 *  · 自动化/评测会话：不挂起，直接返回"用户不可用"让模型按最合理假设继续并注明
 */

export interface AskUserOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface AskUserAnswer {
  source: 'choice' | 'free' | 'timeout' | 'cancelled' | 'unavailable' | 'cap';
  /** source=choice：选中的 label（多条逗号连接）；free：用户输入的原文 */
  answer: string | null;
  note?: string;
}

export interface AskUserPayload {
  question: string;
  options: AskUserOption[];
  allowMultiple?: boolean;
}

export function makeAskUserTool(deps: {
  ask: (payload: AskUserPayload) => Promise<AskUserAnswer>;
  automationSession: boolean;
}): Tool {
  return {
    name: 'ask_user',
    description:
      'Ask the USER a clarifying question with predefined options (multiple-choice + free-text). ' +
      'Use ONLY at high-impact decision points where guessing is expensive and confirmation is cheap: ' +
      'output format/deliverable shape, scope boundaries, ambiguous instructions with very different readings, ' +
      'or before destructive/irreversible actions. Do NOT use for anything you can look up yourself, ' +
      'for trivial preferences, or more than 3 times per task — decide yourself and state your assumption instead. ' +
      'Provide 2-5 concise options (mark recommended:true on the one you would pick), and the user can always type their own answer.',
    inputSchema: {
      type: 'object',
      required: ['question', 'options'],
      properties: {
        question: { type: 'string', description: 'The question to show the user (one clear sentence)' },
        options: {
          type: 'array',
          description: '2-5 concise options; mark recommended:true on the one you would pick',
          items: {
            type: 'object',
            required: ['label'],
            properties: {
              label: { type: 'string', description: 'Short option text' },
              description: { type: 'string', description: 'One-line explanation of when to pick this' },
              recommended: { type: 'boolean', description: 'Mark your recommended option' },
            },
          },
        },
        allowMultiple: { type: 'boolean', description: 'Allow selecting multiple options (default false)' },
      },
    },
    source: 'builtin',
    permission: 'auto',
    async invoke(input: any) {
      const question = String(input?.question ?? '').trim();
      const options = Array.isArray(input?.options) ? input.options : [];
      if (!question) return toolError('BAD_INPUT', 'question 必填');
      const clean = options
        .filter((o: any) => o && typeof o.label === 'string' && o.label.trim())
        .slice(0, 5)
        .map((o: any) => ({
          label: String(o.label).slice(0, 120),
          ...(typeof o.description === 'string' && o.description.trim() ? { description: o.description.slice(0, 200) } : {}),
          ...(o.recommended === true ? { recommended: true } : {}),
        }));
      if (clean.length < 2) return toolError('BAD_INPUT', '至少提供 2 个选项（每个含非空 label）');

      // 评测/自动化隔离：不挂起等人 — 按最合理假设继续并在结果注明
      if (deps.automationSession) {
        return toolOk({
          source: 'unavailable',
          answer: null,
          note: '用户不可用（自动化/评测会话）。请自行按最合理假设继续，并在最终回答中明确标注所做假设。',
        });
      }
      const r = await deps.ask({ question, options: clean, allowMultiple: input?.allowMultiple === true });
      return toolOk(r as any);
    },
  };
}
