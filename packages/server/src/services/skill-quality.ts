/**
 * 技能质量门 — "用自然语言造技能"的最后一道闸。
 *
 * 定位：技能一旦落盘就会以 skill_* 工具的形式进入模型的工具列表 —
 * 一个低质技能（名字随意、描述没有触发场景、和现有技能重复）会持续污染
 * 模型选型。质量门在提交时做确定性校验：错误（errors）阻断提交，
 * 提醒（warnings）随提交事件留痕。
 *
 * 校验维度（全部可确定性判定）：
 *  · 命名：kebab-case 正则（writeSkillAtomic 兜底）+ 冗余前缀 + 占位名
 *  · 描述：长度下限 + 空话黑名单 + 触发场景信号词（缺=提醒）
 *  · 范围：input_schema 形状 + promptContent 厚度
 *  · 查重：与现有技能名/描述的词重叠（近重复=提醒，建议改造而非新建）
 */

export interface SkillDraftInput {
  name: string;
  description: string;
  executionMode?: string;
  promptContent?: string;
  inputSchema?: Record<string, any>;
}

export interface SkillQualityReport {
  errors: string[];
  warnings: string[];
}

const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
const PLACEHOLDER_NAMES = new Set(['my-skill', 'new-skill', 'test-skill', 'todo-skill', 'skill-1', 'aaa', 'demo']);
const TRIGGER_SIGNALS = /(当|当用户|适用|适用于|用于|使用场景|适合|触发|use when|when |whenever|适合于)/i;

/** 空话判定：剥掉泛用外壳词后若没有实质内容（<6 字符）即视为空话 */
const GENERIC_PREFIX = /^(一个|一种|一套|帮我|给我|处理|自动|新的|做个|做|制作|创建|生成|实现|功能|技能|工具|助手|skill|tool|helper|new |my |auto )+/i;
const GENERIC_SUFFIX = /(技能|工具|助手|功能|skill|tool)$/i;
function isGenericDesc(desc: string): boolean {
  let s = desc.replace(GENERIC_PREFIX, '').trim();
  s = s.replace(GENERIC_SUFFIX, '').trim();
  return s.length < 6;
}

/** 与现有技能的近重复判定：名字词集重合 ≥50%（两词名共享一个特征词即提醒） */
function nameOverlap(a: string, b: string): boolean {
  const wa = new Set(a.split('-').filter(w => w.length > 1));
  const wb = new Set(b.split('-').filter(w => w.length > 1));
  if (wa.size === 0 || wb.size === 0) return false;
  let hit = 0;
  for (const w of wa) if (wb.has(w)) hit++;
  return hit / Math.min(wa.size, wb.size) >= 0.5;
}

export function validateSkillDraft(
  draft: SkillDraftInput,
  existing: Array<{ name: string; description?: string }> = []
): SkillQualityReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── 命名 ──
  const name = String(draft.name ?? '').trim();
  if (!NAME_RE.test(name)) {
    errors.push(`技能名 "${name}" 不合法：须为 kebab-case（小写字母开头，仅小写字母/数字/连字符，2-41 字符）`);
  }
  if (PLACEHOLDER_NAMES.has(name)) {
    errors.push(`技能名 "${name}" 是占位名 — 请起一个表意的名字（如 web-digest、data-cleaner）`);
  }
  if (/^skill-/.test(name)) {
    warnings.push('名字以 "skill-" 开头是冗余的（技能挂载后自动带 skill_ 前缀）— 建议去掉');
  }

  // ── 描述 ──
  const desc = String(draft.description ?? '').trim();
  if (desc.length < 10) {
    errors.push(`描述过短（${desc.length} 字符，至少 10 字符）— 描述是模型选技能的唯一依据`);
  }
  if (desc.length >= 10 && isGenericDesc(desc)) {
    errors.push(`描述 "${desc}" 是空话 — 必须说明这个技能具体做什么、产出什么`);
  }
  if (desc.length >= 10 && !TRIGGER_SIGNALS.test(desc)) {
    warnings.push('描述里没有触发场景（如"当用户要…时使用"）— 模型判断"何时该用它"会变难，建议补充');
  }
  if (desc.length > 300) {
    warnings.push(`描述 ${desc.length} 字符偏长 — 工具列表里会被截断，建议压缩到 150 字符内`);
  }

  // ── 执行模式 ──
  const mode = String(draft.executionMode ?? 'llm_only');
  if (!['llm_only', 'script', 'hybrid'].includes(mode)) {
    errors.push(`execution_mode "${mode}" 不合法（llm_only | script | hybrid）`);
  }

  // ── 范围 ──
  const schema = draft.inputSchema;
  if (schema !== undefined && (typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object' || typeof schema.properties !== 'object')) {
    errors.push('input_schema 形状不合法（须为 {type:"object", properties:{...}}）');
  }
  const prompt = String(draft.promptContent ?? '').trim();
  if (prompt.length > 0 && prompt.length < 120) {
    warnings.push(`技能正文仅 ${prompt.length} 字符 — 过薄的技能说明会让执行质量不稳定，建议写清步骤/边界/输出要求`);
  }

  // ── 查重（近重复 = 提醒：改造现有技能通常优于新建）──
  for (const ex of existing) {
    if (ex.name === name) continue; // 完全重名由 SkillExistsError 处理
    if (nameOverlap(name, ex.name)) {
      warnings.push(`与现有技能 "${ex.name}" 名字高度相近 — 若功能重复，建议改造现有技能而不是新建`);
      break;
    }
  }

  return { errors, warnings };
}
