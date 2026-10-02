/**
 * M1-1：ChatProvider 统一接口 — 所有 LLM 接入的规范层。
 *
 * 上层（agent-loop / skill llm 路径 / skill-builder）只面向本文件类型，
 * 不感知 openai / anthropic 的报文差异。工具调用、usage、停止原因在两个
 * provider 间语义对齐。
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** 模型发起的一次工具调用（openai tool_calls ↔ anthropic tool_use 的归一） */
export interface ToolCall {
  /** 调用 id（回传工具结果时配对用） */
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** assistant 消息携带的工具调用请求（可多个） */
  toolCalls?: ToolCall[];
  /** role=tool：对应的调用 id */
  toolCallId?: string;
  /** role=tool：工具名（日志/展示用） */
  toolName?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema（openai parameters ↔ anthropic input_schema） */
  inputSchema: Record<string, any>;
}

export type StopReason =
  | 'end'        // 模型给出最终回答
  | 'tool_use'   // 模型请求调用工具（toolCalls 非空）
  | 'max_tokens' // 输出被 max_tokens 截断
  | 'other';

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** 系统提示（与 messages 中的 system 角色二选一，provider 会合并） */
  system?: string;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** 要求模型输出合法 JSON（openai: response_format; anthropic: 系统指令增强） */
  jsonMode?: boolean;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: ChatUsage;
  stopReason: StopReason;
}

export interface ChatProvider {
  readonly id: ProviderId;
  /** 非流式补全 — agent loop 主路径（工具调用在此返回） */
  complete(req: ChatRequest): Promise<ChatResponse>;
  /** 文本流式 — skill llm_only 路径（onChunk 实时收增量；返回值含完整结果） */
  stream(req: ChatRequest, onChunk: (delta: string) => void): Promise<ChatResponse>;
}

export type ProviderId = 'openai-compat' | 'anthropic';

export interface ProviderConfig {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** D15：Anthropic prompt caching 默认开启（system+工具定义打 cache_control） */
  promptCaching?: boolean;
  /** 测试注入（生产不传） */
  clientOverride?: any;
}

export function normalizeProviderId(raw: string | undefined | null): ProviderId {
  return raw === 'anthropic' ? 'anthropic' : 'openai-compat';
}

export function emptyUsage(): ChatUsage {
  return { inputTokens: 0, outputTokens: 0 };
}
