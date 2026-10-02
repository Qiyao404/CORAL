import { getActiveLlmConfig } from './llm-config-service.js';
import { platformConfig } from './config.js';
import { createProvider } from '../providers/index.js';
import type {
  ChatProvider, ChatRequest as ProviderChatRequest, ChatResponse as ProviderChatResponse,
  ProviderId,
} from '../providers/types.js';
import { normalizeProviderId } from '../providers/types.js';
import type { RetryPolicy } from '../providers/retry.js';
import type { LLMConfigProfile } from '../types/index.js';

/**
 * M1-1：LLMClient 重写为 providers 层的 facade。
 *
 * · 旧 API（complete / completeStream，简单消息无工具）原样保留 — planning-engine、
 *   skill-executor、skill-builder 无需改动，全部既有测试保持有效
 * · 新增 chat()：面向 M1-3 agent loop 的完整能力入口（工具调用 / usage / stopReason）
 * · provider 按 active profile 的 provider 字段路由（openai-compat / anthropic，D9）
 * · demo 模式（M0-5）与配额友好报错、中止归一化留在本层 — 与具体 provider 无关
 */

/** 旧版简单消息类型（无工具调用）— 保持 v1 兼容 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteResult {
  content: string;
  tokensUsed: number;
  /** demo 模式返回的模拟内容（显式标记，绝不静默伪造） */
  mocked?: boolean;
}

export interface CompleteOptions {
  temperature?: number;
  maxTokens?: number;
  /** 用于流式调用的 chunk 回调 */
  onChunk?: (delta: string) => void;
  /** 取消信号 — 中止进行中的 HTTP 请求（M0-2） */
  signal?: AbortSignal;
}

export type { ProviderId };
export type { ChatRequest, ChatResponse } from '../providers/types.js';

/** 配额（402/余额耗尽）判定 — 仅用于把原始错误包装成对人友好的明确报错 */
const QUOTA_ERROR_CODES = [402];
const QUOTA_ERROR_KEYWORDS = ['quota', 'insufficient', 'balance'];

function isQuotaError(err: any): boolean {
  if (err?.status && QUOTA_ERROR_CODES.includes(err.status)) return true;
  const msg = (err?.message || err?.error?.message || '').toLowerCase();
  return QUOTA_ERROR_KEYWORDS.some(kw => msg.includes(kw));
}

function isAbortError(err: any, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || err?.name === 'AbortError' || err?.constructor?.name === 'APIUserAbortError';
}

function asAbortError(err?: unknown): Error {
  if (err instanceof Error && err.name === 'AbortError') return err;
  const e = new Error('LLM 调用已取消');
  e.name = 'AbortError';
  return e;
}

export class LLMClient {
  private provider: ChatProvider;
  private model: string;
  private baseUrl: string;
  private providerId: ProviderId;

  constructor() {
    this.provider = createProvider(this.providerConfigFrom(getActiveLlmConfig()), this.retryPolicy());
    const active = getActiveLlmConfig();
    this.baseUrl = active.baseUrl;
    this.model = active.model;
    this.providerId = normalizeProviderId((active as any).provider);
  }

  /** 显式演示模式（--demo 启动或 CORAL_DEMO_MODE=1） */
  isDemoMode(): boolean {
    return platformConfig.demoMode;
  }

  getCurrentConfig(): { baseUrl: string; model: string; provider: ProviderId } {
    return { baseUrl: this.baseUrl, model: this.model, provider: this.providerId };
  }

  reconfigure(config: { baseUrl: string; apiKey: string; model: string; provider?: string }): void {
    this.provider = createProvider(
      {
        provider: normalizeProviderId(config.provider ?? this.providerId),
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
      },
      this.retryPolicy()
    );
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    this.providerId = normalizeProviderId(config.provider ?? this.providerId);
  }

  /** M0-4：传输层重试策略（网络/429/5xx；abort 与 4xx 不重试）— 传给 provider 内部使用 */
  private retryPolicy(): RetryPolicy {
    return {
      maxRetries: platformConfig.llmMaxRetries,
      baseDelayMs: platformConfig.llmRetryBaseDelayMs,
      maxDelayMs: 8000,
    };
  }

  private providerConfigFrom(p: LLMConfigProfile) {
    return {
      provider: normalizeProviderId((p as any).provider),
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.model,
    };
  }

  // ─── M1-3 agent loop 主入口：完整能力（工具调用 / usage / stopReason）─────────

  async chat(req: ProviderChatRequest): Promise<ProviderChatResponse> {
    if (this.isDemoMode()) {
      return this.demoChatResponse(req);
    }
    try {
      return await this.provider.complete(req);
    } catch (err: any) {
      if (isAbortError(err, req.signal)) throw asAbortError(err);
      if (isQuotaError(err)) throw this.quotaError(err);
      throw err;
    }
  }

  /**
   * 流式版 chat（创新点①）：逐 token 回调 + 完整结果返回（含工具调用）。
   * agent loop 主路径用这个 — 前端逐字直播，工具调用能力不损失。
   */
  async chatStream(req: ProviderChatRequest, onDelta: (delta: string) => void): Promise<ProviderChatResponse> {
    if (this.isDemoMode()) {
      const r = this.demoChatResponse(req);
      // demo 也模拟逐字
      for (const s of chunkText(r.content, 24)) {
        req.signal?.throwIfAborted?.();
        try { onDelta(s); } catch { /* ignore */ }
        await sleep(20);
      }
      return r;
    }
    try {
      return await this.provider.stream(req, onDelta);
    } catch (err: any) {
      if (isAbortError(err, req.signal)) throw asAbortError(err);
      if (isQuotaError(err)) throw this.quotaError(err);
      throw err;
    }
  }

  // ─── v1 兼容 API（简单消息，无工具调用）───────────────────────────────────────

  /** 一次性（非流式）补全 */
  async complete(messages: ChatMessage[], options?: CompleteOptions): Promise<CompleteResult> {
    if (this.isDemoMode()) {
      return { ...this.demoComplete(messages), mocked: true };
    }
    try {
      const r = await this.provider.complete({
        messages,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        signal: options?.signal,
      });
      return { content: r.content, tokensUsed: r.usage.inputTokens + r.usage.outputTokens };
    } catch (err: any) {
      if (isAbortError(err, options?.signal)) throw asAbortError(err);
      if (isQuotaError(err)) throw this.quotaError(err);
      throw err;
    }
  }

  /** 流式补全 — skill llm_only 路径 */
  async completeStream(messages: ChatMessage[], onChunk: (delta: string) => void, options?: Omit<CompleteOptions, 'onChunk'>): Promise<CompleteResult> {
    if (this.isDemoMode()) {
      const { content, tokensUsed } = this.demoComplete(messages);
      const slices = chunkText(content, 32);
      for (const s of slices) {
        options?.signal?.throwIfAborted?.();
        try { onChunk(s); } catch { /* 忽略消费者异常 */ }
        await sleep(40);
      }
      return { content, tokensUsed, mocked: true };
    }
    try {
      const r = await this.provider.stream(
        { messages, temperature: options?.temperature, maxTokens: options?.maxTokens, signal: options?.signal },
        onChunk
      );
      return { content: r.content, tokensUsed: r.usage.inputTokens + r.usage.outputTokens };
    } catch (err: any) {
      if (isAbortError(err, options?.signal)) throw asAbortError(err);
      if (isQuotaError(err)) throw this.quotaError(err);
      throw err;
    }
  }

  /** 配额错误：把原始 402 包装成用户能直接行动的提示 */
  private quotaError(err: any): Error {
    return new Error(
      `LLM API 配额不足或余额耗尽：请到「设置」页更换 API Key 或充值后重试。原始错误: ${err?.message ?? err}`
    );
  }

  // ─── demo 模式（M0-5：显式演示，绝不静默伪造）───────────────────────────────

  private demoChatResponse(req: ProviderChatRequest): ProviderChatResponse {
    const { content, tokensUsed } = this.demoComplete(req.messages as ChatMessage[]);
    return {
      content,
      toolCalls: [],
      usage: { inputTokens: tokensUsed, outputTokens: 0 },
      stopReason: 'end',
    };
  }

  private demoComplete(messages: ChatMessage[]): { content: string; tokensUsed: number } {
    const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';

    if (lastUserMsg.includes('规划') || messages.some(m => m.content.includes('DAG') && m.content.includes('agents'))) {
      return {
        content: JSON.stringify({
          reasoning: '[Demo] 演示模式的预设两阶段执行计划（--demo 启动，非真实模型输出）',
          agents: [
            {
              agentId: 'demo-a1',
              name: '数据收集智能体',
              role: '负责收集和预处理输入数据',
              assignedSkills: ['summarize-document'],
              skillInputTemplates: { 'summarize-document': { text: '{{goal}}' } },
              dependsOn: [],
              priority: 0,
              estimatedDurationMs: 5000,
            },
            {
              agentId: 'demo-a2',
              name: '结果整合智能体',
              role: '负责整合处理结果并生成最终输出',
              assignedSkills: ['summarize-document'],
              skillInputTemplates: { 'summarize-document': { text: '{{demo-a1.output}}' } },
              dependsOn: ['demo-a1'],
              priority: 1,
              estimatedDurationMs: 5000,
            },
          ],
          edges: [
            { from: 'demo-a1', to: 'demo-a2', dataMapping: { summary: 'text' } },
          ],
        }),
        tokensUsed: 0,
      };
    }

    return {
      content: JSON.stringify({
        result: '[Demo 演示响应] 当前以 --demo 演示模式运行，LLM 调用返回模拟数据。',
        summary: '这是演示模式的模拟执行结果，用于在没有 API Key 的情况下展示平台全链路。',
        data: { status: 'demo', timestamp: new Date().toISOString() },
      }),
      tokensUsed: 0,
    };
  }
}

function chunkText(s: string, n: number): string[] {
  if (!s) return [];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export const llmClient = new LLMClient();
