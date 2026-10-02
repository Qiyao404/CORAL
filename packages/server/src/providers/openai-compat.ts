import OpenAI from 'openai';
import type {
  ChatProvider, ChatRequest, ChatResponse, ChatMessage, ChatUsage, ProviderConfig, StopReason, ToolCall,
} from './types.js';
import { withRetry, classifyProviderError, describeError, type RetryPolicy } from './retry.js';

/**
 * M1 复审补丁：DeepSeek V3.2 系模型的「工具调用退化」——
 * 间歇性地把工具调用以 DSML 特殊标记文本（<｜｜DSML｜｜ invoke name="...">）打印在
 * content 里而不是走标准 tool_calls 字段。这里做归一化：检测 → 解析 → 转标准
 * tool_calls，循环层无感。同时保留 degraded 标记供上层告警。
 */

const DSML_INVOKE_RE = /invoke\s+name="([^"]+)"([\s\S]*?)(?=<｜｜?DSML｜｜?\s*invoke|<\/｜｜?DSML｜｜?\s*calls>|$)/g;
const DSML_PARAM_RE = /parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)(?=<｜｜?DSML｜｜?\s*(?:parameter|invoke)|<\/｜｜?DSML|$)/g;

/** 检测并解析 DSML 文本型工具调用；无 DSML 或解析不出 → null */
export function parseDsmlToolCalls(content: string): { toolCalls: ToolCall[]; remaining: string } | null {
  if (!content || !content.includes('DSML')) return null;
  if (!content.includes('invoke')) return null;

  const toolCalls: ToolCall[] = [];
  let m: RegExpExecArray | null;
  DSML_INVOKE_RE.lastIndex = 0;
  let seq = 0;
  while ((m = DSML_INVOKE_RE.exec(content)) !== null) {
    const name = m[1];
    const body = m[2];
    if (!name) continue;
    const input: Record<string, any> = {};
    let pm: RegExpExecArray | null;
    DSML_PARAM_RE.lastIndex = 0;
    while ((pm = DSML_PARAM_RE.exec(body)) !== null) {
      const key = pm[1];
      const rawValue = pm[2].trim();
      try {
        input[key] = JSON.parse(rawValue);
      } catch {
        input[key] = rawValue;
      }
    }
    toolCalls.push({ id: `dsml_${seq++}`, name, input });
  }
  if (toolCalls.length === 0) return null;

  // 正文 = 第一个 DSML 标记之前的自然语言部分
  const cut = content.indexOf('<｜');
  return { toolCalls, remaining: content.slice(0, cut > 0 ? cut : 0).trim() };
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
      ...(req.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
    };

    let full = '';
    let finishReason: string | undefined;
    let usage: ChatUsage = { inputTokens: 0, outputTokens: 0 };
    // 工具调用分片按 index 组装（流式下 function.arguments 逐段到达）
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    // M0-4 语义保留：已向消费者交付过 chunk 则不重试（避免重复输出）
    let delivered = false;

    await withRetry(
      async () => {
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
            // DSML 抑制（创新①配套）：一旦发现退化标记，停止向消费者发增量
            // （否则退化原文会以「回答」形态流式显示；最终仍会被归一化为 tool_calls）
            if (!full.includes('<｜') && !full.includes('DSML')) {
              delivered = true;
              try { onChunk(delta.content); } catch { /* 消费者异常不中断流 */ }
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
