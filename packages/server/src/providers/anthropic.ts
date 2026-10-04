import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatProvider, ChatRequest, ChatResponse, ChatMessage, ProviderConfig, StopReason,
} from './types.js';
import { withRetry, classifyProviderError, describeError, type RetryPolicy } from './retry.js';

/**
 * M1-1：Anthropic 原生 provider。
 *
 * 与 openai-compat 的关键差异在内部消化：
 *  · system 独立参数（支持 cache_control，D15 默认开启）
 *  · 工具调用 = assistant 的 tool_use 内容块；工具结果 = user 的 tool_result 块
 *  · 消息角色必须交替 — 连续同角色消息自动合并为多块单消息
 *  · max_tokens 必填（默认 4096）
 */
export class AnthropicProvider implements ChatProvider {
  readonly id = 'anthropic' as const;

  /** any：测试可注入桩客户端；SDK 的重载类型对动态参数过严 */
  private client: any;
  private model: string;
  private promptCaching: boolean;
  private policy: RetryPolicy;

  constructor(config: ProviderConfig, defaultPolicy: RetryPolicy) {
    this.client = config.clientOverride ?? new Anthropic({
      apiKey: config.apiKey || 'placeholder',
      baseURL: config.baseUrl || undefined,
    });
    this.model = config.model;
    // D15：默认开启（显式传 false 关闭）
    this.promptCaching = config.promptCaching !== false;
    this.policy = defaultPolicy;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const params = this.buildParams(req);
    const response = await this.call(
      () => this.client.messages.create(params, { signal: req.signal }),
      req.signal
    );

    return this.fromAnthropicMessage(response);
  }

  async stream(req: ChatRequest, onChunk: (delta: string) => void): Promise<ChatResponse> {
    const params = { ...this.buildParams(req), stream: true };

    let text = '';
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    let stopReason: StopReason = 'end';
    let inputTokens = 0;
    let outputTokens = 0;
    // M0-4 语义保留：已向消费者交付过 chunk 则不重试（避免重复输出）
    let delivered = false;

    await withRetry(
      async () => {
        // 重试边界重置（审查 P1，对齐 openai-compat）：toolBlocks 不重置会拼接两次尝试的分片
        text = ''; toolBlocks.clear(); stopReason = 'end'; delivered = false;
        const events = await this.client.messages.create(params, { signal: req.signal });

        for await (const ev of events as any) {
          switch (ev.type) {
            case 'message_start':
              inputTokens = ev.message?.usage?.input_tokens ?? inputTokens;
              break;
            case 'content_block_start':
              if (ev.content_block?.type === 'tool_use') {
                toolBlocks.set(ev.index, {
                  id: ev.content_block.id ?? '',
                  name: ev.content_block.name ?? '',
                  json: '',
                });
              }
              break;
            case 'content_block_delta': {
              const d = ev.delta;
              if (d?.type === 'text_delta' && d.text) {
                text += d.text;
                delivered = true;
                try { onChunk(d.text); } catch { /* 消费者异常不中断流 */ }
              } else if (d?.type === 'input_json_delta' && d.partial_json) {
                const slot = toolBlocks.get(ev.index);
                if (slot) slot.json += d.partial_json;
              }
              break;
            }
            case 'message_delta':
              stopReason = mapStopReason(ev.delta?.stop_reason);
              outputTokens = ev.usage?.output_tokens ?? outputTokens;
              break;
            default:
              break;
          }
        }
      },
      this.policy,
      {
        isRetryable: err => !delivered && classifyProviderError(err, req.signal) === 'transient',
        onRetry: (attempt, delayMs, err) =>
          console.warn(`[LLM/anthropic] 流式瞬时错误，${delayMs}ms 后第 ${attempt} 次重试: ${describeError(err)}`),
      }
    );

    return {
      content: text,
      toolCalls: [...toolBlocks.values()].map(t => ({
        id: t.id,
        name: t.name,
        input: safeParseJson(t.json),
      })),
      usage: { inputTokens, outputTokens },
      stopReason,
    };
  }

  /** 构造 anthropic 请求参数（system 抽取、角色交替合并、cache_control、jsonMode 指令） */
  private buildParams(req: ChatRequest): Record<string, any> {
    const systemParts: string[] = [];
    if (req.system) systemParts.push(req.system);
    for (const m of req.messages) {
      if (m.role === 'system') systemParts.push(m.content);
    }
    if (req.jsonMode) {
      systemParts.push('Output only valid JSON. No prose, no code fences.');
    }

    // 非 system 消息 → anthropic 块结构；连续同角色合并（anthropic 要求角色交替）
    const merged: Array<{ role: 'user' | 'assistant'; blocks: any[] }> = [];
    for (const m of req.messages) {
      if (m.role === 'system') continue;

      const [role, newBlocks] = this.toAnthropicBlock(m);
      const last = merged[merged.length - 1];
      if (last && last.role === role) {
        last.blocks.push(...newBlocks);
      } else {
        merged.push({ role, blocks: [...newBlocks] });
      }
    }

    const params: Record<string, any> = {
      model: this.model,
      max_tokens: req.maxTokens ?? 4096, // anthropic 必填
      messages: merged.map(({ role, blocks }) => ({ role, content: blocks })),
    };

    if (systemParts.length > 0) {
      const systemText = systemParts.join('\n\n');
      params.system = this.promptCaching
        ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
        : systemText;
    }

    if (req.tools?.length) {
      const tools: any[] = req.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
      // D15：最后一个工具打 cache_control — 缓存 system+全部工具定义这一整段前缀
      if (this.promptCaching) {
        tools[tools.length - 1].cache_control = { type: 'ephemeral' };
      }
      params.tools = tools;
    }

    if (req.temperature !== undefined) params.temperature = req.temperature;
    return params;
  }

  /** 单条内部消息 → anthropic 内容块数组（统一返回数组，便于连续同角色合并） */
  private toAnthropicBlock(m: ChatMessage): ['user' | 'assistant', any[]] {
    if (m.role === 'tool') {
      // 工具结果以 user 角色的 tool_result 块回传
      return ['user', [{
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
      }]];
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return ['assistant', [
        ...(m.content ? [{ type: 'text', text: m.content }] : []),
        ...m.toolCalls.map(tc => ({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input,
        })),
      ]];
    }
    return [m.role as 'user' | 'assistant', [{ type: 'text', text: m.content }]];
  }

  /** anthropic 响应消息 → 统一 ChatResponse（文本块拼接 + tool_use 块提取） */
  private fromAnthropicMessage(message: any): ChatResponse {
    const textParts: string[] = [];
    const toolCalls: any[] = [];
    for (const block of message.content ?? []) {
      if (block.type === 'text') textParts.push(block.text ?? '');
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id ?? '', name: block.name ?? '', input: block.input ?? {} });
      }
    }
    return {
      content: textParts.join('\n'),
      toolCalls,
      usage: {
        inputTokens: message.usage?.input_tokens ?? 0,
        outputTokens: message.usage?.output_tokens ?? 0,
      },
      stopReason: mapStopReason(message.stop_reason),
    };
  }

  private call<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withRetry(fn, this.policy, {
      isRetryable: err => classifyProviderError(err, signal) === 'transient',
      onRetry: (attempt, delayMs, err) =>
        console.warn(`[LLM/anthropic] 瞬时错误，${delayMs}ms 后第 ${attempt} 次重试: ${describeError(err)}`),
    });
  }
}

function mapStopReason(stop: string | undefined | null): StopReason {
  if (stop === 'tool_use') return 'tool_use';
  if (stop === 'max_tokens') return 'max_tokens';
  if (stop === 'end_turn' || stop === 'stop_sequence' || !stop) return 'end';
  return 'other';
}

function safeParseJson(raw: string): Record<string, any> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? v : { value: v };
  } catch {
    return { _raw: raw };
  }
}
