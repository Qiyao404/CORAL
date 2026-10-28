import type { ChatMessage } from '../providers/types.js';

/**
 * M1-3：上下文窗口管理 — 两级防护。
 *
 *  1. clipToolResults（永远开启）：单条工具结果超过上限 → 头尾保留 + 截断标记。
 *     模型不需要完整的 2MB 网页，需要的是「够用的开头 + 知道被截断」。
 *  2. compressIfNeeded（超阈值触发）：历史总量超限时，把「中段」压缩为一条摘要消息，
 *     保留首条 goal 与最近 keepRecent 条 — 摘要由注入的 LLM 回调生成（run-engine 接 llmClient）。
 */

export interface ClipOptions {
  maxToolChars: number;   // 单条工具结果上限，默认 40k 字符
}

const DEFAULT_CLIP: ClipOptions = { maxToolChars: 40_000 };

/** 就地裁剪过长的工具结果（返回新数组；对 assistant/user 消息不动） */
export function clipToolResults(messages: ChatMessage[], options: Partial<ClipOptions> = {}): ChatMessage[] {
  const { maxToolChars } = { ...DEFAULT_CLIP, ...options };
  return messages.map(m => {
    if (m.role !== 'tool' || m.content.length <= maxToolChars) return m;
    const head = Math.floor(maxToolChars * 0.8);
    const tail = Math.floor(maxToolChars * 0.1);
    return {
      ...m,
      content:
        m.content.slice(0, head) +
        `\n\n[...工具结果过长，已截断（原 ${m.content.length} 字符，保留头部 ${head} + 尾部 ${tail}）...]` +
        m.content.slice(-tail),
    };
  });
}

export interface CompressOptions {
  /** 历史总字符数阈值（默认 240k ≈ 6 万 token 量级） */
  maxTotalChars: number;
  /** 压缩时保留最近 N 条消息（默认 12） */
  keepRecent: number;
  /** 摘要生成器（LLM 回调） */
  summarize: (transcript: string) => Promise<string>;
}

const DEFAULT_COMPRESS: CompressOptions = {
  maxTotalChars: 1_000_000,
  keepRecent: 12,
  summarize: async t => `[摘要生成器未注入] ${t.slice(0, 2000)}`,
};

// ─── 上下文用量档位（4 档预警，UI 指示器与压缩策略共用）────────────────────

export type UsageLevel = 'ok' | 'warning' | 'critical' | 'blocked';

/** <60% 正常 / <85% 警告 / <100% 危急 / ≥100% 阻塞 */
export function usageLevel(chars: number, maxChars: number): UsageLevel {
  if (maxChars <= 0) return 'ok';
  const ratio = chars / maxChars;
  if (ratio >= 1) return 'blocked';
  if (ratio >= 0.85) return 'critical';
  if (ratio >= 0.6) return 'warning';
  return 'ok';
}

// ─── 层 2.5：确定性摘要兜底（LLM 不可用/冷却中的最后防线）────────────────

/**
 * 确定性压缩：不做任何 LLM 调用，把中段消息压成"逐条首句"式骨架摘要。
 * 质量不如模型摘要，但**永远可用** — 冷却阶梯生效期间硬水位仍在涨时，
 * 保转录完整地降级，而不是放任上下文爆掉。
 */
export function deterministicCompress(
  messages: ChatMessage[],
  options: Partial<CompressOptions> = {}
): CompressResult {
  const opts = mergeOptions(options);
  const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
  if (totalChars <= opts.maxTotalChars || messages.length <= opts.keepRecent + 1) {
    return { messages, compressed: false };
  }

  const first = messages[0];
  let keep = opts.keepRecent;
  while (keep < messages.length - 1 && messages[messages.length - keep].role === 'tool') {
    keep++;
  }
  const recent = messages.slice(-keep);
  const middle = messages.slice(1, messages.length - keep);

  // 逐条骨架：角色 + 首段（工具消息带工具名），严格限量
  const skeleton = middle
    .map(m => {
      const tag = m.toolName ? `${m.role}:${m.toolName}` : m.role;
      const head = m.content.replace(/\s+/g, ' ').trim().slice(0, 160);
      return `[${tag}] ${head}${m.content.length > 160 ? '…' : ''}`;
    })
    .join('\n')
    .slice(0, 6000);

  const summaryMessage: ChatMessage = {
    role: 'user',
    content:
      `[Earlier conversation skeleton — deterministic fallback compression of ${middle.length} messages]\n${skeleton}\n` +
      `[The original task is as follows]\n${first.content}`,
  };
  return { messages: [summaryMessage, ...recent], compressed: true, summary: skeleton };
}

/** 压缩失败冷却阶梯：连续失败第 1/2/3+ 次分别冷却 60s/300s/900s */
export const COMPACT_COOLDOWN_LADDER_MS = [60_000, 300_000, 900_000];

export function cooldownFor(failures: number, ladder: number[] = COMPACT_COOLDOWN_LADDER_MS): number {
  if (failures <= 0) return 0;
  return ladder[Math.min(failures, ladder.length) - 1];
}

// ─── 层 1：收纳旧工具结果（micro 压缩，cache-safe）────────────────────────

export interface ShelveResult {
  messages: ChatMessage[];
  /** 被收纳的工具结果条数 */
  shelved: number;
  /** 释放的字符数 */
  reclaimedChars: number;
}

export interface ShelveOptions {
  /** 保留最近 N 条工具结果原样（默认 4） */
  keepToolResults?: number;
  /** 触发水位：总量超过 maxTotalChars × ratio 才收纳（默认 0.6） */
  triggerRatio?: number;
  /** 单条收纳门槛：短于此长度的结果不动（默认 1500） */
  minChars?: number;
  /** 归档回调：收纳前把完整内容存走，返回可引用的 ID（证据记录层注入） */
  archive?: (toolName: string, content: string) => string | null;
}

/**
 * 收纳旧工具结果：超出软水位时，把较早的长大结果替换为「头部摘要 + 归档引用」占位。
 *  · 不动最近 keepToolResults 条（模型当前推理依赖）
 *  · 已是证据摘要（含 evidenceId）的不重复收纳
 *  · 只替换 content，消息结构（toolCallId 等）保持合法
 */
export function shelveOldToolResults(
  messages: ChatMessage[],
  maxTotalChars: number,
  options: ShelveOptions = {}
): ShelveResult {
  const keep = options.keepToolResults ?? 4;
  const triggerRatio = options.triggerRatio ?? 0.6;
  const minChars = options.minChars ?? 1500;
  const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
  if (totalChars <= maxTotalChars * triggerRatio) {
    return { messages, shelved: 0, reclaimedChars: 0 };
  }

  // 从尾往前找最近 keep 条 tool 消息的边界索引
  let toolSeen = 0;
  let boundary = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') {
      toolSeen++;
      if (toolSeen >= keep) { boundary = i; break; }
    }
  }
  if (toolSeen < keep) {
    return { messages, shelved: 0, reclaimedChars: 0 }; // 工具结果太少，不值得动
  }

  let shelved = 0;
  let reclaimedChars = 0;
  const out = messages.slice();
  for (let i = 0; i < boundary; i++) {
    const m = out[i];
    if (m.role !== 'tool' || m.content.length < minChars) continue;
    if (m.content.includes('"evidenceId"')) continue; // 已是摘要态
    const head = m.content.slice(0, 240);
    const archivedId = options.archive?.(m.toolName ?? 'unknown', m.content) ?? null;
    const stub =
      `[...旧工具结果已收纳（${m.toolName ?? 'tool'}，原 ${m.content.length} 字符）头摘: ${head}...` +
      (archivedId ? ` 完整内容见证据记录 ${archivedId}（evidence_read 可取回）...]` : '...]');
    reclaimedChars += m.content.length - stub.length;
    out[i] = { ...m, content: stub };
    shelved++;
  }
  return { messages: out, shelved, reclaimedChars };
}

export interface CompressResult {
  messages: ChatMessage[];
  compressed: boolean;
  summary?: string;
}

/** 合并选项：undefined 字段回落默认（防止展开覆盖） */
function mergeOptions(options: Partial<CompressOptions>): CompressOptions {
  return {
    maxTotalChars: options.maxTotalChars ?? DEFAULT_COMPRESS.maxTotalChars,
    keepRecent: options.keepRecent ?? DEFAULT_COMPRESS.keepRecent,
    summarize: options.summarize ?? DEFAULT_COMPRESS.summarize,
  };
}

/**
 * 超限压缩：总量 ≤ 阈值原样返回；超限时把 [首条, 中段...] 压缩为
 * 「会话摘要」消息 + 最近 keepRecent 条。首条 goal 永远保留（agent 不能忘记任务）。
 */
export async function compressIfNeeded(
  messages: ChatMessage[],
  options: Partial<CompressOptions> = {}
): Promise<CompressResult> {
  const opts = mergeOptions(options);
  const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
  if (totalChars <= opts.maxTotalChars || messages.length <= opts.keepRecent + 1) {
    return { messages, compressed: false };
  }

  const first = messages[0];
  // 审查 P1：切片边界不得落在工具调用组内部（assistant(toolCalls) 与其 tool 结果
  // 必须同侧）— 否则 recent 以孤儿 tool 消息开头，下次请求两家 API 都会 400
  let keep = opts.keepRecent;
  while (keep < messages.length - 1 && messages[messages.length - keep].role === 'tool') {
    keep++; // recent 起点是 tool → 把前面的 assistant(toolCalls) 一并纳入
  }
  const recent = messages.slice(-keep);
  const middle = messages.slice(1, messages.length - keep);

  const transcript = middle
    .map(m => `[${m.role}${m.toolName ? `:${m.toolName}` : ''}] ${clipForTranscript(m.content)}`)
    .join('\n');
  const summary = await opts.summarize(transcript);

  const summaryMessage: ChatMessage = {
    role: 'user',
    content:
      `[Earlier conversation summary — after compression of ${middle.length} messages]\n${summary}\n` +
      `[The original task is as follows]\n${first.content}`,
  };

  return { messages: [summaryMessage, ...recent], compressed: true, summary };
}

function clipForTranscript(text: string, max = 4000): string {
  return text.length <= max ? text : text.slice(0, max) + '…[truncated]';
}
