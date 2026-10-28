/**
 * M1-2：Tool 统一抽象 — Skill / MCP / 内置工具三源同构（V2_PLAN §4.1）。
 *
 * agent loop（M1-3）只面向 Tool 接口与 ToolRegistry，不感知工具来源；
 * 权限位 permission 决定执行前是否需要人工审批（审批流程 M1-10/M2-4 接管）。
 */

export type ToolSource = 'skill' | 'mcp' | 'builtin';

/** auto = 直接执行；approval = 需人工审批（D12/D13 的执行档位在工具级落点） */
export type ToolPermission = 'auto' | 'approval';

/** 工具名规范（同时满足 openai function name 与主流 chat API tool name 约束） */
export const TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * 效果声明（能力审计）：工具作者声明"这个工具会对外界做什么"。
 * 审批档位由效果组合推导（derivePermission）— 声明只能让审批更严，不能更松（fail-closed）。
 * 未声明任何效果 = 只读无副作用（最宽松档），因此写类工具必须显式声明。
 */
export interface ToolEffects {
  /** 在用户文件系统（工作区/宿主机）上产生写入/修改/删除；写运行时自身数据目录（记忆/会话状态）不算 */
  writesFilesystem?: boolean;
  /** 启动子进程 / 执行系统命令 */
  launchesProcess?: boolean;
  /** 访问外部网络 */
  accessesNetwork?: boolean;
  /** 执行来源不可控的代码（脚本/公式/模板求值） */
  executesForeignCode?: boolean;
  /** 幂等：同样的输入重复执行结果一致（重试安全） */
  idempotent?: boolean;
}

/**
 * 效果组合 → 审批档位下限。
 * 进程/外部代码恒审批；写文件恒审批（工作区 auto 档的提升是运行时策略，不改下限）。
 */
export function derivePermission(effects?: ToolEffects): ToolPermission {
  if (!effects) return 'auto';
  if (effects.launchesProcess || effects.executesForeignCode || effects.writesFilesystem) return 'approval';
  return 'auto';
}

export interface Tool {
  name: string;
  /** 直接进入 function calling 的描述（裁剪到 1024 字符，保护上下文） */
  description: string;
  /** JSON Schema（openai parameters ↔ 主流 chat API 的 input_schema） */
  inputSchema: Record<string, any>;
  source: ToolSource;
  permission: ToolPermission;
  /** 效果声明：未声明视为只读无副作用；与 permission 冲突时取更严者（注册期强制） */
  effects?: ToolEffects;
  /** 并发安全：可与其他安全工具并行执行（默认 false = 保守串行）。供调度与审计使用 */
  isConcurrencySafe?: boolean;
  /** 结果预算（字符）：超出后完整结果转存证据记录，上下文只留摘要（默认见 kernel/evidence） */
  maxResultSizeChars?: number;
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
