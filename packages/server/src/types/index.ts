// CORAL 平台核心类型定义 — v1.1.0

export type TaskStatus =
  | 'created'
  | 'planning'
  | 'executing'
  | 'waiting_human'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentStatus =
  | 'pending'
  | 'running'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ExecutionMode = 'llm_only' | 'script' | 'hybrid';
export type CostLevel = 'low' | 'medium' | 'high';
export type SkillStatus = 'experimental' | 'stable' | 'deprecated';
export type ScriptRuntime = 'python3' | 'node' | 'deno' | 'bash' | 'py';
export type SkillSource = 'builtin' | 'user';

export interface Task {
  taskId: string;
  userId: string;
  goal: string;
  constraints?: Record<string, any>;
  status: TaskStatus;
  currentPlanId?: string;
  result?: Record<string, any>;
  error?: Record<string, any>;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ExecutionPlan {
  planId: string;
  taskId: string;
  version: number;
  agents: PlannedAgent[];
  edges: DependencyEdge[];
  estimatedDurationMs?: number;
  plannerModel?: string;
  plannerReasoning?: string;
  createdAt: string;
}

export interface PlannedAgent {
  agentId: string;
  name: string;
  role: string;
  assignedSkills: string[];
  skillInputTemplates: Record<string, any>;
  dependsOn: string[];
  priority: number;
  estimatedDurationMs: number;
}

export interface DependencyEdge {
  from: string;
  to: string;
  dataMapping?: Record<string, string>;
}

export interface AgentInstance {
  agentId: string;
  taskId: string;
  planId: string;
  name: string;
  role: string;
  status: AgentStatus;
  assignedSkills: string[];
  skillResults: Record<string, SkillExecutionResult>;
  dependsOn: string[];
  output?: Record<string, any>;
  error?: { code: string; message: string; retryable: boolean };
  retryCount: number;
  maxRetries: number;
  timeoutMs: number;
  suspendReason?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  suspendedAt?: string;
}

export interface SkillExecutionResult {
  success: boolean;
  data?: Record<string, any>;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    stack?: string;
  };
  artifacts?: Array<{
    type: 'text' | 'json' | 'file' | 'markdown';
    name: string;
    value: any;
  }>;
  meta: {
    durationMs: number;
    tokensUsed?: number;
    skillVersion: string;
    executionMode: string;
    sandboxUsed: boolean;
  };
}

export interface SkillExecutionRequest {
  skillName: string;
  input: Record<string, any>;
  context: SkillExecutionContext;
}

export interface SkillExecutionContext {
  taskId: string;
  agentId: string;
  userId?: string;
  sessionId?: string;
  abortSignal?: AbortSignal;
  /** 任务级公司画像覆盖（深合并优先级高于全局） */
  companyProfileOverride?: Partial<CompanyProfile>;
}

export interface ParsedSkillManifest {
  name: string;
  version: string;
  description: string;
  domain: string;
  capabilities: string[];
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
  executionMode: ExecutionMode;
  scriptEntry?: string;
  scriptRuntime?: ScriptRuntime;
  scriptTimeoutMs?: number;
  humanGate: boolean;
  estimatedDurationMs: number;
  costLevel: CostLevel;
  status: SkillStatus;
  tags: string[];
  skillDirPath: string;
  promptContent: string;
  referenceContent?: string;
  loadedAt: string;
  fileHash: string;
  /** v1.1.0 新增 */
  source: SkillSource;
  createdBy?: string;
  creatorSessionId?: string;
  consumesCompanyProfile?: boolean;
  emptyWhen?: Array<{ field: string; op: 'eq' | 'neq' | 'lt' | 'gt'; value: any }>;
  defaultInput?: Record<string, any>;
  inputKeys?: string[];
}

export type CoralEventType =
  | 'task.created' | 'task.planning' | 'task.plan_ready'
  | 'task.executing' | 'task.completed' | 'task.failed' | 'task.cancelled'
  | 'agent.spawned' | 'agent.started' | 'agent.suspended'
  | 'agent.resumed' | 'agent.completed' | 'agent.failed' | 'agent.cancelled'
  | 'skill.executing' | 'skill.completed' | 'skill.failed'
  | 'skill.sandbox_started' | 'skill.sandbox_finished'
  | 'human_gate.waiting' | 'human_gate.approved'
  | 'human_gate.rejected' | 'human_gate.timeout'
  | 'skill.registered' | 'skill.updated' | 'skill.removed' | 'skill.reload_failed'
  | 'system.error' | 'system.warning'
  /** v1.1.0 新增：进度事件三件套 */
  | 'skill.progress' | 'skill.log' | 'skill.artifact'
  /** v1.1.0 新增：Skill Builder 多轮对话生命周期 */
  | 'skill_builder.session_started' | 'skill_builder.message'
  | 'skill_builder.draft_updated' | 'skill_builder.committed'
  | 'skill_builder.failed'
  /** v1.1.0 新增：公司画像变更 */
  | 'company_profile.updated'
  /** M1-5（§4.4 v2 事件）：run 生命周期 */
  | 'run.created' | 'run.started' | 'run.completed' | 'run.failed'
  | 'run.cancelled' | 'run.budget_exceeded'
  /** M1-3：agent loop */
  | 'loop.step_started' | 'loop.step_completed' | 'loop.context_compressed'
  | 'loop.cancelled' | 'loop.failed' | 'loop.delta' | 'loop.llm_degraded'
  /** M1-2/M1-3：工具调用与 D19 */
  | 'tool.call_started' | 'tool.call_completed' | 'tool.call_failed'
  | 'todo.updated' | 'checkpoint.created'
  /** M1-4：sub-agent 生命周期 */
  | 'subagent.started' | 'subagent.completed' | 'subagent.failed'
  /** M1-10（D11-D14）：工作区审批流 */
  | 'tool.approval_required' | 'tool.approval_resolved'
  /** M1-3：工具结果预览（事件流） */
  | 'tool.result_preview'
  /** M1-11（D18）：记忆整理 */
  | 'memory.distilled';

export interface CoralEvent {
  eventId: string;
  type: CoralEventType;
  taskId?: string;
  agentId?: string;
  skillName?: string;
  payload: Record<string, any>;
  timestamp: string;
}

export interface PlatformConfig {
  port: number;
  host: string;
  /** M0-6：CORS 白名单（默认 Vite dev 源；可用 CORS_ALLOWED_ORIGINS 扩展） */
  corsAllowedOrigins: string[];
  databasePath: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmProfileName: string;
  /** M0-4：LLM 传输层重试（网络/429/5xx），不含首次尝试 */
  llmMaxRetries: number;
  llmRetryBaseDelayMs: number;
  /** M0-5：显式演示模式（--demo 启动参数或 CORAL_DEMO_MODE=1），LLM 返回带标记的模拟数据 */
  demoMode: boolean;
  /** M1-2（D13）：shell_run 工具开关 — 默认关闭，SHELL_TOOL_ENABLED=true 显式开启 */
  shellToolEnabled: boolean;
  /** M1-5：Free 模式 run 预算默认值（请求级可覆盖，硬上限见 run-engine） */
  runMaxSteps: number;
  runMaxTokens: number;
  /** M1-11（D18）：记忆目录与「会话结束记忆整理」开关（demo 模式始终跳过整理） */
  memoryDir: string;
  memoryDistillEnabled: boolean;
  skillsDir: string;
  scenarioPacksDir: string;
  skillWatcherDebounceMs: number;
  skillDefaultTimeoutMs: number;
  sandboxMode: 'process' | 'docker';
  sandboxTimeoutMs: number;
  sandboxMemoryLimitMb: number;
  sandboxNetworkEnabled: boolean;
  maxConcurrentTasks: number;
  maxConcurrentAgentsPerTask: number;
  agentDefaultTimeoutMs: number;
  agentMaxRetries: number;
  humanGateTimeoutMs: number;
  humanGateAutoReject: boolean;
}

export interface LLMConfigProfile {
  profileId: string;
  name: string;
  /** M1-1（D9）：接入协议 — openai 兼容端点 或 anthropic 原生 */
  provider: 'openai-compat' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── v1.1.0 新增 ───────────────────────────────────────

/** 进度事件 payload（与脚本 [CORAL_PROGRESS] 协议对应）*/
export interface SkillProgressPayload {
  taskId: string;
  agentId: string;
  skillName: string;
  phase: string;
  step?: number;
  total?: number;
  percent?: number;
  message: string;
  detail?: Record<string, any>;
}

/** 日志事件 payload */
export interface SkillLogPayload {
  taskId: string;
  agentId: string;
  skillName: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source: 'stdout' | 'stderr' | 'llm_stream';
}

/** 产物事件 payload */
export interface SkillArtifactPayload {
  taskId: string;
  agentId: string;
  skillName: string;
  artifact: {
    type: 'markdown' | 'csv' | 'json' | 'file' | 'text';
    name: string;
    path?: string;
    sizeBytes?: number;
    preview?: string;
  };
}

/** Skill Builder 会话 */
export interface SkillBuilderSession {
  sessionId: string;
  userId: string;
  status: 'collecting' | 'previewing' | 'committed' | 'cancelled';
  conversation: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
  }>;
  draft: Partial<ParsedSkillManifest> & {
    promptContent?: string;
    referenceContent?: string;
    scriptContent?: string;
  };
  draftFilledFields: string[];
  pendingFields: string[];
  createdAt: string;
  updatedAt: string;
  committedSkillName?: string;
  testResult?: {
    success: boolean;
    durationMs: number;
    output?: any;
    error?: string;
  };
}

/** 公司业务画像（FR-G）*/
export interface CompanyProfile {
  version: number;
  companyName: string;
  industries: string[];
  coreBusinesses: string[];
  focusKeywords: string[];
  excludeKeywords: string[];
  policyTypes: {
    keep: string[];
    exclude: string[];
  };
  description: string;
  updatedAt: string;
}

/** information-filter 用：归一化条目（FR-H）*/
export interface FilterableItem {
  index: number;
  title: string;
  date?: string;
  source?: string;
  url?: string;
  excerpt: string;
  raw?: any;
}
