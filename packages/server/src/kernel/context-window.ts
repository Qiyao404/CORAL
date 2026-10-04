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
  maxTotalChars: 240_000,
  keepRecent: 12,
  summarize: async t => `[摘要生成器未注入] ${t.slice(0, 2000)}`,
};

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
