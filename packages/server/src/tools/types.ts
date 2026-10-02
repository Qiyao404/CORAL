/**
 * M1-2：Tool 统一抽象 — Skill / MCP / 内置工具三源同构（V2_PLAN §4.1）。
 *
 * agent loop（M1-3）只面向 Tool 接口与 ToolRegistry，不感知工具来源；
 * 权限位 permission 决定执行前是否需要人工审批（审批流程 M1-10/M2-4 接管）。
 */

export type ToolSource = 'skill' | 'mcp' | 'builtin';

/** auto = 直接执行；approval = 需人工审批（D12/D13 的执行档位在工具级落点） */
export type ToolPermission = 'auto' | 'approval';

/** 工具名规范（同时满足 openai function name 与 anthropic tool name 约束） */
export const TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export interface Tool {
  name: string;
  /** 直接进入 function calling 的描述（裁剪到 1024 字符，保护上下文） */
  description: string;
  /** JSON Schema（openai parameters ↔ anthropic input_schema） */
  inputSchema: Record<string, any>;
  source: ToolSource;
  permission: ToolPermission;
  invoke(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * 每次调用的执行上下文（由 M1-3 run-engine 构造）：
 *  · signal — 真取消贯穿（M0-2 语义延伸到工具层）
 *  · workspaceDir — fs 类工具的根边界（未绑定工作区时 fs 工具返回 NO_WORKSPACE）
 *  · emit — 工具层事件出口（M1-3 映射为 tool.call_* 事件入库）
 */
export interface ToolContext {
  runId: string;
  agentId: string;
  signal: AbortSignal;
  workspaceDir?: string;
  emit(ev: { type: string; payload?: Record<string, any> }): void;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  costUsd?: number;
  tokensUsed?: number;
}

export function toolOk<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

export function toolError(code: string, message: string, retryable = false): ToolResult {
  return { ok: false, error: { code, message, retryable } };
}

/** 构造最小可用 ToolContext（测试/默认场景） */
export function makeToolContext(over: Partial<ToolContext> = {}): ToolContext {
  return {
    runId: over.runId ?? 'run-test',
    agentId: over.agentId ?? 'agent-test',
    signal: over.signal ?? new AbortController().signal,
    workspaceDir: over.workspaceDir,
    emit: over.emit ?? (() => {}),
  };
}
