import OpenAI from 'openai';
import type {
  ChatProvider, ChatRequest, ChatResponse, ChatMessage, ChatUsage, ProviderConfig, StopReason, ToolCall,
} from './types.js';
import { withRetry, classifyProviderError, describeError, type RetryPolicy } from './retry.js';

/**
 * 检测并解析 DSML 文本型工具调用（对包装形态免疫：全角 ｜ / ASCII 变体均可）。
 * 策略：统一 ｜→| 后按 `invoke name="..."` 分段，段内抽取 parameter 键值。
 * 无 DSML 或解析不出 → null。
 */
export function parseDsmlToolCalls(content: string): { toolCalls: ToolCall[]; remaining: string } | null {
  if (!content || !content.includes('DSML') || !content.includes('invoke')) return null;

  const norm = content.replace(/｜/g, '|'); // 全角 ｜ → |
  if (!norm.includes('invoke')) return null;

  const segs = norm.split(/invoke\s+name=/);
  const toolCalls: ToolCall[] = [];
  // segs[0] = 前导正文；之后每段 = "name">params... 直到下一个 invoke
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i];
    const nameM = seg.match(/^"([^"]+)"/);
    if (!nameM) continue;
    const name = nameM[1].trim();
    if (!name) continue;
    const rest = seg.slice(nameM[0].length);
    const input: Record<string, any> = {};
    // parameter name="k">VALUE</...parameter>（闭合标记形态不定 — 值取到下一个 < 为止）
    const paramRe = /parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)(?=<\/\|*DSML|<(?:\|*DSML)?\s*invoke|<\/\|*DSML|$)/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(rest)) !== null) {
      const key = pm[1];
      const rawValue = pm[2].replace(/\|*DSML\|*/g, '').replace(/^>|</g, '').trim();
      try {
        input[key] = JSON.parse(rawValue);
      } catch {
        input[key] = rawValue;
      }
    }
    toolCalls.push({ id: `dsml_${toolCalls.length}`, name, input });
  }
  if (toolCalls.length === 0) return null;

  // 正文 = 第一个 DSML 标记之前的自然语言部分
  const cut = Math.min(
    ...[norm.indexOf('<|'), norm.indexOf('<<')].filter(v => v >= 0).concat([norm.length])
  );
  const remaining = norm.slice(0, cut === norm.length ? contentCutIndex(content) : cut).trim();
  return { toolCalls, remaining };
}

function contentCutIndex(original: string): number {
  const i1 = original.indexOf('<｜');
  const i2 = original.indexOf('<<');
  const candidates = [i1, i2].filter(v => v >= 0);
  return candidates.length > 0 ? Math.min(...candidates) : original.length;
}

/**
 * M1-1：OpenAI 兼容端点 provider（DashScope / DeepSeek / OpenRouter / Ollama / OpenAI…）。
 * 传输层重试（网络/429/5xx）复用 providers/retry；中止信号直传 SDK。
 */
export class OpenAICompatProvider implements ChatProvider {
  readonly id = 'openai-compat' as const;

  /** any：测试可注入桩客户端；SDK 重载类型对动态构造的参数过严 */
  private client: any;
  private model: string;
  private policy: RetryPolicy;

  constructor(config: ProviderConfig, defaultPolicy: RetryPolicy) {
    this.client = config.clientOverride ?? new OpenAI({
      baseURL: config.baseUrl || undefined,
      apiKey: config.apiKey || 'placeholder',
    });
    this.model = config.model;
    this.policy = defaultPolicy;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const params: Record<string, any> = {
      model: this.model,
      messages: this.toOpenAIMessages(req),
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? 4096,
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map(t => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
      ...(req.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
    };

    const response: any = await this.call(
      () => this.client.chat.completions.create(params, { signal: req.signal }),
      req.signal
    );

    const choice = response.choices[0];
    const message = choice?.message ?? {};
    const rawCalls = (message.tool_calls ?? []) as any[];

    const result: ChatResponse = {
      content: message.content ?? '',
      toolCalls: rawCalls
        .filter(c => c?.type === 'function' || c?.function)
        .map(c => ({
          id: c.id ?? '',
          name: c.function?.name ?? '',
          input: safeParseJson(c.function?.arguments),
        })),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      stopReason: mapStopReason(choice?.finish_reason),
    };
    return normalizeDegradedToolCalls(result);
  }

  async stream(req: ChatRequest, onChunk: (delta: string) => void): Promise<ChatResponse> {
    const params: Record<string, any> = {
      model: this.model,
      messages: this.toOpenAIMessages(req),
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? 4096,
      stream: true,
      // REG-01（审查 P0）：stream 此前丢失 tools — agent loop 主路径（chatStream）下
      // 模型收不到 function 定义，全靠 DSML 退化归一化兜底才"看起来正常"
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map(t => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
      ...(req.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
    };

    let full = '';
    let finishReason: string | undefined;
    let usage: ChatUsage = { inputTokens: 0, outputTokens: 0 };
    // 工具调用分片按 index 组装（流式下 function.arguments 逐段到达）
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    // M0-4 语义保留：已向消费者交付过 chunk 则不重试（避免重复输出）
    let delivered = false;
    // DSML 抑制 v3：显示缓冲 — 末尾疑似标记前缀/标记延续的内容扣住不发
    let pending = '';
    let emitted = 0;

    // 可安全下发的长度：最后一个 '<' 若开启疑似标记（<｜ / << 的前缀或延续）→ 扣住其后全部
    const safeLen = (buf: string): number => {
      const lt = buf.lastIndexOf('<');
      if (lt < 0) return buf.length;
      const tail = buf.slice(lt);
      const potential = '<｜'.startsWith(tail) || '<<'.startsWith(tail);
      const confirmed = tail.startsWith('<｜') || tail.startsWith('<<');
      return potential || confirmed ? lt : buf.length;
    };

    await withRetry(
      async () => {
        // 重试边界重置（审查 P1）：full/toolAcc 不重置会把第一次的半截内容与
        // 工具分片拼进第二次结果（'<' 开头被扣留或工具分片已到达时 delivered=false）
        pending = ''; emitted = 0; full = ''; toolAcc.clear(); finishReason = undefined;
        const stream = await this.client.chat.completions.create(params, { signal: req.signal });
        for await (const chunk of stream as any) {
          const delta = chunk?.choices?.[0]?.delta;
          if (chunk?.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens ?? usage.inputTokens,
              outputTokens: chunk.usage.completion_tokens ?? usage.outputTokens,
            };
          }
          if (delta?.content) {
            full += delta.content;
            // DSML 抑制 v3（标记感知扣留）：
            // '<' 与 '｜' 常在不同 delta 到达。策略：pending 中最后一个 '<'
            // 之后若为疑似标记（<｜ / << 的前缀或延续）→ 扣住其后内容不发；
            // 确认是普通文本（'<' 后跟其他字符）→ 全部放行。
            // 绝不提前退出流 — 剩余 chunk（含 tool_calls 分片/finish_reason）必须继续消费。
            pending += delta.content;
            const cut = safeLen(pending);
            if (cut > emitted) {
              const out = pending.slice(emitted, cut);
              emitted = cut;
              delivered = true;
              try { onChunk(out); } catch { /* 消费者异常不中断流 */ }
            }
          }
          for (const tc of delta?.tool_calls ?? []) {
            const slot = toolAcc.get(tc.index) ?? { id: '', name: '', args: '' };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
            toolAcc.set(tc.index, slot);
          }
          if (chunk?.choices?.[0]?.finish_reason) {
            finishReason = chunk.choices[0].finish_reason;
          }
        }
      },
      this.policy,
      {
        isRetryable: err => !delivered && classifyProviderError(err, req.signal) === 'transient',
        onRetry: (attempt, delayMs, err) =>
          console.warn(`[LLM/openai-compat] 流式瞬时错误，${delayMs}ms 后第 ${attempt} 次重试: ${describeError(err)}`),
      }
    );
    // 流结束：放行尾部普通文本残留；疑似标记残留丢弃（完整内容在 full，归一化已处理）
    const tailCut = (() => {
      const lt = pending.lastIndexOf('<');
      if (lt < 0) return pending.length;
      const tail = pending.slice(lt);
      return tail.startsWith('<｜') || tail.startsWith('<<') || tail.includes('DSML') ? lt : pending.length;
    })();
    if (tailCut > emitted) {
      delivered = true;
      try { onChunk(pending.slice(emitted, tailCut)); } catch { /* ignore */ }
    }
    pending = ''; emitted = 0;

    return normalizeDegradedToolCalls({
      content: full,
      toolCalls: [...toolAcc.entries()].map(([, t]) => ({
        id: t.id,
        name: t.name,
        input: safeParseJson(t.args),
      })),
      usage,
      stopReason: mapStopReason(finishReason),
    });
  }

  /** 请求参数构造（stream/complete 共用） */
  private buildParams(req: ChatRequest, stream: boolean): Record<string, any> {
    const params: Record<string, any> = {
      model: this.model,
      messages: this.toOpenAIMessages(req),
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? 4096,
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map(t => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
      ...(req.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      ...(stream ? { stream: true } : {}),
    };
    return params;
  }

  /** 消息映射：system 合并前置；assistant 携带 tool_calls；tool → role:'tool' + tool_call_id */
  private toOpenAIMessages(req: ChatRequest): any[] {
    const out: any[] = [];
    if (req.system) out.push({ role: 'system', content: req.system });

    for (const m of req.messages) {
      if (m.role === 'system') {
        out.push({ role: 'system', content: m.content });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        });
      } else if (m.role === 'tool') {
        out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      } else {
        out.push({ role: m.role, content: m.content });
      }
    }
    return out;
  }

  private call<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withRetry(fn, this.policy, {
      isRetryable: err => classifyProviderError(err, signal) === 'transient',
      onRetry: (attempt, delayMs, err) =>
        console.warn(`[LLM/openai-compat] 瞬时错误，${delayMs}ms 后第 ${attempt} 次重试: ${describeError(err)}`),
    });
  }
}

function mapStopReason(finish: string | undefined | null): StopReason {
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'length') return 'max_tokens';
  if (finish === 'stop' || !finish) return 'end';
  return 'other';
}

/**
 * 退化归一化：无标准 tool_calls 但 content 含 DSML 文本型调用 → 解析转正。
 * 标记 response.degraded 供上层告警（loop 会发事件，UI 可见）。
 */
function normalizeDegradedToolCalls(result: ChatResponse): ChatResponse {
  if (result.toolCalls.length > 0 || !result.content) return result;
  const parsed = parseDsmlToolCalls(result.content);
  if (!parsed) return result;
  console.warn(`[LLM/openai-compat] 检测到 DSML 文本型工具调用（${parsed.toolCalls.length} 个），已解析转正`);
  return {
    ...result,
    content: parsed.remaining,
    toolCalls: parsed.toolCalls,
    stopReason: 'tool_use',
    degraded: true,
  };
}

function safeParseJson(raw: string | undefined): Record<string, any> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? v : { value: v };
  } catch {
    return { _raw: raw };
  }
}
