import OpenAI from 'openai';
import type {
  ChatProvider, ChatRequest, ChatResponse, ChatMessage, ChatUsage, ProviderConfig, StopReason,
} from './types.js';
import { withRetry, classifyProviderError, describeError, type RetryPolicy } from './retry.js';

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

    return {
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
            delivered = true;
            try { onChunk(delta.content); } catch { /* 消费者异常不中断流 */ }
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

    return {
      content: full,
      toolCalls: [...toolAcc.entries()].map(([, t]) => ({
        id: t.id,
        name: t.name,
        input: safeParseJson(t.args),
      })),
      usage,
      stopReason: mapStopReason(finishReason),
    };
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

function safeParseJson(raw: string | undefined): Record<string, any> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? v : { value: v };
  } catch {
    return { _raw: raw };
  }
}
