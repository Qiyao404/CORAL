/**
 * 嵌入面（SDK 公共出口）：把运行时内核作为库暴露给外部程序。
 *
 * 该模块只做 re-export —— 可安全 import（不像 src/index.ts 会拉起 HTTP 服务）。
 * 供 @coral/sdk 与外部嵌入方使用；新增导出请保持"纯声明 + 实例类"，不放启动逻辑。
 */

export { AgentLoop } from './kernel/agent-loop.js';
export type { AgentLoopOptions, LoopResult, LoopBudget, LoopEvent, LoopLLM, LoopCheckpoint } from './kernel/agent-loop.js';

export { toolOk, toolError, makeToolContext, derivePermission, TOOL_NAME_REGEX } from './tools/types.js';
export type { Tool, ToolResult, ToolContext, ToolEffects, ToolPermission, ToolSource } from './tools/types.js';

export { RunEngine } from './kernel/run-engine.js';
export type { RunEngineDeps, StartRunInput } from './kernel/run-engine.js';

export { FilesystemSkillRegistry } from './skill-runtime/filesystem-registry.js';
export { SkillExecutor } from './skill-runtime/skill-executor.js';

export { RunStore } from './store/run-store.js';
export { RunEventStore } from './store/run-event-store.js';
export { CheckpointStore } from './store/checkpoint-store.js';

export { platformConfig, PROJECT_ROOT } from './services/config.js';
export { closeDb } from './store/db.js';

export type { ChatRequest, ChatResponse, ChatMessage, ToolDefinition } from './providers/types.js';
