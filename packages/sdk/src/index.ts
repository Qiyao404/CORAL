/**
 * CORAL Agent SDK — 把智能体运行时作为库嵌入（TypeScript 原生，无需起 HTTP 服务）。
 *
 * 两层入口（按嵌入深度选择）：
 *
 *  1) runAgent(input)      —— 无状态单任务。注入 chat 函数与工具，直接跑内核
 *     ReAct 循环（事实门 / 收工门 / 上下文压缩 / 证据记录等纪律层全部生效，
 *     不依赖 SQLite 持久化）。适合把 CORAL 循环嵌进你自己的应用/流水线。
 *
 *  2) createRuntime(opts)  —— 有状态运行时。复用平台三表持久化（run / 事件 /
 *     checkpoint）与文件系统技能注册表，等价于服务端引擎的内嵌形态，
 *     run 可在 Web UI 中回看。数据目录与技能目录取平台配置（支持
 *     DATABASE_PATH / SKILLS_DIR 环境变量覆盖）。
 *
 * 模型接入：SDK 使用方自行提供 OpenAI 兼容的 chat 函数（req → resp），
 * 因此不绑定任何 provider —— 网关、本地模型、测试桩均可。
 */

import { AgentLoop } from '@coral/server';
import type {
  AgentLoopOptions, LoopBudget, LoopEvent, LoopLLM, LoopResult,
  Tool, ToolResult, ChatRequest, ChatResponse,
} from '@coral/server';

// ─── 通用再导出（自定义工具作者直接从 SDK 取类型与工具函数）──────────
export { AgentLoop } from '@coral/server';
export { toolOk, toolError, makeToolContext, derivePermission, TOOL_NAME_REGEX } from '@coral/server';
export type {
  AgentLoopOptions, LoopBudget, LoopEvent, LoopLLM, LoopResult, LoopCheckpoint,
  Tool, ToolResult, ToolContext, ToolEffects, ToolPermission, ToolSource,
  ChatRequest, ChatResponse, ChatMessage, ToolDefinition,
} from '@coral/server';

// ─── 层 1：无状态单任务 ──────────────────────────────────────────────

export interface RunAgentInput {
  /** 任务目标（即用户指令） */
  goal: string;
  /** OpenAI 兼容 chat 调用：SDK 不绑定 provider，网关/本地模型/测试桩皆可 */
  chat: LoopLLM['chat'];
  /** 可用工具集（空 = 纯对话，循环仍生效） */
  tools?: Tool[];
  /** 步数预算（默认 50）与 token 预算（默认 1000 万） */
  maxSteps?: number;
  maxTokens?: number;
  /** 追加系统指令（如业务约束/角色设定） */
  extraSystem?: string;
  /** 内核事件流回调（工具调用 / 门禁打回 / todo / 证据记录等） */
  onEvent?: (e: LoopEvent) => void;
  /** 取消信号 */
  signal?: AbortSignal;
}

/** 跑一个无状态 agent 任务：门禁/压缩/证据等内核纪律层全部生效 */
export async function runAgent(input: RunAgentInput): Promise<LoopResult> {
  const budget: LoopBudget = {
    maxSteps: input.maxSteps ?? 50,
    maxTokens: input.maxTokens ?? 10_000_000,
  };
  const loop = new AgentLoop(
    { chat: input.chat },
    {
      runId: `sdk_${Date.now().toString(36)}`,
      agentId: 'main',
      goal: input.goal,
      tools: input.tools ?? [],
      budget,
      signal: input.signal ?? new AbortController().signal,
      onEvent: input.onEvent ?? (() => {}),
      ...(input.extraSystem ? { extraSystem: input.extraSystem } : {}),
    } satisfies AgentLoopOptions
  );
  return loop.run();
}

// ─── 层 2：有状态运行时（平台持久化 + 技能注册表）────────────────────

/** RunEngine 对 llm 的完整要求：chat（循环）+ complete（提示词优化等辅助调用） */
export interface EngineLlm extends LoopLLM {
  complete(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, options?: any): Promise<{ content: string }>;
}

/** chat → EngineLlm：complete 由 chat 推导（无工具、无流式的朴素补全） */
export function toEngineLlm(chat: LoopLLM['chat']): EngineLlm {
  return {
    chat,
    complete: async (messages, options) => {
      const req: ChatRequest = {
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        ...(options?.maxTokens ? { maxTokens: options.maxTokens } : {}),
      };
      const res: ChatResponse = await chat(req);
      return { content: res.content };
    },
  };
}

export interface RuntimeOptions {
  /** 模型接入（chat 必需；或直接传 toEngineLlm 产物） */
  llm: EngineLlm;
  /** 技能目录（默认平台 skills/ — SKILLS_DIR 可覆盖） */
  skillsDir?: string;
}

export interface CoralRuntime {
  /** 发起一个 run（异步执行；返回 runId 供事件流订阅/取消） */
  startRun(input: { goal: string; sessionId?: string; extraSystem?: string; budget?: { maxSteps?: number; maxTokens?: number } }): { runId: string; sessionId?: string };
  /** 取消 run */
  cancelRun(runId: string): { ok: boolean; message: string };
  /** 引擎实例（三表查询 / checkpoint / Time-Travel 等完整能力） */
  engine: import('@coral/server').RunEngine;
  /** 关闭持久化句柄（进程退出前调用） */
  dispose(): Promise<void>;
}

/**
 * 构建内嵌运行时：SQLite 三表持久化 + 文件系统技能注册表 + 完整 RunEngine。
 * run 记录可直接被 Web UI 回看（与平台服务共用数据目录时）。
 */
export async function createRuntime(opts: RuntimeOptions): Promise<CoralRuntime> {
  const embedded = await import('@coral/server');
  const skillsDir = opts.skillsDir ?? embedded.platformConfig.skillsDir;

  const registry = new embedded.FilesystemSkillRegistry(skillsDir);
  await registry.reloadAll();
  const executor = new embedded.SkillExecutor(registry);

  const engine = new embedded.RunEngine({
    llm: opts.llm,
    skillRegistry: registry,
    skillExecutor: executor,
    runStore: new embedded.RunStore(),
    eventStore: new embedded.RunEventStore(),
    checkpointStore: new embedded.CheckpointStore(),
  });

  return {
    engine,
    startRun: input => engine.startRun(input),
    cancelRun: runId => engine.cancelRun(runId),
    dispose: async () => {
      const { closeDb } = await import('@coral/server');
      closeDb();
    },
  };
}
