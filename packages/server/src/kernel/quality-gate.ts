/**
 * 收工门（确定性质量门）— 在模型宣布"完成"时对最终回答做一次话术审计。
 *
 * 核心洞察：自评式提问（"你确定吗？"）永远不会改变模型输出；只有把
 * "合理化话术"（把没做的事说成可以不做）确凿地摆出来并要求正面回应，
 * 才能逼出真实的收尾行为。全部规则是纯正则/计数 — 不依赖模型自觉。
 *
 * 防呆设计（缺一不可，否则门本身会变成死循环或新用户杀手）：
 *  · 触发门槛：只有复杂任务（≥3 次写操作或 ≥5 次工具调用）才启用强校验
 *  · 次数上限：最多打回 2 次，第 3 次放行并发出降级警告事件
 *  · 降级路径：预算耗尽的收尾、取消、失败路径一律跳过（模型已无行动能力）
 */

export interface RationalizationHit {
  /** 稳定 ID（事件与测试引用） */
  id: string;
  /** 命中的原文片段（带少量上下文） */
  quote: string;
}

interface Pattern {
  id: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  // 历史遗留 — "这不是我弄坏的" 式免责
  { id: 'pre-existing', re: /pre-?existing\s+(issue|bug|problem|behavior|error)/i },
  { id: 'pre-existing-zh', re: /历史遗留|既有(问题|缺陷)|原本就(存在|有|是)这?个?(问题|错误|行为)/ },
  // 跳过测试/验证（两种语序：动词在前 / 测试在前）
  { id: 'skip-tests', re: /skip(ping|ped)?\s+(the\s+)?(tests?|verification|validation)/i },
  { id: 'skip-tests-zh', re: /(跳过|忽略|略过)(了)?(全部|所有)?(测试|验证|校验)|(测试|验证|校验|用例)[^。]{0,8}(暂时|先|直接|全部|整体)?(跳过|忽略|略过)/ },
  { id: 'tests-failing-later', re: /tests?\s+(are\s+)?(fail\w*|not\s+pass\w*)[^.]{0,30}(later|next|follow)/i },
  { id: 'tests-failing-zh', re: /(测试|用例)(暂时)?(失败|未通过|没过)[^。]{0,20}(以后|稍后|后续|下次)/ },
  // 延后修复
  { id: 'fix-later', re: /(will|we'?ll)\s+(fix|address|handle)\s+(it|this|that|them)\s+later/i },
  { id: 'fix-later-zh', re: /(后续|稍后|以后|下次)再?(修|处理|补|完善|优化)/ },
  // 范围外推脱
  { id: 'out-of-scope', re: /(out\s+of|beyond)\s+(the\s+)?(scope|range)\s+of\s+(this|the)/i },
  { id: 'out-of-scope-zh', re: /不在(本次|当前|这次)(任务|范围|范围内)|超出.{0,6}(任务|需求)范围/ },
  // "暂时" 交付不完整
  { id: 'for-now', re: /(leave|left)\s+it\s+(as\s+is|for\s+now)|keep\s+the\s+(old|existing)\s+(version|implementation)/i },
  { id: 'for-now-zh', re: /暂时(保持|沿用|保留)(现状|原样|旧版|现有)/ },
];

/** 检测最终回答中的合理化话术（全部模式独立扫描，返回全部命中） */
export function detectRationalization(text: string): RationalizationHit[] {
  const t = String(text ?? '');
  if (!t) return [];
  const hits: RationalizationHit[] = [];
  for (const { id, re } of PATTERNS) {
    const m = re.exec(t);
    if (!m) continue;
    const start = Math.max(0, m.index - 30);
    hits.push({ id, quote: t.slice(start, m.index + m[0].length + 30).replace(/\s+/g, ' ').trim() });
  }
  return hits;
}

/** 任务复杂度：写类操作数与总工具调用数 */
export interface TaskComplexity {
  writeOps: number;
  toolCalls: number;
}

/** 收工门是否应启用强校验（简单任务不设门 — 新用户/问答场景零打扰） */
export function shouldGate(c: TaskComplexity): boolean {
  return c.writeOps >= 3 || c.toolCalls >= 5;
}

/** 打回时注入的追问（要求正面回应，不允许再次含糊） */
export function gatePushback(hits: RationalizationHit[], remaining: number): string {
  const list = hits.map(h => `- [${h.id}] "${h.quote}"`).join('\n');
  return (
    `[system] FINAL ANSWER REJECTED BY QUALITY GATE. Your answer contains deferred-work rationalization:\n${list}\n` +
    `You have ${remaining} chance(s). Either:\n` +
    `(a) actually DO the deferred work now (run the tests, fix the issue, complete the partial delivery) and then rewrite your final answer; or\n` +
    `(b) rewrite your final answer with an explicit "## 未完成事项" section honestly listing each deferred item and its reason.\n` +
    `Do not repeat the rationalization phrasing. Do not apologize without choosing (a) or (b).`
  );
}
