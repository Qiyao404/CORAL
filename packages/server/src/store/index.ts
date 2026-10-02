// CORAL 持久化层（M0-1：JSON 文件 → SQLite）
// 五个仓储替换 v1 的 JsonStore 实例；导出名与 v1 persistence/store.ts 对齐，
// 消费方仅需把 import 路径从 '../persistence/store.js' 改为 '../store/index.js'。
import { SqliteStore } from './sqlite-store.js';
import { AuditEventStore } from './audit-store.js';
import { LlmProfileStore } from './llm-profile-store.js';
import type { Task, ExecutionPlan, AgentInstance, LLMConfigProfile } from '../types/index.js';

export const taskStore = new SqliteStore<Task>('tasks', 'taskId');
export const planStore = new SqliteStore<ExecutionPlan>('plans', 'planId');
export const agentStore = new SqliteStore<AgentInstance>('agents', 'agentId');
export const auditStore = new AuditEventStore();
export const llmConfigStore = new LlmProfileStore();

export { getDb, closeDb, createDb } from './db.js';
export type { DB } from './db.js';
