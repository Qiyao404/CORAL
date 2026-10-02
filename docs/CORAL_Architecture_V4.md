# CORAL — 系统架构设计文档 V4

> **版本：V4.0** | 日期：2026-04-02 | 状态：架构定稿  
> **定位：通用、并发、基于文件系统 Skill 标准的智能体运行底座（Agent + Skills Runtime Platform）**

---

## 0. 文档信息

| 字段     | 内容                                                                             |
| -------- | -------------------------------------------------------------------------------- |
| 文档名称 | CORAL — 系统架构设计文档 V4                                                      |
| 适用范围 | 平台内核研发、技术架构评审、质量验收                                               |
| 核心定位 | 不含任何业务场景硬编码；公文、政策、合同等均为外部 Scenario Pack                   |
| 前置依赖 | CORAL_PRD_Core.md（平台底座需求）                                                 |

---

## 1. 架构设计总纲

### 1.1 第一性原则

CORAL 是一个 **"接收自然语言目标 → 规划执行计划 → 并发调度多 Agent → 执行标准化 Skill → 输出可审计结果"** 的通用运行时引擎。

| 原则                         | 说明                                                                       |
| ---------------------------- | -------------------------------------------------------------------------- |
| **文件系统即注册表**          | Skill 不存数据库，以磁盘目录 `skills/<name>/SKILL.md` 为唯一元数据来源      |
| **Markdown 即配置**          | `SKILL.md` 的 YAML Frontmatter 声明元数据，正文即 System Prompt             |
| **DAG 原生并发**             | 任务拆解为有向无环图（DAG），无依赖节点真并行                                 |
| **沙箱隔离执行**             | 外部脚本在独立进程/容器中运行，通过 stdin/stdout JSON 通信                   |
| **场景零耦合**               | 平台内核不含任何业务域关键词，场景以 Scenario Pack 插件形态存在                |
| **热重载免重启**             | 文件系统变更触发 Skill 注册表自动更新，新 Skill 即时可用                     |

### 1.2 分层架构总览

```
┌────────────────────────────────────────────────────────────────────────┐
│                    Layer 1: Access Layer（接入层）                       │
│  Web Dashboard / REST API / WebSocket / SDK / Webhook / CLI           │
└───────────────────────────────┬────────────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────────────┐
│              Layer 2: Task Gateway（任务网关层）                          │
│  POST /tasks  │  GET /tasks/:id  │  WS /events  │  POST /chat        │
│  任务验证 · 限流 · 鉴权 · 路由分发                                        │
└───────────────────────────────┬────────────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────────────┐
│           Layer 3: Planning Engine（规划引擎层）                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐         │
│  │ Goal Parser  │→ │ Skill Matcher│→ │ DAG Plan Builder     │         │
│  └──────────────┘  └──────────────┘  └──────────────────────┘         │
│                          │                                             │
│                 ┌────────▼────────┐                                    │
│                 │ Execution Plan  │  (DAG: agents + edges)             │
│                 │ + Fast Path     │                                    │
│                 └────────┬────────┘                                    │
└──────────────────────────┼─────────────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────────────┐
│         Layer 4: DAG Scheduler（并发调度层）                              │
│  ┌──────────────────────────────────────────────────────────┐          │
│  │                    Worker Pool                            │          │
│  │  Agent-A(running)  Agent-B(running)  Agent-C(suspended)  │          │
│  │  ─────────────── Dependency Graph ─────────────────────  │          │
│  └──────────────────────────────────────────────────────────┘          │
│  ┌──────────────────────────────────────────────────────────┐          │
│  │              Event Bus（进程内事件总线）                     │          │
│  │  task.* │ agent.* │ skill.* │ human_gate.* │ sandbox.*   │          │
│  └──────────────────────────────────────────────────────────┘          │
│  ┌──────────────────────────────────────────────────────────┐          │
│  │              Human Gate（人工审批关卡）                      │          │
│  │  approve / reject / revise / timeout_auto_reject         │          │
│  └──────────────────────────────────────────────────────────┘          │
└───────────────────────────────┬────────────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────────────┐
│     Layer 5: Skill Runtime（技能运行层）                                  │
│  ┌────────────────────────────────────────────────────────────┐        │
│  │ Filesystem Skill Registry（文件系统注册表）                    │        │
│  │  chokidar watcher → hot reload → in-memory manifest cache  │        │
│  └────────────────────────────────────────────────────────────┘        │
│  ┌────────────────────────────────────────────────────────────┐        │
│  │ Skill Resolver & Executor                                   │        │
│  │  parse SKILL.md → extract frontmatter + prompt              │        │
│  │  LLM-only skill: prompt + reference.md → LLM call           │        │
│  │  Script skill: spawn sandbox → stdin JSON → stdout JSON     │        │
│  └────────────────────────────────────────────────────────────┘        │
│  ┌────────────────────────────────────────────────────────────┐        │
│  │ Script Sandbox（脚本沙箱）                                    │        │
│  │  子进程隔离 / Docker 容器 / WASM（可选）                        │        │
│  │  网络白名单 · 文件系统挂载限制 · 资源配额 · 超时强杀              │        │
│  └────────────────────────────────────────────────────────────┘        │
└───────────────────────────────┬────────────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────────────┐
│        Layer 6: Shared Services（共享服务层）                             │
│  LLM Client · Prompt Renderer · Memory Store                          │
│  Audit Logger · Cost Tracker · Config Manager                         │
└───────────────────────────────┬────────────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────────────┐
│       Layer 7: Persistence & Infra（持久化与基础设施层）                   │
│  PostgreSQL（Tasks, Agents, ExecutionPlans, AuditLogs）                │
│  Local FS / Object Storage（skills/, scenario-packs/, artifacts/）    │
│  Redis（可选：限流、缓存、Pub/Sub）                                      │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心子系统一：文件系统 Skill 注册表

### 2.1 Skill 目录规范

每个 Skill 是 `skills/` 下的一个独立文件夹，文件夹名即 Skill 的唯一标识符：

```
skills/
├── extract-table-from-url/
│   ├── SKILL.md              # 核心定义（必需）
│   ├── reference.md          # 参考资料 / RAG 知识（可选）
│   └── scripts/              # 可执行脚本（可选）
│       ├── execute.py        # 主入口（语言不限）
│       └── requirements.txt  # 脚本依赖声明
│
├── summarize-document/
│   ├── SKILL.md              # 纯 LLM Skill，无 scripts/
│   └── reference.md
│
└── .skill-creator/           # 内置 Meta-Skill
    ├── SKILL.md
    └── scripts/
        └── generate.ts
```

### 2.2 SKILL.md 解析规范

`SKILL.md` 由两部分构成：YAML Frontmatter（元数据）+ Markdown Body（Prompt）。

```markdown
---
name: extract-table-from-url
version: "1.0.0"
description: "从指定 URL 页面中提取表格数据，输出结构化 JSON"
domain: data-extraction
capabilities:
  - web_scraping
  - table_extraction
  - html_parsing

input_schema:
  type: object
  required: [url]
  properties:
    url:
      type: string
      description: "目标页面 URL"
    selector:
      type: string
      description: "CSS 选择器（可选，不填则自动检测）"

output_schema:
  type: object
  properties:
    tables:
      type: array
      items:
        type: object
        properties:
          headers: { type: array, items: { type: string } }
          rows: { type: array, items: { type: array } }

execution_mode: script          # "llm_only" | "script" | "hybrid"
script_entry: scripts/execute.py
script_runtime: python3         # python3 | node | deno | bash
script_timeout_ms: 30000

human_gate: false
estimated_duration_ms: 10000
cost_level: low                 # low | medium | high
status: stable                  # experimental | stable | deprecated
tags: [scraping, table, json]
---

# extract-table-from-url

你是一个网页表格提取专家。当用户提供 URL 时，你需要：

1. 访问该 URL 并解析 HTML 内容
2. 识别页面中的所有 `<table>` 元素
3. 将每个表格转换为结构化 JSON（含表头和行数据）
4. 如果提供了 CSS 选择器，仅提取匹配的表格

## 输出要求
- 输出纯 JSON，不要包含 Markdown 代码块标记
- 空单元格用空字符串表示
- 合并单元格需展开为独立单元格
```

### 2.3 运行时解析流程

```
                    ┌──────────────────────────┐
                    │  skills/<name>/SKILL.md   │
                    └────────────┬─────────────┘
                                 │
                         ┌───────▼───────┐
                         │  gray-matter   │  解析 YAML Frontmatter
                         │  (npm 包)      │
                         └───┬───────┬───┘
                             │       │
                    ┌────────▼┐  ┌───▼────────┐
                    │ metadata │  │  prompt     │
                    │ (注册表) │  │  (正文)      │
                    └────────┬┘  └───┬────────┘
                             │       │
              ┌──────────────▼───────▼──────────────┐
              │        Skill Resolver 决策           │
              │                                      │
              │  execution_mode == "llm_only"?       │
              │    → 组装 prompt + reference.md       │
              │    → 调用 LLM Client                  │
              │                                      │
              │  execution_mode == "script"?          │
              │    → 启动 Sandbox                     │
              │    → stdin 写入 JSON(input)           │
              │    → stdout 读取 JSON(output)         │
              │                                      │
              │  execution_mode == "hybrid"?          │
              │    → 先 LLM 预处理                    │
              │    → 再 Sandbox 执行脚本              │
              │    → LLM 后处理                       │
              └─────────────────────────────────────┘
```

### 2.4 文件系统监控与热重载

```typescript
interface SkillWatcher {
  watchDir: string;               // "skills/"
  engine: "chokidar";
  events: {
    onSkillAdded(skillDir: string): void;
    onSkillChanged(skillDir: string): void;
    onSkillRemoved(skillDir: string): void;
  };
  debounceMs: number;             // 300ms 防抖
  validateBeforeReload: boolean;  // 热加载前校验 SKILL.md 合法性
}
```

**热重载流程**：

1. `chokidar` 监控 `skills/` 目录的 `add`/`change`/`unlink` 事件。
2. 事件触发后经 300ms 防抖合并。
3. 读取变更的 `SKILL.md` 文件，使用 `gray-matter` 解析 Frontmatter。
4. 校验 `input_schema`/`output_schema` 的 JSON Schema 合法性。
5. 校验通过 → 更新内存中的 `SkillRegistryCache`；校验失败 → 写入 `EventBus`(`skill.reload_failed`) + 审计日志。
6. 如果 Skill 从文件系统被物理删除 → 从内存注册表移除（不影响正在执行中的实例）。

### 2.5 内存注册表数据结构

```typescript
interface ParsedSkillManifest {
  name: string;
  version: string;
  description: string;
  domain: string;
  capabilities: string[];
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  executionMode: "llm_only" | "script" | "hybrid";
  scriptEntry?: string;
  scriptRuntime?: "python3" | "node" | "deno" | "bash";
  scriptTimeoutMs?: number;
  humanGate: boolean;
  estimatedDurationMs: number;
  costLevel: "low" | "medium" | "high";
  status: "experimental" | "stable" | "deprecated";
  tags: string[];

  // 运行时自动填充
  skillDirPath: string;           // 绝对路径
  promptContent: string;          // SKILL.md 正文
  referenceContent?: string;      // reference.md 正文
  loadedAt: Date;                 // 加载时间戳
  fileHash: string;               // SKILL.md 内容 SHA256
}

class FilesystemSkillRegistry {
  private cache: Map<string, ParsedSkillManifest>;
  private watcher: FSWatcher;

  getByName(name: string): ParsedSkillManifest | null;
  findByDomain(domain: string): ParsedSkillManifest[];
  findByCapabilities(caps: string[]): ParsedSkillManifest[];
  listAvailable(): ParsedSkillManifest[];
  listAll(): ParsedSkillManifest[];         // 含 deprecated
  getPromptAndReference(name: string): { prompt: string; reference?: string };
  reloadSkill(name: string): Promise<void>;
  reloadAll(): Promise<void>;
  startWatching(): void;
  stopWatching(): void;
}
```

---

## 3. 核心子系统二：Skill 执行引擎

### 3.1 执行器总体设计

```typescript
interface SkillExecutionRequest {
  skillName: string;
  input: Record<string, any>;
  context: SkillExecutionContext;
}

interface SkillExecutionContext {
  taskId: string;
  agentId: string;
  userId?: string;
  sessionId?: string;
  llmClient: LLMClient;
  eventBus: EventBus;
  abortSignal?: AbortSignal;
  config: PlatformConfig;
}

interface SkillExecutionResult {
  success: boolean;
  data?: Record<string, any>;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    stack?: string;
  };
  artifacts?: Array<{
    type: "text" | "json" | "file" | "markdown";
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
```

### 3.2 LLM-Only 执行路径

当 `execution_mode == "llm_only"` 时：

```
1. 从注册表获取 prompt + reference
2. 使用 Prompt Renderer 拼装完整 System Prompt:
   ┌─────────────────────────────────────────┐
   │ [System]                                │
   │ {SKILL.md 正文 prompt}                   │
   │                                         │
   │ ## 参考资料                               │
   │ {reference.md 内容（如有）}               │
   │                                         │
   │ ## 输入数据                               │
   │ ```json                                 │
   │ {序列化的 input}                         │
   │ ```                                     │
   │                                         │
   │ ## 输出格式要求                            │
   │ 严格按照以下 JSON Schema 输出：            │
   │ {output_schema}                         │
   └─────────────────────────────────────────┘
3. 调用 LLM Client (complete / stream)
4. 解析 LLM 返回，校验是否符合 output_schema
5. 校验失败 → 重试（最多 2 次，附带校验错误提示）
6. 包装为 SkillExecutionResult 返回
```

### 3.3 Script 执行路径 — 沙箱隔离

当 `execution_mode == "script"` 时：

```
1. 确定 runtime: python3 / node / deno / bash
2. 构建沙箱执行环境:
   ├── 工作目录: skills/<name>/scripts/
   ├── 入口文件: script_entry 字段指定
   ├── 超时: script_timeout_ms（强杀）
   ├── 环境变量: 仅注入白名单变量（不含 API Key 等敏感信息）
   └── 网络: 可配置白名单域名
3. 通过子进程 spawn 执行:
   stdin  ← JSON.stringify({ input, context_metadata })
   stdout → JSON.parse() → SkillExecutionResult.data
   stderr → 日志收集
4. 进程退出码 != 0 → 标记失败，stderr 写入 error
5. 超时未退出 → SIGTERM → 等待 5s → SIGKILL
```

### 3.4 沙箱安全模型

```
┌─────────────────────────────────────────────────────────┐
│                  Sandbox Security Model                   │
├─────────────────────────────────────────────────────────┤
│ Level 1: 子进程隔离（默认）                                │
│   - child_process.spawn with {cwd, env, timeout}        │
│   - UID/GID 降权（Linux）                                │
│   - stdio: ['pipe', 'pipe', 'pipe']                     │
│   - 无 shell: true                                      │
├─────────────────────────────────────────────────────────┤
│ Level 2: Docker 容器隔离（生产推荐）                        │
│   - 预构建镜像: coral-sandbox-python, coral-sandbox-node │
│   - --network=none 或 --network=allowlist               │
│   - --read-only --tmpfs /tmp:size=100m                  │
│   - --memory=256m --cpus=1                              │
│   - Volume mount: skills/<name>/scripts/ → /workspace   │
│   - stdin/stdout 通过 docker exec -i                     │
├─────────────────────────────────────────────────────────┤
│ Level 3: WASM 沙箱（实验性，远期）                          │
│   - 使用 Wasmtime/Wasmer 运行编译后的 WASM 模块            │
│   - 零网络、零文件系统                                     │
│   - 适用于纯计算类 Skill                                  │
└─────────────────────────────────────────────────────────┘
```

### 3.5 Hybrid 执行路径

当 `execution_mode == "hybrid"` 时，执行分三阶段：

```
Phase A: LLM Pre-processing
  → 使用 SKILL.md prompt 对用户输入做理解/增强/预处理
  → 输出结构化中间 JSON

Phase B: Script Execution
  → 将 Phase A 输出作为 stdin 传入 sandbox
  → 脚本执行具体逻辑（爬取、计算、文件处理等）
  → 输出原始结果 JSON

Phase C: LLM Post-processing
  → 使用 SKILL.md 中的后处理指令对 Phase B 结果做总结/格式化
  → 输出最终 SkillExecutionResult
```

---

## 4. 核心子系统三：DAG 调度引擎

### 4.1 核心实体

```typescript
// ──────── Task：用户提交的顶层工作单元 ────────
interface Task {
  taskId: string;                  // nanoid
  userId: string;
  goal: string;                    // 自然语言目标
  constraints?: Record<string, any>;
  status: TaskStatus;
  planId?: string;                 // 关联 ExecutionPlan
  result?: TaskResult;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

type TaskStatus =
  | "created"
  | "planning"
  | "executing"
  | "waiting_human"
  | "completed"
  | "failed"
  | "cancelled";

// ──────── ExecutionPlan：DAG 执行计划 ────────
interface ExecutionPlan {
  planId: string;                  // nanoid
  taskId: string;
  version: number;                 // 重规划时递增
  agents: PlannedAgent[];
  edges: DependencyEdge[];
  estimatedDurationMs: number;
  plannerModel: string;
  plannerReasoning: string;        // LLM 规划思路
  createdAt: Date;
}

interface PlannedAgent {
  agentId: string;                 // nanoid
  name: string;                    // 人类可读名称
  role: string;                    // 角色描述
  assignedSkills: string[];        // Skill name 列表
  skillInputTemplates: Record<string, any>;
  dependsOn: string[];             // 依赖的 agentId
  priority: number;                // 0 = 最高优先级
  estimatedDurationMs: number;
}

interface DependencyEdge {
  from: string;                    // agentId
  to: string;                      // agentId
  dataMapping?: Record<string, string>;  // 上游 output key → 下游 input key
}

// ──────── AgentInstance：运行时 Agent 实例 ────────
interface AgentInstance {
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
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  suspendedAt?: Date;
  suspendReason?: string;
}

type AgentStatus =
  | "pending"
  | "running"
  | "suspended"
  | "completed"
  | "failed"
  | "cancelled";
```

### 4.2 DAG Scheduler 核心算法

```typescript
class DAGScheduler {
  private workerPool: Map<string, AgentRunner>;
  private eventBus: EventBus;
  private maxConcurrency: number;

  async execute(plan: ExecutionPlan, ctx: TaskContext): Promise<TaskResult> {
    const agents = this.initializeAgents(plan);
    const inDegree = this.computeInDegree(plan.edges, agents);
    const readyQueue: PriorityQueue<AgentInstance> = new PriorityQueue();

    // 将入度为 0 的节点入队
    for (const agent of agents) {
      if (inDegree.get(agent.agentId) === 0) {
        readyQueue.enqueue(agent, agent.priority);
      }
    }

    const running = new Set<string>();
    const completed = new Map<string, AgentInstance>();

    while (readyQueue.size() > 0 || running.size > 0) {
      // 并发启动：受 maxConcurrency 限制
      while (readyQueue.size() > 0 && running.size < this.maxConcurrency) {
        const agent = readyQueue.dequeue()!;
        running.add(agent.agentId);

        this.runAgent(agent, completed, ctx).then(result => {
          running.delete(agent.agentId);
          completed.set(agent.agentId, result);

          // 更新后继节点入度
          for (const edge of plan.edges) {
            if (edge.from === agent.agentId) {
              const newDegree = inDegree.get(edge.to)! - 1;
              inDegree.set(edge.to, newDegree);
              if (newDegree === 0) {
                const successor = agents.find(a => a.agentId === edge.to)!;
                // 注入上游数据
                this.injectUpstreamData(successor, edge, result);
                readyQueue.enqueue(successor, successor.priority);
              }
            }
          }
        });
      }

      // 等待任一 Agent 完成
      await this.waitForAny(running);
    }

    return this.aggregateResults(completed);
  }
}
```

### 4.3 Agent 生命周期状态机

```
                          ┌───────────┐
                          │  pending   │
                          └─────┬─────┘
                                │ 依赖全部满足 + 资源就绪
                                ▼
                          ┌───────────┐
                    ┌─────│  running   │─────┐
                    │     └─────┬─────┘     │
                    │           │            │
               失败且可重试    完成         需要人工审批/
                    │           │         等待外部事件
                    ▼           ▼            ▼
              ┌──────────┐ ┌──────────┐ ┌───────────┐
              │  failed   │ │ completed│ │ suspended │
              └─────┬────┘ └──────────┘ └─────┬─────┘
                    │                         │
             重试次数 < max                  条件满足/审批通过
                    │                         │
                    └─────────┐   ┌───────────┘
                              ▼   ▼
                          ┌───────────┐
                          │  running   │  (恢复执行)
                          └───────────┘

  任何状态 → cancelled（用户主动取消或级联取消）
```

### 4.4 挂起与恢复机制（Suspend & Resume）

Agent 进入 `suspended` 状态的触发条件：

| 触发场景           | suspendReason           | 恢复条件                     |
| ------------------ | ----------------------- | ---------------------------- |
| Human Gate 审批    | `human_gate_pending`    | 用户调用 approve/reject API  |
| 等待外部脚本回调   | `awaiting_callback`     | Webhook 回调到达             |
| 等待上游部分数据   | `partial_data_waiting`  | 上游 Agent 发送 partial_data |
| 资源限流           | `resource_throttled`    | Worker Pool 释放槽位         |

**恢复流程**：

```typescript
async function resumeAgent(agentId: string, payload?: Record<string, any>) {
  const agent = await agentStore.load(agentId);
  if (agent.status !== "suspended") throw new Error("Agent not suspended");

  agent.status = "running";
  agent.suspendedAt = undefined;
  agent.suspendReason = undefined;

  if (payload) {
    Object.assign(agent.skillInputs, payload);
  }

  eventBus.emit("agent.resumed", { agentId, taskId: agent.taskId });
  await scheduler.scheduleAgent(agent);
}
```

### 4.5 失败处理与重规划

```
Agent 执行失败
    │
    ├── retryCount < maxRetries?
    │       │
    │       YES → 指数退避后重新调度
    │              delay = min(baseDelay * 2^retryCount, maxDelay)
    │
    │       NO ↓
    │
    ├── 该 Agent 标记为 critical?
    │       │
    │       YES → 触发 Task 级别失败
    │              向所有运行中 Agent 发送 abort_signal
    │              Task.status → "failed"
    │
    │       NO ↓
    │
    └── 触发 Replanner
            │
            Planning Engine 接收:
            - 原始 goal
            - 已完成的 Agent 结果
            - 失败的 Agent 信息
            │
            输出新的 partial ExecutionPlan (version+1)
            仅包含未完成部分的替代方案
```

---

## 5. 核心子系统四：事件总线与可观测性

### 5.1 EventBus 设计

```typescript
type CoralEventType =
  // Task lifecycle
  | "task.created" | "task.planning" | "task.plan_ready"
  | "task.executing" | "task.completed" | "task.failed" | "task.cancelled"
  // Agent lifecycle
  | "agent.spawned" | "agent.started" | "agent.suspended"
  | "agent.resumed" | "agent.completed" | "agent.failed" | "agent.cancelled"
  // Skill execution
  | "skill.executing" | "skill.completed" | "skill.failed"
  | "skill.sandbox_started" | "skill.sandbox_finished"
  // Human Gate
  | "human_gate.waiting" | "human_gate.approved"
  | "human_gate.rejected" | "human_gate.timeout"
  // Skill Registry
  | "skill.registered" | "skill.updated" | "skill.removed" | "skill.reload_failed"
  // System
  | "system.error" | "system.warning";

interface CoralEvent {
  eventId: string;
  type: CoralEventType;
  taskId?: string;
  agentId?: string;
  skillName?: string;
  payload: Record<string, any>;
  timestamp: Date;
}

class EventBus {
  on(type: CoralEventType, handler: (event: CoralEvent) => void): void;
  off(type: CoralEventType, handler: Function): void;
  emit(type: CoralEventType, payload: Record<string, any>): void;
  history(filter?: { taskId?: string; type?: string }): CoralEvent[];
  stream(filter?: { taskId?: string }): AsyncIterable<CoralEvent>;
}
```

### 5.2 前端实时推送

```
EventBus (进程内)
    │
    ├── WebSocket /ws/events
    │     客户端可订阅: { taskId: "xxx" } 或 { types: ["agent.*"] }
    │     服务端推送: CoralEvent JSON
    │
    └── SSE /api/events/stream (兼容)
          Last-Event-ID 支持断点续传
          Content-Type: text/event-stream
```

### 5.3 审计日志

所有 `CoralEvent` 在 `emit` 时同步写入审计层。审计数据直接落 PostgreSQL `audit_logs` 表，支持按 `taskId`/`agentId`/`skillName`/时间范围高效查询。

---

## 6. 数据库设计（PostgreSQL）

### 6.1 设计原则

- **Skill 元数据不存数据库**：从文件系统热加载，数据库只记录执行记录和统计。
- **Task / Agent / Plan 存数据库**：支持断点恢复、历史查询、并发安全。
- **审计日志存数据库**：支持合规查询和分析。

### 6.2 核心表结构

```sql
-- ═══════════════════════════════════════════════════
-- 任务表
-- ═══════════════════════════════════════════════════
CREATE TABLE tasks (
    task_id         TEXT PRIMARY KEY,            -- nanoid
    user_id         TEXT NOT NULL,
    goal            TEXT NOT NULL,               -- 自然语言目标
    constraints     JSONB DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'created',
    -- status: created | planning | executing | waiting_human | completed | failed | cancelled
    current_plan_id TEXT REFERENCES execution_plans(plan_id),
    result          JSONB,                       -- TaskResult
    error           JSONB,                       -- 失败原因
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_user_id ON tasks(user_id);
CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC);

-- ═══════════════════════════════════════════════════
-- 执行计划表
-- ═══════════════════════════════════════════════════
CREATE TABLE execution_plans (
    plan_id               TEXT PRIMARY KEY,
    task_id               TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    version               INTEGER NOT NULL DEFAULT 1,
    agents_definition     JSONB NOT NULL,         -- PlannedAgent[]
    edges_definition      JSONB NOT NULL,         -- DependencyEdge[]
    estimated_duration_ms INTEGER,
    planner_model         TEXT,
    planner_reasoning     TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(task_id, version)
);

CREATE INDEX idx_plans_task_id ON execution_plans(task_id);

-- ═══════════════════════════════════════════════════
-- Agent 实例表
-- ═══════════════════════════════════════════════════
CREATE TABLE agent_instances (
    agent_id        TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    plan_id         TEXT NOT NULL REFERENCES execution_plans(plan_id),
    name            TEXT NOT NULL,
    role            TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    -- status: pending | running | suspended | completed | failed | cancelled
    assigned_skills TEXT[] NOT NULL DEFAULT '{}',
    skill_results   JSONB DEFAULT '{}',           -- Record<skillName, SkillExecutionResult>
    depends_on      TEXT[] DEFAULT '{}',
    output          JSONB,
    error           JSONB,
    retry_count     INTEGER NOT NULL DEFAULT 0,
    max_retries     INTEGER NOT NULL DEFAULT 2,
    timeout_ms      INTEGER NOT NULL DEFAULT 300000,
    suspend_reason  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    suspended_at    TIMESTAMPTZ
);

CREATE INDEX idx_agents_task_id ON agent_instances(task_id);
CREATE INDEX idx_agents_status ON agent_instances(status);
CREATE INDEX idx_agents_plan_id ON agent_instances(plan_id);

-- ═══════════════════════════════════════════════════
-- Skill 执行记录表（统计与追溯）
-- ═══════════════════════════════════════════════════
CREATE TABLE skill_execution_records (
    record_id       TEXT PRIMARY KEY,
    task_id         TEXT REFERENCES tasks(task_id),
    agent_id        TEXT REFERENCES agent_instances(agent_id),
    skill_name      TEXT NOT NULL,
    skill_version   TEXT,
    execution_mode  TEXT NOT NULL,                 -- llm_only | script | hybrid
    input_summary   TEXT,                          -- 截断的输入摘要
    output_summary  TEXT,                          -- 截断的输出摘要
    success         BOOLEAN NOT NULL,
    error_code      TEXT,
    error_message   TEXT,
    duration_ms     INTEGER,
    tokens_used     INTEGER,
    sandbox_used    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_skill_records_skill ON skill_execution_records(skill_name);
CREATE INDEX idx_skill_records_task ON skill_execution_records(task_id);
CREATE INDEX idx_skill_records_time ON skill_execution_records(created_at DESC);

-- ═══════════════════════════════════════════════════
-- 审计日志表（全链路）
-- ═══════════════════════════════════════════════════
CREATE TABLE audit_logs (
    log_id          BIGSERIAL PRIMARY KEY,
    event_type      TEXT NOT NULL,                 -- CoralEventType
    task_id         TEXT,
    agent_id        TEXT,
    skill_name      TEXT,
    user_id         TEXT,
    payload         JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_event_type ON audit_logs(event_type);
CREATE INDEX idx_audit_task_id ON audit_logs(task_id);
CREATE INDEX idx_audit_created_at ON audit_logs(created_at DESC);

-- 分区（可选，按月自动分区提升大数据量下查询性能）
-- CREATE TABLE audit_logs (...) PARTITION BY RANGE (created_at);

-- ═══════════════════════════════════════════════════
-- Human Gate 审批记录表
-- ═══════════════════════════════════════════════════
CREATE TABLE human_gate_decisions (
    decision_id     TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES tasks(task_id),
    agent_id        TEXT NOT NULL REFERENCES agent_instances(agent_id),
    skill_name      TEXT,
    gate_type       TEXT NOT NULL,                 -- approval | review | confirmation
    status          TEXT NOT NULL DEFAULT 'pending',
    -- status: pending | approved | rejected | timeout
    request_payload JSONB,                         -- 审批请求详情
    decision_by     TEXT,                          -- 审批人 userId
    decision_note   TEXT,
    decided_at      TIMESTAMPTZ,
    timeout_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_gate_task_id ON human_gate_decisions(task_id);
CREATE INDEX idx_gate_status ON human_gate_decisions(status);
```

### 6.3 实体关系图

```
┌──────────┐       1:N       ┌──────────────────┐
│  tasks   │ ───────────────→│ execution_plans   │
│          │                 │                    │
│ task_id  │       1:N       │ plan_id           │
│ goal     │ ──┐             │ version           │
│ status   │   │             └──────┬───────────┘
└──────────┘   │                    │ 1:N
               │                    ▼
               │            ┌──────────────────┐
               │            │ agent_instances   │
               │            │                    │
               ├───────────→│ agent_id          │
               │            │ status            │
               │            │ assigned_skills   │
               │            └──────┬───────────┘
               │                   │ 1:N
               │                   ▼
               │           ┌───────────────────────┐
               │           │ skill_execution_records│
               └──────────→│                        │
                           │ skill_name             │
                           │ duration_ms            │
                           │ tokens_used            │
                           └───────────────────────┘

               ┌──────────────────────┐
               │    audit_logs         │
               │                      │
               │  event_type          │
               │  task_id / agent_id  │
               │  payload (JSONB)     │
               └──────────────────────┘

               ┌──────────────────────┐
               │ human_gate_decisions  │
               │                      │
               │  task_id / agent_id  │
               │  status / decision   │
               └──────────────────────┘
```

---

## 7. Planning Engine 详细设计

### 7.1 规划流程

```
用户输入 goal + constraints
           │
           ▼
   ┌───────────────────┐
   │  Step 1: 快速路径   │  规则匹配预定义的简单模式
   │  Fast Path Check  │  命中 → 跳过 LLM 规划，直接构建单 Agent Plan
   └────────┬──────────┘
            │ 未命中
            ▼
   ┌───────────────────┐
   │  Step 2: Goal     │  LLM 理解用户目标
   │  Parsing          │  提取意图、约束、上下文
   └────────┬──────────┘
            │
            ▼
   ┌───────────────────┐
   │  Step 3: Skill    │  从 Registry 查询匹配的 Skills
   │  Discovery        │  按 domain + capabilities 过滤
   └────────┬──────────┘
            │
            ▼
   ┌───────────────────┐
   │  Step 4: DAG      │  LLM 生成 Agent 列表和依赖关系
   │  Plan Building    │  确定哪些可并行、哪些有依赖
   └────────┬──────────┘
            │
            ▼
   ┌───────────────────┐
   │  Step 5: Plan     │  校验 DAG 无环
   │  Validation       │  校验所有引用的 Skill 存在且可用
   └────────┬──────────┘  校验 input_schema 兼容性
            │
            ▼
      ExecutionPlan
```

### 7.2 Planning Prompt 模板

```
你是 CORAL 平台的规划引擎。你的任务是将用户的自然语言目标分解为可并发执行的 Agent DAG。

## 可用 Skills
{从 Registry 动态注入的 Skill 列表，每个包含 name + description + input_schema 摘要}

## 用户目标
{goal}

## 约束条件
{constraints}

## 输出格式
严格输出如下 JSON：
{
  "reasoning": "你的规划思路",
  "agents": [
    {
      "agentId": "a1",
      "name": "...",
      "role": "...",
      "assignedSkills": ["skill-name"],
      "skillInputTemplates": { "skill-name": { ... } },
      "dependsOn": [],
      "priority": 0,
      "estimatedDurationMs": 10000
    }
  ],
  "edges": [
    { "from": "a1", "to": "a2", "dataMapping": { "output_key": "input_key" } }
  ]
}

## 规则
1. 没有相互依赖的 Agent 必须标记为可并行（dependsOn 为空或仅依赖已标记的 Agent）
2. 每个 Agent 至少分配一个 Skill
3. 尽量将独立子任务拆分到不同 Agent 以最大化并发
4. dataMapping 描述上游 Agent 的输出如何映射到下游 Agent 的输入
```

### 7.3 Fast Path 规则引擎

对于简单/模式化任务，跳过 LLM 规划直接构建 Plan：

```typescript
interface FastPathRule {
  id: string;
  match: (goal: string, constraints: Record<string, any>) => boolean;
  buildPlan: (goal: string, constraints: Record<string, any>) => ExecutionPlan;
}

const fastPathRules: FastPathRule[] = [
  {
    id: "single_skill_by_name",
    match: (goal, constraints) => !!constraints.skillName,
    buildPlan: (goal, constraints) => ({
      // 单 Skill 直接执行，无需 Agent DAG
      agents: [{ agentId: "a1", assignedSkills: [constraints.skillName], dependsOn: [] }],
      edges: [],
    }),
  },
  // Scenario Pack 可以注册自己的 Fast Path 规则
];
```

---

## 8. Scenario Pack（场景包）架构

### 8.1 场景包目录结构

```
scenario-packs/
└── policy-analysis/                # 场景包名称
    ├── SCENARIO.md                 # 场景描述 + 元数据
    ├── skills/                     # 场景专属 Skills
    │   ├── crawl-policy/
    │   │   ├── SKILL.md
    │   │   └── scripts/
    │   ├── analyze-policy/
    │   │   └── SKILL.md
    │   └── draft-report/
    │       └── SKILL.md
    ├── templates/                  # DAG 编排模板
    │   ├── full-pipeline.json      # 完整流水线 DAG 定义
    │   └── quick-analysis.json     # 快速分析 DAG 定义
    └── ui/                         # 前端扩展元数据
        └── forms.json              # 表单字段定义
```

### 8.2 场景包加载流程

```
1. 平台启动时扫描 scenario-packs/ 目录
2. 读取每个包的 SCENARIO.md 元数据
3. 将场景专属 Skills 符号链接或复制到 skills/ 主目录
4. 注册场景 DAG 模板到 Planning Engine 的 Fast Path 规则
5. 将 UI 表单元数据注册到前端可发现的元数据接口
```

### 8.3 SCENARIO.md 元数据

```yaml
---
name: policy-analysis
version: "1.0.0"
description: "政策抓取 → 分析 → 报告生成全流程场景包"
author: "CORAL Team"
skills:
  - crawl-policy
  - analyze-policy
  - draft-report
default_template: full-pipeline
tags: [policy, analysis, government]
---
```

---

## 9. 技术栈与工程架构

### 9.1 技术栈选型

| 层次           | 技术                                        | 理由                                                 |
| -------------- | ------------------------------------------- | ---------------------------------------------------- |
| 前端           | React 18 + Vite + Tailwind CSS + React Router | 现有基础，生态成熟                                   |
| 后端框架       | Node.js + Fastify + TypeScript              | 高性能 + 类型安全，现有基础                          |
| LLM 调用       | `openai` npm SDK                            | 兼容 OpenAI / SiliconCloud / Ollama / Anthropic      |
| 数据库         | PostgreSQL 15+                              | JSONB 支持、成熟生态、高并发                         |
| ORM / Query    | Drizzle ORM 或 Kysely                       | 类型安全 SQL、轻量级、不需要重量级迁移               |
| SKILL.md 解析  | `gray-matter` npm                           | 成熟的 YAML Frontmatter 解析器                       |
| 文件系统监控   | `chokidar`                                  | 跨平台文件系统 watcher                               |
| JSON Schema    | `ajv`                                       | 高性能 JSON Schema 校验                              |
| 子进程沙箱     | `child_process` + `dockerode`（可选）        | 灵活的进程级/容器级隔离                              |
| WebSocket      | `@fastify/websocket`                        | 实时事件推送                                         |
| 队列（可选）   | BullMQ + Redis                              | 任务队列与限流                                       |
| 测试           | Vitest                                      | 与 Vite 一致的测试框架                               |
| Monorepo       | npm workspaces                              | 现有基础                                             |

### 9.2 项目目录结构（重构后）

```
/coral
├── packages/
│   ├── server/                            # 后端
│   │   ├── src/
│   │   │   ├── index.ts                   # Fastify 入口
│   │   │   │
│   │   │   ├── api/                       # HTTP/WS 路由层
│   │   │   │   ├── index.ts               # 路由聚合
│   │   │   │   ├── task.routes.ts         # Task CRUD + approve
│   │   │   │   ├── skill.routes.ts        # Skill 查询 + 测试
│   │   │   │   ├── event.routes.ts        # SSE/WS 事件流
│   │   │   │   ├── chat.routes.ts         # Planning 入口
│   │   │   │   ├── scenario.routes.ts     # Scenario Pack 查询
│   │   │   │   └── system.routes.ts       # 健康检查 + 配置
│   │   │   │
│   │   │   ├── planning/                  # 规划引擎
│   │   │   │   ├── planning-engine.ts     # 规划总控
│   │   │   │   ├── goal-parser.ts         # 目标解析
│   │   │   │   ├── skill-matcher.ts       # 能力匹配
│   │   │   │   ├── dag-builder.ts         # DAG 构建
│   │   │   │   ├── fast-path.ts           # 快速路径规则
│   │   │   │   └── plan-validator.ts      # 计划校验
│   │   │   │
│   │   │   ├── scheduler/                 # DAG 调度器
│   │   │   │   ├── dag-scheduler.ts       # 核心调度算法
│   │   │   │   ├── agent-runner.ts        # 单 Agent 执行器
│   │   │   │   ├── worker-pool.ts         # 并发 Worker 池
│   │   │   │   └── human-gate.ts          # 人工审批关卡
│   │   │   │
│   │   │   ├── skill-runtime/             # Skill 运行时
│   │   │   │   ├── filesystem-registry.ts # 文件系统注册表
│   │   │   │   ├── skill-watcher.ts       # 文件监控 + 热重载
│   │   │   │   ├── skill-resolver.ts      # SKILL.md 解析器
│   │   │   │   ├── skill-executor.ts      # 统一执行入口
│   │   │   │   ├── llm-executor.ts        # LLM 路径执行
│   │   │   │   ├── sandbox-executor.ts    # 脚本沙箱执行
│   │   │   │   └── schema-validator.ts    # Input/Output 校验
│   │   │   │
│   │   │   ├── event/                     # 事件系统
│   │   │   │   ├── event-bus.ts           # 进程内事件总线
│   │   │   │   └── event-types.ts         # 事件类型定义
│   │   │   │
│   │   │   ├── services/                  # 共享服务
│   │   │   │   ├── llm-client.ts          # LLM 统一客户端
│   │   │   │   ├── prompt-renderer.ts     # Prompt 模板渲染
│   │   │   │   ├── config.ts              # 平台配置
│   │   │   │   └── cost-tracker.ts        # Token/成本统计
│   │   │   │
│   │   │   ├── persistence/               # 持久化层
│   │   │   │   ├── db.ts                  # PostgreSQL 连接
│   │   │   │   ├── schema.ts              # Drizzle/Kysely schema
│   │   │   │   ├── migrations/            # 数据库迁移
│   │   │   │   ├── task-repository.ts
│   │   │   │   ├── plan-repository.ts
│   │   │   │   ├── agent-repository.ts
│   │   │   │   └── audit-repository.ts
│   │   │   │
│   │   │   └── types/                     # 共享类型
│   │   │       └── index.ts
│   │   │
│   │   ├── skills/                        # 内置通用 Skills
│   │   │   ├── llm-complete/
│   │   │   │   └── SKILL.md
│   │   │   ├── llm-stream/
│   │   │   │   └── SKILL.md
│   │   │   └── .skill-creator/            # Meta-Skill: Skill 自动创建
│   │   │       ├── SKILL.md
│   │   │       ├── reference.md
│   │   │       └── scripts/
│   │   │           └── generate.ts
│   │   │
│   │   ├── scenario-packs/                # 场景包目录
│   │   │   └── (由用户/团队添加)
│   │   │
│   │   └── package.json
│   │
│   └── web/                               # 前端
│       ├── src/
│       │   ├── App.tsx                    # 路由 + 布局
│       │   ├── pages/
│       │   │   ├── DashboardPage.tsx      # 控制台总览
│       │   │   ├── TasksPage.tsx          # 任务列表
│       │   │   ├── TaskDetailPage.tsx     # 任务详情 + DAG 可视化
│       │   │   ├── SkillsPage.tsx         # Skills 浏览
│       │   │   ├── SkillCreatorPage.tsx   # Skill-Creator 交互
│       │   │   ├── ChatPage.tsx           # Planning 入口
│       │   │   └── SettingsPage.tsx       # LLM / 系统配置
│       │   ├── components/
│       │   │   ├── dag/                   # DAG 可视化组件
│       │   │   ├── task/                  # 任务相关组件
│       │   │   ├── skill/                 # Skill 相关组件
│       │   │   └── common/                # 通用组件
│       │   ├── hooks/
│       │   │   ├── useTaskEvents.ts       # WS 任务事件
│       │   │   ├── usePolling.ts          # 轮询
│       │   │   └── useSSE.ts              # SSE 流
│       │   └── api/
│       │       └── client.ts              # API 封装
│       └── package.json
│
├── package.json                           # Monorepo root
├── CORAL_Architecture_V4.md               # 本文件
├── CORAL_PRD_Core.md                      # 平台需求文档
└── README.md
```

---

## 10. 部署架构

### 10.1 单机部署（开发/小规模）

```
┌─────────────────────────────────────────┐
│              Single Node                 │
│                                          │
│  ┌──────────┐  ┌──────────┐             │
│  │ Coral    │  │ Coral    │             │
│  │ Server   │  │ Web      │             │
│  │ (Fastify)│  │ (Vite)   │             │
│  └─────┬────┘  └──────────┘             │
│        │                                 │
│  ┌─────▼────┐  ┌──────────┐             │
│  │PostgreSQL │  │  skills/  │ (本地 FS)  │
│  │  :5432    │  │           │             │
│  └──────────┘  └──────────┘             │
└─────────────────────────────────────────┘
```

### 10.2 生产部署

```
                    ┌──────────────┐
                    │  Nginx / LB  │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼────┐ ┌────▼─────┐ ┌───▼──────┐
        │ Coral #1 │ │ Coral #2 │ │ Coral #3 │
        │ (Server) │ │ (Server) │ │ (Server) │
        └─────┬────┘ └────┬─────┘ └───┬──────┘
              │            │            │
              └────────────┼────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼────┐ ┌────▼─────┐ ┌───▼──────┐
        │PostgreSQL│ │  Redis   │ │  NFS /   │
        │ (主从)   │ │ (限流)   │ │  S3     │
        └──────────┘ └──────────┘ │ (skills)│
                                   └─────────┘
```

多实例部署时，`skills/` 目录需挂载共享存储（NFS/S3），确保所有节点看到一致的 Skill 文件。

---

## 11. 安全架构

### 11.1 安全分层

| 层次           | 安全措施                                                       |
| -------------- | -------------------------------------------------------------- |
| 接入层         | HTTPS + CORS 白名单 + API Key / JWT 鉴权                      |
| 任务网关       | 角色权限校验（RBAC） + 请求限流（令牌桶）                      |
| Skill 执行     | 沙箱隔离 + 脚本白名单 + 网络访问限制 + 资源配额               |
| 数据存储       | 敏感字段加密存储 + 审计日志不可篡改                             |
| LLM 调用       | API Key 仅服务端持有 + 输入输出审计 + Token 配额               |

### 11.2 Skill 安全审查流程

```
新 Skill 添加到 skills/ 目录
        │
        ▼
  ┌─────────────────────┐
  │ 1. Frontmatter 校验  │ 必填字段 + Schema 合法性
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐
  │ 2. 脚本静态分析      │ 禁止 eval / exec / 危险系统调用
  └──────────┬──────────┘  检查网络请求目标
             │
             ▼
  ┌─────────────────────┐
  │ 3. 沙箱试运行        │ 使用 mock input 执行一次
  └──────────┬──────────┘  验证输出符合 output_schema
             │
             ▼
  ┌─────────────────────┐
  │ 4. 审批（可选）      │ 管理员人工审查
  └──────────┬──────────┘
             │
             ▼
  注册表正式生效 ✓
```

---

## 12. 性能与可靠性

### 12.1 性能指标

| 指标                          | 目标值                  |
| ----------------------------- | ----------------------- |
| 单任务内 Agent 并发上限       | 20+（可配置）           |
| 平台并发任务排队              | 100+                    |
| Planning Engine 规划延迟      | ≤ 10s（P95）            |
| Agent 调度开销（不含执行）    | ≤ 50ms                  |
| Skill 热重载延迟              | ≤ 1s                    |
| 事件推送端到端延迟            | ≤ 1s（P95）             |
| LLM 流式首字延迟              | ≤ 3s                    |

### 12.2 可靠性保障

| 机制               | 说明                                                         |
| ------------------ | ------------------------------------------------------------ |
| 断点续跑           | Task / Agent 状态持久化到 PostgreSQL，进程重启后可恢复       |
| Agent 重试         | 指数退避重试，最大重试次数可配置                             |
| 级联取消           | 任务取消时向所有活跃 Agent 发送 abort_signal                 |
| Skill 熔断         | 连续失败超阈值自动标记 Skill 为 `deprecated`                 |
| 沙箱超时强杀       | 脚本超时 → SIGTERM → 5s grace → SIGKILL                     |

---

## 13. 迁移策略（从当前 HiAgent MVP）

### 13.1 分阶段迁移计划

| 阶段  | 内容                                                                                  | 周期  |
| ----- | ------------------------------------------------------------------------------------- | ----- |
| M0    | 项目重命名 + 目录结构调整 + PostgreSQL 引入 + Skill 目录规范化                        | 1 周  |
| M1    | 文件系统注册表 + SKILL.md 解析器 + 热重载 + 现有 Skills 迁移为 SKILL.md 格式          | 2 周  |
| M2    | DAG Scheduler + Agent Runner + EventBus + Task API                                    | 3 周  |
| M3    | Planning Engine (规则 + LLM) + Chat 入口                                              | 2 周  |
| M4    | Script Sandbox + Skill-Creator + 安全审查流程                                         | 2 周  |
| M5    | 前端重构：DAG 可视化 + Skills 管理 + Task 监控 + 实时事件                             | 3 周  |
| M6    | Scenario Pack 框架 + 将现有政策/公文逻辑迁移为场景包                                  | 2 周  |

### 13.2 现有 Skill 迁移示例

**迁移前**（TypeScript 硬编码注册）：

```typescript
// skills/crawl/crawl-url.skill.ts
export const crawlUrlSkill: SkillHandler<...> = {
  name: "crawl_url",
  description: "...",
  async execute(input, context) { ... }
};
// register.ts 中手动注册
```

**迁移后**（SKILL.md 标准）：

```
skills/crawl-url/
├── SKILL.md          # name + description + schema + prompt
└── scripts/
    └── execute.ts    # 原有执行逻辑（接收 stdin JSON，输出 stdout JSON）
```

---

## 附录 A：关键配置参数

```typescript
interface CoralPlatformConfig {
  // 服务基础
  PORT: number;                          // 3001
  HOST: string;                          // "0.0.0.0"

  // 数据库
  DATABASE_URL: string;                  // PostgreSQL 连接串

  // LLM
  LLM_BASE_URL: string;
  LLM_API_KEY: string;                   // 环境变量注入
  LLM_MODEL: string;
  PLANNING_MODEL?: string;               // 规划专用模型

  // Skill 运行时
  SKILLS_DIR: string;                    // "./skills"
  SCENARIO_PACKS_DIR: string;            // "./scenario-packs"
  SKILL_WATCHER_DEBOUNCE_MS: number;     // 300
  SKILL_DEFAULT_TIMEOUT_MS: number;      // 180000

  // 沙箱
  SANDBOX_MODE: "process" | "docker";    // "process"
  SANDBOX_TIMEOUT_MS: number;            // 30000
  SANDBOX_MEMORY_LIMIT_MB: number;       // 256
  SANDBOX_NETWORK_ENABLED: boolean;      // false

  // 调度
  MAX_CONCURRENT_TASKS: number;          // 50
  MAX_CONCURRENT_AGENTS_PER_TASK: number;// 10
  AGENT_DEFAULT_TIMEOUT_MS: number;      // 300000
  AGENT_MAX_RETRIES: number;             // 2

  // 人工审批
  HUMAN_GATE_TIMEOUT_MS: number;         // 86400000 (24h)
  HUMAN_GATE_AUTO_REJECT: boolean;       // true

  // 可选
  REDIS_URL?: string;                    // 限流 + 缓存
}
```

---

## 附录 B：术语表

| 术语              | 定义                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| **Skill**         | 最小可执行能力单元，由 `skills/<name>/SKILL.md` 声明                     |
| **Agent**         | 任务执行者实例，被分配一组 Skills，有完整生命周期状态机                   |
| **Task**          | 用户提交的顶层工作单元，包含目标和约束                                   |
| **ExecutionPlan** | 由 Planning Engine 生成的 DAG 执行计划                                   |
| **DAG**           | 有向无环图（Directed Acyclic Graph），描述 Agent 间的依赖关系            |
| **Sandbox**       | Skill 脚本的隔离执行环境（进程级或容器级）                               |
| **Human Gate**    | 需要人工审批/确认的执行关卡                                               |
| **Scenario Pack** | 面向特定业务场景的 Skills + DAG 模板 + UI 扩展打包                       |
| **Fast Path**     | 预定义的简单任务直接执行路径，跳过 LLM 规划                             |
| **Skill-Creator** | 内置的 Meta-Skill，用于 AI 自动生成新 Skill                             |

---

*文档结束 — CORAL 系统架构设计文档 V4*
