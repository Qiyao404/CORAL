# CORAL — 平台底座产品需求文档（PRD Core）

> **版本：V1.0** | 日期：2026-04-02 | 状态：定稿  
> **定位：通用智能体运行时平台的核心功能需求，不含任何特定业务场景逻辑**

---

## 0. 文档信息

| 字段     | 内容                                                                 |
| -------- | -------------------------------------------------------------------- |
| 文档名称 | CORAL — 平台底座产品需求文档（PRD Core）                             |
| 配套文档 | CORAL_Architecture_V4.md（系统架构设计）                             |
| 适用范围 | 平台内核研发、产品验收、迭代规划                                     |
| 非目标   | 不定义任何具体业务场景需求（政策分析、公文写作等由 Scenario Pack 独立定义）|

---

## 1. 产品定位

### 1.1 一句话定义

**CORAL 是一个通用的、并发的、由 LLM 原生驱动的多智能体调度与技能运行时平台。**

它接收自然语言目标，自动规划执行方案，并发调度多个 Agent 执行标准化 Skill，输出可追踪、可审计的结果。

### 1.2 平台本质

```
CORAL 是"底座与引擎"
├── 解析自然语言目标
├── 并发调度多 Agent（类似 CrewAI）
├── 解析并执行标准化 Skill 包
├── 管理状态与沙箱隔离
└── 全链路可观测与可审计

业务是"场景包（Scenario Packs）"
├── 政策分析、公文写作、合同审查……
├── 以插件形式动态加载
└── 平台核心代码中不包含任何业务硬编码

生态是"自生长的"
├── 基于 Markdown 声明的 Skill 标准
├── AI 自动编写新 Skill（Skill-Creator）
└── 新 Skill 热加载，即刻可用
```

### 1.3 核心设计原则

| 编号 | 原则                         | 说明                                                           |
| ---- | ---------------------------- | -------------------------------------------------------------- |
| P1   | **文件系统即注册表**          | Skill 以目录形式存在于文件系统，不需要数据库注册               |
| P2   | **Markdown 即配置**          | SKILL.md 的 YAML Frontmatter 声明元数据，正文即 Prompt         |
| P3   | **DAG 原生并发**             | 无依赖的 Agent 必须真并行执行，不允许退化为串行                |
| P4   | **沙箱隔离执行**             | 外部脚本在独立进程/容器中运行，与平台进程隔离                  |
| P5   | **场景零耦合**               | 平台内核不含任何业务领域词汇，所有场景以 Scenario Pack 存在    |
| P6   | **热重载免重启**             | Skill 文件变更后自动重载，无需重启平台                         |
| P7   | **可观测与可审计**           | 每个 Task/Agent/Skill 调用全链路事件化，支持回放和分析         |

### 1.4 目标用户

| 用户角色             | 使用方式                                                         |
| -------------------- | ---------------------------------------------------------------- |
| 企业 AI 平台团队     | 部署 CORAL 作为统一的智能体运行底座                              |
| 场景开发者           | 编写 Scenario Pack + Skills 扩展平台能力                         |
| 终端业务用户         | 通过 Web UI / Chat 提交自然语言任务，获取结果                    |
| 平台管理员           | 管理 Skill 审核、权限配置、系统监控                              |

### 1.5 非目标（当前版本）

- 不做通用大模型训练平台
- 不做低代码拖拽工作流编辑器（可后续扩展）
- 不做跨租户复杂计费系统
- 不包含任何特定行业/业务的内置逻辑

---

## 2. 核心模块需求

### 模块 A：Skill 热更新发现系统

#### A.1 功能概述

平台采用"文件系统即注册表"模式管理 Skills。每个 Skill 是 `skills/` 目录下的独立文件夹，平台通过文件系统监控实现 Skill 的自动发现、解析、注册和热更新。

#### A.2 Skill 目录标准

每个 Skill 目录结构如下：

```
skills/<skill-name>/
├── SKILL.md              # 核心定义（必需）
│   ├── YAML Frontmatter  # 元数据：name, description, schemas, execution_mode...
│   └── Markdown Body     # System Prompt 正文
├── reference.md          # 参考资料 / RAG 知识（可选）
└── scripts/              # 可执行脚本（可选，仅 script/hybrid 模式）
    ├── execute.py        # 主入口脚本
    └── requirements.txt  # 脚本依赖
```

#### A.3 SKILL.md Frontmatter 必填字段

| 字段             | 类型     | 说明                                                       |
| ---------------- | -------- | ---------------------------------------------------------- |
| `name`           | string   | 唯一标识，与文件夹名一致                                   |
| `version`        | string   | 语义化版本号                                               |
| `description`    | string   | 功能说明，供 Planning Engine 理解                          |
| `domain`         | string   | 能力域标签（自由定义，如 data-extraction, text-processing）|
| `capabilities`   | string[] | 能力标签列表                                               |
| `input_schema`   | object   | JSON Schema 格式的输入定义                                 |
| `output_schema`  | object   | JSON Schema 格式的输出定义                                 |
| `execution_mode` | enum     | `llm_only` / `script` / `hybrid`                          |
| `status`         | enum     | `experimental` / `stable` / `deprecated`                   |

#### A.4 SKILL.md Frontmatter 可选字段

| 字段                  | 类型    | 说明                                       |
| --------------------- | ------- | ------------------------------------------ |
| `script_entry`        | string  | 脚本入口文件路径（相对于 Skill 目录）      |
| `script_runtime`      | enum    | `python3` / `node` / `deno` / `bash`      |
| `script_timeout_ms`   | number  | 脚本执行超时（毫秒）                       |
| `human_gate`          | boolean | 是否需要人工确认                           |
| `estimated_duration_ms` | number | 预估执行时长（毫秒）                      |
| `cost_level`          | enum    | `low` / `medium` / `high`                 |
| `tags`                | string[] | 自由标签                                  |

#### A.5 功能需求列表

| ID   | 需求                   | 优先级 | 说明                                                             |
| ---- | ---------------------- | ------ | ---------------------------------------------------------------- |
| A-01 | 启动时全量扫描注册     | P0     | 平台启动时扫描 `skills/` 全部子目录，解析所有 SKILL.md 并注册   |
| A-02 | 文件系统实时监控       | P0     | 使用 chokidar 监控 `skills/` 目录变更（增/删/改）               |
| A-03 | 热重载防抖             | P0     | 文件变更后 300ms 防抖合并，避免频繁重载                         |
| A-04 | SKILL.md 解析          | P0     | 使用 gray-matter 解析 YAML Frontmatter + Markdown 正文         |
| A-05 | Schema 校验            | P0     | 解析后校验 input_schema/output_schema 的 JSON Schema 合法性    |
| A-06 | 热加载前校验           | P0     | 任何校验失败不影响现有注册表，仅发出 `skill.reload_failed` 事件 |
| A-07 | 内存注册表             | P0     | 支持按 name/domain/capabilities 查询，O(1) 按名称查找          |
| A-08 | reference.md 加载      | P1     | 如存在则加载并缓存，供 LLM 执行路径使用                        |
| A-09 | 删除检测               | P1     | 文件夹被删除 → 从注册表移除（不影响正在执行的实例）            |
| A-10 | 注册表元数据 API       | P0     | `GET /api/skills` 返回所有已注册 Skill 的元数据列表            |
| A-11 | 单 Skill 详情 API      | P0     | `GET /api/skills/:name` 返回完整元数据 + Prompt 摘要           |
| A-12 | Skill 搜索 API         | P1     | 按 domain、capabilities、tags 筛选查询                         |
| A-13 | Skill 状态统计         | P1     | 记录每个 Skill 的调用次数、成功率、平均耗时、Token 消耗        |

#### A.6 验收标准

- 在 `skills/` 中新建 Skill 目录并写入合法 SKILL.md 后，≤ 2s 内在 `GET /api/skills` 中可见。
- 修改 SKILL.md 后，≤ 2s 内注册表中元数据更新。
- 删除 Skill 目录后，≤ 2s 内从注册表移除。
- SKILL.md 格式错误时，不影响其他 Skill 正常工作，API 返回中包含错误提示。

---

### 模块 B：Planning Engine（动态规划引擎）

#### B.1 功能概述

接收用户的自然语言目标，将其分解为可并发执行的 Agent DAG（有向无环图）。支持快速路径（规则匹配）和 LLM 深度规划两种模式。

#### B.2 规划流程

```
用户提交: { goal: "...", constraints: {...} }
         │
         ▼
   ┌──────────────────┐
   │ 1. Fast Path     │  检查是否匹配预定义的规则模式
   │    Check         │  命中 → 直接生成 Plan → 跳到步骤 5
   └────────┬─────────┘
            │ 未命中
            ▼
   ┌──────────────────┐
   │ 2. Goal Parsing  │  LLM 理解用户目标、提取意图和约束
   └────────┬─────────┘
            │
            ▼
   ┌──────────────────┐
   │ 3. Skill         │  从 Registry 查询匹配的 Skills 列表
   │    Discovery     │  向 LLM 提供可用 Skill 清单
   └────────┬─────────┘
            │
            ▼
   ┌──────────────────┐
   │ 4. DAG Building  │  LLM 生成 Agent 列表 + 依赖关系 + 参数映射
   └────────┬─────────┘
            │
            ▼
   ┌──────────────────┐
   │ 5. Validation    │  校验 DAG 无环 + Skills 存在 + Schema 兼容
   └────────┬─────────┘
            │
            ▼
      ExecutionPlan 输出
```

#### B.3 功能需求列表

| ID   | 需求                     | 优先级 | 说明                                                               |
| ---- | ------------------------ | ------ | ------------------------------------------------------------------ |
| B-01 | Fast Path 规则引擎       | P0     | 预定义规则匹配简单任务，跳过 LLM 规划                             |
| B-02 | Fast Path 可扩展注册     | P1     | Scenario Pack 可注册自定义 Fast Path 规则                          |
| B-03 | Goal Parsing             | P0     | LLM 理解自然语言目标，提取意图和结构化约束                         |
| B-04 | Skill Discovery          | P0     | 从 Registry 动态查询匹配的 Skills，注入到 Planning Prompt          |
| B-05 | DAG Plan Building        | P0     | LLM 输出标准化 JSON 格式的 Agent 列表、依赖边和参数映射           |
| B-06 | Plan Validation          | P0     | 校验 DAG 无环 + 所有引用的 Skill 名存在且状态非 deprecated        |
| B-07 | Schema 兼容性校验        | P1     | 校验上下游 Agent 间的 dataMapping 类型兼容                         |
| B-08 | 重规划（Replanning）     | P1     | Agent 失败后触发局部重规划，仅覆盖未完成部分                       |
| B-09 | 规划超时保护             | P0     | LLM 规划超过 30s 自动终止，返回错误                               |
| B-10 | 规划可追溯               | P0     | 保存 LLM 的 reasoning（规划思路）到 ExecutionPlan                  |

#### B.4 Planning Prompt 关键要求

Planning Engine 向 LLM 发送的 Prompt 必须包含以下动态内容：

1. **可用 Skill 列表**：从 Registry 实时获取，每个 Skill 包含 `name` + `description` + `input_schema 摘要` + `capabilities`。
2. **用户目标**：原始自然语言 `goal`。
3. **约束条件**：结构化的 `constraints`。
4. **输出格式**：严格的 JSON Schema 定义（agents + edges）。

LLM 输出规则要求：
- 无相互依赖的 Agent 必须标记为可并行。
- 每个 Agent 至少分配一个 Skill。
- `dataMapping` 描述上游输出 key 到下游输入 key 的映射关系。

#### B.5 验收标准

- 简单任务（指定 Skill 名直接执行）≤ 500ms 完成规划（Fast Path）。
- 复杂任务（需 LLM 规划）≤ 15s 完成规划，输出合法 DAG。
- 规划产出的 DAG 通过拓扑排序验证无环。
- 规划引用的所有 Skill 在 Registry 中存在且可用。
- 重规划保留已完成 Agent 的结果，仅生成未完成部分的替代方案。

---

### 模块 C：DAG 并发调度引擎

#### C.1 功能概述

基于 Planning Engine 输出的 ExecutionPlan（DAG），并发调度多个 Agent 执行。支持 Agent 挂起/恢复、失败重试、级联取消、人工审批关卡。

#### C.2 核心调度算法

```
输入: ExecutionPlan (DAG)
输出: TaskResult

1. 初始化所有 Agent 实例（状态 = pending）
2. 计算每个 Agent 的入度（依赖数量）
3. 入度 = 0 的 Agent 入就绪队列
4. 循环:
   4.1 从就绪队列取出 Agent（受并发上限约束）
   4.2 并行启动取出的 Agent
   4.3 任一 Agent 完成时:
       - 更新后继 Agent 的入度
       - 入度归零的 Agent 入就绪队列
       - 注入上游数据（通过 dataMapping）
   4.4 Agent 失败时:
       - retryCount < maxRetries → 指数退避后重入队列
       - 否则 → 触发重规划或 Task 失败
   4.5 就绪队列为空 且 无运行中 Agent → 结束
5. 聚合所有 Agent 输出为 TaskResult
```

#### C.3 功能需求列表

| ID   | 需求                         | 优先级 | 说明                                                                 |
| ---- | ---------------------------- | ------ | -------------------------------------------------------------------- |
| C-01 | DAG 拓扑调度                 | P0     | 基于入度的标准拓扑排序调度                                           |
| C-02 | 真并发执行                   | P0     | 无依赖 Agent 必须并行启动，不允许串行                                |
| C-03 | 并发上限控制                 | P0     | `MAX_CONCURRENT_AGENTS_PER_TASK` 可配置，默认 10                     |
| C-04 | 优先级调度                   | P1     | 同层就绪 Agent 按 priority 排序执行                                  |
| C-05 | 上下游数据传递               | P0     | 通过 `dataMapping` 自动将上游 output 注入下游 input                  |
| C-06 | Agent 失败重试               | P0     | 指数退避（base=1s, max=30s），可配置最大重试次数                     |
| C-07 | Agent 超时控制               | P0     | 单 Agent 超时可配置，默认 300s                                       |
| C-08 | Agent 挂起恢复               | P0     | 支持 suspended 状态，条件满足后自动恢复                              |
| C-09 | Human Gate 集成              | P0     | Agent 触发 human_gate 时自动挂起，审批后恢复                         |
| C-10 | 级联取消                     | P0     | Task 取消时，向所有活跃 Agent 发送 abort_signal                      |
| C-11 | 部分重跑                     | P1     | 支持从失败节点开始重跑，不重复执行已成功的 Agent                     |
| C-12 | 全链路事件广播               | P0     | 每个状态变更发送 EventBus 事件                                       |
| C-13 | 结果聚合                     | P0     | 所有 Agent 完成后聚合输出为 TaskResult                               |

#### C.4 Agent 生命周期状态

| 状态        | 含义                             | 进入条件                         |
| ----------- | -------------------------------- | -------------------------------- |
| `pending`   | 等待依赖满足                     | 初始化时                         |
| `running`   | 正在执行 Skills                  | 依赖全满足 + Worker 有空位       |
| `suspended` | 挂起等待                         | Human Gate / 外部回调 / 限流     |
| `completed` | 执行完成                         | 所有 Skills 成功                 |
| `failed`    | 执行失败                         | 重试耗尽仍失败                   |
| `cancelled` | 被取消                           | Task 取消或级联取消              |

#### C.5 验收标准

- 两个无依赖 Agent 并行执行时，总耗时接近 `max(A, B)` 而非 `A + B`。
- Agent A 依赖 Agent B 时，A 在 B 完成前保持 `pending`，B 完成后 A 自动启动。
- Agent 执行失败后在配置的重试次数内自动重试。
- Task 取消后 ≤ 5s 内所有 Agent 停止执行。
- Human Gate 触发后 Agent 进入 `suspended`，审批后自动恢复执行。

---

### 模块 D：Skill 执行引擎

#### D.1 功能概述

统一执行入口，根据 Skill 的 `execution_mode` 分发到不同的执行路径：LLM 文本处理、沙箱脚本执行或混合模式。

#### D.2 三种执行路径

| 模式       | 说明                                                             |
| ---------- | ---------------------------------------------------------------- |
| `llm_only` | 组装 Prompt（SKILL.md 正文 + reference.md + input）→ 调用 LLM  |
| `script`   | 在沙箱中启动脚本进程 → stdin JSON → stdout JSON                 |
| `hybrid`   | LLM 预处理 → 沙箱脚本执行 → LLM 后处理                         |

#### D.3 功能需求列表

| ID   | 需求                          | 优先级 | 说明                                                                   |
| ---- | ----------------------------- | ------ | ---------------------------------------------------------------------- |
| D-01 | 统一执行入口                  | P0     | 所有 Skill 调用通过同一 Executor，根据 execution_mode 分发             |
| D-02 | LLM 路径执行                  | P0     | 自动组装 System Prompt + reference + input + output_schema 约束        |
| D-03 | LLM 输出校验                  | P0     | 解析 LLM 返回的 JSON，校验是否符合 output_schema                      |
| D-04 | LLM 输出修复重试              | P1     | 校验失败时附带错误提示重新调用 LLM（最多 2 次）                       |
| D-05 | Script 路径执行               | P0     | 启动子进程，通过 stdin/stdout 传递 JSON                                |
| D-06 | 沙箱进程隔离                  | P0     | 子进程独立工作目录、受限环境变量、超时强杀                             |
| D-07 | Docker 容器隔离（可选）       | P1     | 生产环境可选 Docker 隔离，网络/文件系统/资源全限制                     |
| D-08 | Hybrid 三阶段执行             | P1     | LLM 预处理 → 脚本执行 → LLM 后处理                                    |
| D-09 | Input Schema 校验             | P0     | 执行前校验输入是否符合 input_schema                                    |
| D-10 | 超时控制                      | P0     | Skill 级 + 全局默认，超时自动终止并返回错误                           |
| D-11 | 执行记录持久化                | P0     | 每次 Skill 调用记录写入 `skill_execution_records` 表                   |
| D-12 | Token 计量                    | P0     | LLM 路径记录 prompt_tokens + completion_tokens                         |
| D-13 | 流式 LLM 输出                 | P1     | 支持 Skill 以流式方式返回 LLM 内容（通过 EventBus 推送 chunks）       |
| D-14 | AbortSignal 支持              | P0     | 支持通过 AbortSignal 取消正在执行的 Skill                              |

#### D.4 沙箱安全要求

| 安全项             | 要求                                                       |
| ------------------ | ---------------------------------------------------------- |
| 进程隔离           | 独立 PID，不继承父进程句柄                                 |
| 环境变量           | 仅注入白名单变量，不包含 API Key 等敏感信息                |
| 文件系统           | 工作目录限制在 Skill scripts/ 目录内                       |
| 网络访问           | 默认禁用，可通过配置白名单域名开放                         |
| 资源配额           | 内存上限 256MB，CPU 1 核（可配置）                         |
| 超时强杀           | 超时 → SIGTERM → 5s 宽限期 → SIGKILL                      |
| 危险 API 黑名单    | 脚本静态分析禁止 `eval`/`exec`/`rm -rf`/`process.exit` 等 |

#### D.5 验收标准

- `llm_only` Skill 正确组装 Prompt 并返回符合 output_schema 的结果。
- `script` Skill 在沙箱中执行 Python/Node 脚本，通过 stdin/stdout 传递 JSON。
- 脚本超时后 ≤ 10s 内被强制终止。
- Docker 模式下脚本无法访问宿主机文件系统和网络（白名单外）。
- 每次 Skill 执行产生完整的 `skill_execution_records` 数据库记录。

---

### 模块 E：Skill-Creator（智能体自我进化引擎）

#### E.1 功能概述

Skill-Creator 是 CORAL 平台内置的 Meta-Skill，允许用户通过自然语言描述来自动创建新的 Skill。新 Skill 经过沙箱验证和（可选的）人工审核后，通过热重载即刻可用。

**这是 CORAL 区别于传统工具平台的核心差异化能力——平台不仅消费 Skill，还能创造 Skill。**

#### E.2 完整工作流

```
                用户输入自然语言需求描述
                         │
                         ▼
        ┌────────────────────────────────┐
        │  Step 1: 需求理解               │
        │  LLM 分析用户描述，提取:         │
        │  - 功能目标                     │
        │  - 输入/输出定义                 │
        │  - 需要的外部依赖               │
        │  - 执行模式 (llm/script/hybrid) │
        └─────────────┬──────────────────┘
                      │
                      ▼
        ┌────────────────────────────────┐
        │  Step 2: 生成 SKILL.md          │
        │  自动生成:                       │
        │  - YAML Frontmatter (元数据)    │
        │  - Prompt 正文                   │
        │  - reference.md (如需要)         │
        └─────────────┬──────────────────┘
                      │
                      ▼
        ┌────────────────────────────────┐
        │  Step 3: 生成脚本代码（如需要）  │
        │  execution_mode == "script" 时: │
        │  - 生成 scripts/execute.py/ts   │
        │  - 生成 requirements.txt        │
        │  - 确保 stdin/stdout JSON 协议  │
        └─────────────┬──────────────────┘
                      │
                      ▼
        ┌────────────────────────────────┐
        │  Step 4: 沙箱自动验证           │
        │  4a. Frontmatter 合法性校验     │
        │  4b. 脚本语法检查               │
        │  4c. 使用模拟输入在沙箱中执行   │
        │  4d. 校验输出是否符合 Schema    │
        │  4e. 如有错误 → 自动修复重试    │
        │      (最多 3 轮 Self-Correction) │
        └─────────────┬──────────────────┘
                      │
                      ▼
        ┌────────────────────────────────┐
        │  Step 5: 写入文件系统           │
        │  在 skills/ 创建新目录          │
        │  写入 SKILL.md + scripts/       │
        └─────────────┬──────────────────┘
                      │
                      ▼
        ┌────────────────────────────────┐
        │  Step 6: 审核流程（可选）        │
        │  SKILL_AUTO_APPROVE=true:       │
        │    → 跳过审核，直接生效          │
        │  SKILL_AUTO_APPROVE=false:      │
        │    → 等待管理员审批              │
        └─────────────┬──────────────────┘
                      │
                      ▼
        ┌────────────────────────────────┐
        │  Step 7: 热重载生效             │
        │  文件系统 watcher 自动检测       │
        │  新 Skill 进入注册表             │
        │  所有用户即刻可用                │
        └────────────────────────────────┘
```

#### E.3 功能需求列表

| ID   | 需求                             | 优先级 | 说明                                                                   |
| ---- | -------------------------------- | ------ | ---------------------------------------------------------------------- |
| E-01 | 自然语言需求输入                 | P0     | 用户以自然语言描述新 Skill 功能，支持附带示例输入/输出                 |
| E-02 | LLM 需求分析                    | P0     | 自动判断 execution_mode、识别依赖、定义 Schema                         |
| E-03 | SKILL.md 自动生成                | P0     | 生成完整 Frontmatter + Prompt 正文                                     |
| E-04 | reference.md 自动生成            | P1     | 如需要参考资料，自动生成并写入                                         |
| E-05 | 脚本代码自动生成                 | P0     | 生成符合 stdin/stdout JSON 协议的脚本代码                              |
| E-06 | 依赖声明自动生成                 | P1     | 生成 requirements.txt 或 package.json（仅允许白名单依赖）              |
| E-07 | 沙箱自动验证                     | P0     | 生成模拟输入 → 在沙箱中执行 → 校验输出                                |
| E-08 | Self-Correction                  | P0     | 沙箱验证失败时 LLM 自动分析错误并修改代码，最多 3 轮                  |
| E-09 | 文件系统写入                     | P0     | 验证通过后在 skills/ 创建新 Skill 目录及全部文件                       |
| E-10 | 审核流程控制                     | P0     | 根据 `SKILL_AUTO_APPROVE` 配置决定是否需要人工审核                     |
| E-11 | 创建过程事件推送                 | P0     | 每个步骤通过 EventBus 推送进度事件，前端实时展示                       |
| E-12 | 依赖安全白名单                   | P0     | 脚本依赖必须在平台白名单内，禁止任意 pip/npm install                   |
| E-13 | 创建记录审计                     | P0     | 完整记录创建请求、LLM 推理过程、验证结果到审计日志                     |
| E-14 | 已有 Skill 参考                  | P1     | 创建时可指定参考已有 Skill（结构/风格借鉴）                            |

#### E.4 Self-Correction 循环详细流程

```
生成代码 v1
    │
    ▼
沙箱执行测试
    │
    ├── 通过 ✓ → 进入下一步
    │
    └── 失败 ✗ → 收集错误信息
                    │
                    ▼
            ┌─────────────────────────────────┐
            │ LLM 接收:                        │
            │ - 原始代码 v1                    │
            │ - 错误信息（stderr / 校验失败）   │
            │ - output_schema 要求              │
            │                                  │
            │ 输出:                             │
            │ - 修正后的代码 v2                 │
            │ - 修正说明                        │
            └──────────────┬──────────────────┘
                           │
                           ▼
                    沙箱执行测试 (v2)
                           │
                    ├── 通过 ✓
                    └── 失败 → 重复（最多 3 轮）
                                │
                        3 轮仍失败 → 返回错误报告
                        建议用户手动调整或提供更多信息
```

#### E.5 输入/输出定义

**创建请求**：

```typescript
interface SkillCreationRequest {
  description: string;                     // 自然语言功能描述（必填）
  exampleInput?: Record<string, any>;      // 示例输入
  exampleOutput?: Record<string, any>;     // 期望输出
  constraints?: string[];                  // 额外约束
  referenceSkills?: string[];              // 参考已有 Skill 名称
  preferredRuntime?: "python3" | "node";   // 首选脚本运行时
}
```

**创建结果**：

```typescript
interface SkillCreationResult {
  success: boolean;
  skillName: string;                       // 新 Skill 名称
  skillPath: string;                       // 文件系统路径
  validation: {
    frontmatterValid: boolean;
    schemaValid: boolean;
    sandboxTestPassed: boolean;
    correctionRounds: number;              // Self-Correction 执行了几轮
    errors: string[];                      // 最终仍存在的错误（如有）
  };
  reviewStatus: "auto_approved" | "pending_review";
  generatedFiles: string[];                // 生成的文件列表
  reasoning: string;                       // LLM 的设计推理
}
```

#### E.6 验收标准

- 用户输入 "帮我创建一个 Skill，读取 URL 提取所有表格数据转成 JSON"，系统自动生成完整的 Skill 目录。
- 生成的 SKILL.md Frontmatter 包含所有必填字段且合法。
- 生成的脚本可在沙箱中成功执行，输出符合 output_schema。
- Self-Correction 在脚本存在语法错误时能自动修复（至少 80% 成功率）。
- 新创建的 Skill 在 ≤ 5s 内出现在注册表中（热重载）。
- 创建过程的每个步骤通过 WebSocket 推送进度事件到前端。

---

### 模块 F：并发执行监控看板

#### F.1 功能概述

提供实时可视化界面，展示任务执行的 DAG 图、Agent 状态、Skill 调用时间线和系统总览指标。

#### F.2 页面信息架构

```
导航栏:
├── 控制台（Dashboard）         # 系统总览
├── 任务中心（Tasks）           # 任务列表 + 详情
├── Skills 浏览                 # 已注册 Skill 列表
├── Skill 工坊（Creator）       # 创建新 Skill
├── 对话（Chat）                # Planning Engine 入口
└── 设置                        # 系统配置
```

#### F.3 功能需求列表

| ID   | 需求                        | 优先级 | 说明                                                                 |
| ---- | --------------------------- | ------ | -------------------------------------------------------------------- |
| F-01 | Dashboard 系统总览          | P0     | 展示活跃任务数、Skill 数量、成功率、系统健康                        |
| F-02 | 任务列表页                  | P0     | 分页展示所有任务，支持按状态筛选                                     |
| F-03 | 任务详情 — DAG 可视化       | P0     | 以图形化方式展示 Agent DAG，节点颜色表示状态                         |
| F-04 | 任务详情 — Agent 状态实时流 | P0     | WebSocket 推送 Agent 状态变更，DAG 图实时更新                        |
| F-05 | 任务详情 — Skill 调用时间线 | P1     | 甘特图式展示每个 Skill 的执行时间段和结果                            |
| F-06 | 任务详情 — 人工审批面板     | P0     | Human Gate 触发时展示审批请求，提供 approve/reject 操作              |
| F-07 | 任务详情 — 日志流           | P1     | 实时展示 Task 相关的所有事件日志                                     |
| F-08 | Skill 列表页                | P0     | 展示所有已注册 Skill，包含 domain、status、调用统计                  |
| F-09 | Skill 详情页                | P1     | 展示 Skill 元数据、Prompt 摘要、调用统计图表                        |
| F-10 | Skill 测试执行              | P1     | 在页面内输入 JSON 测试 Skill 执行并查看结果                         |
| F-11 | Chat/Planning 入口          | P0     | 自然语言输入框 → 创建 Task → 自动跳转 Task 详情监控                 |
| F-12 | Skill Creator UI            | P0     | 多步骤表单：描述输入 → 进度展示 → 结果预览 → 确认发布              |
| F-13 | 实时事件推送                | P0     | WebSocket 连接，订阅指定 Task 的事件流                               |
| F-14 | 断线重连                    | P0     | WebSocket 断线后自动重连 + 降级轮询                                  |
| F-15 | 取消任务操作                | P0     | 任务详情页提供"取消"按钮，调用 Task cancel API                       |
| F-16 | 设置页 — LLM 配置           | P0     | 配置 LLM Provider URL、Model、API Key（遮罩显示）                    |
| F-17 | 设置页 — 平台配置           | P1     | 展示/修改并发限制、超时、沙箱模式等运行时配置                        |

#### F.4 DAG 可视化要求

```
┌───────────────────────────────────────────────┐
│              Task: "分析这批数据..."            │
│              Status: executing                  │
│                                                 │
│    ┌────────┐         ┌────────┐               │
│    │Agent A │────────→│Agent C │               │
│    │ ✅完成  │         │ ⏳运行中│               │
│    └────────┘    ┌───→└────────┘               │
│                  │                              │
│    ┌────────┐    │                              │
│    │Agent B │────┘                              │
│    │ ✅完成  │                                   │
│    └────────┘                                   │
│                                                 │
│  时间线: ━━━A━━━━━━━━━━━━━━━━━━                  │
│          ━━━━━B━━━━━━━━━━━━━━━━                  │
│          ────────────━━━C━━━━━━ (进行中)         │
└───────────────────────────────────────────────┘
```

节点状态对应颜色：

| 状态        | 颜色   |
| ----------- | ------ |
| `pending`   | 灰色   |
| `running`   | 蓝色   |
| `suspended` | 黄色   |
| `completed` | 绿色   |
| `failed`    | 红色   |
| `cancelled` | 灰黑色 |

#### F.5 验收标准

- Dashboard 首屏 TTI ≤ 2.5s。
- DAG 可视化正确渲染 Agent 节点和依赖边。
- Agent 状态变更后 ≤ 2s 在 DAG 图中体现颜色更新。
- WebSocket 断线后 ≤ 20s 自动降级轮询。
- Skill Creator 页面完整展示创建进度的每个步骤。
- 任务列表支持 1000+ 条数据流畅滚动（≥ 50 FPS）。

---

### 模块 G：事件系统与审计

#### G.1 功能概述

全链路事件系统，覆盖 Task/Agent/Skill/HumanGate/System 所有状态变更。事件同时用于实时推送（WebSocket/SSE）和审计持久化（PostgreSQL）。

#### G.2 事件类型全集

| 分类       | 事件类型                                                                           |
| ---------- | ---------------------------------------------------------------------------------- |
| Task       | `task.created` / `task.planning` / `task.plan_ready` / `task.executing` / `task.completed` / `task.failed` / `task.cancelled` |
| Agent      | `agent.spawned` / `agent.started` / `agent.suspended` / `agent.resumed` / `agent.completed` / `agent.failed` / `agent.cancelled` |
| Skill      | `skill.executing` / `skill.completed` / `skill.failed`                            |
| Sandbox    | `skill.sandbox_started` / `skill.sandbox_finished`                                 |
| Human Gate | `human_gate.waiting` / `human_gate.approved` / `human_gate.rejected` / `human_gate.timeout` |
| Registry   | `skill.registered` / `skill.updated` / `skill.removed` / `skill.reload_failed`   |
| System     | `system.error` / `system.warning`                                                  |

#### G.3 功能需求列表

| ID   | 需求                   | 优先级 | 说明                                                             |
| ---- | ---------------------- | ------ | ---------------------------------------------------------------- |
| G-01 | 进程内 EventBus        | P0     | 同步/异步发布订阅，支持通配符订阅（如 `agent.*`）               |
| G-02 | 事件持久化到 PostgreSQL | P0     | 所有事件写入 `audit_logs` 表                                     |
| G-03 | WebSocket 推送         | P0     | 客户端可订阅指定 taskId 的事件流                                 |
| G-04 | SSE 兼容通道           | P1     | 兼容不支持 WebSocket 的客户端                                    |
| G-05 | 历史事件查询 API       | P0     | `GET /api/events?taskId=&type=&from=&to=`                       |
| G-06 | 事件回放               | P1     | 支持按 taskId 回放完整事件流，用于调试和审计                     |
| G-07 | Token/成本聚合         | P1     | 按 Task/Skill 维度聚合 Token 消耗和成本                         |

#### G.4 验收标准

- 每个 Task 执行过程产生的所有状态变更均有对应 audit_log 记录。
- WebSocket 订阅后 ≤ 1s 内收到状态变更事件。
- 历史事件查询支持按 taskId + 时间范围 + 事件类型组合过滤。
- Token 消耗按 Task 和 Skill 维度正确聚合。

---

## 3. API 设计

### 3.1 核心 API 列表

```
# ─────── 系统 ───────
GET    /api/health                              # 健康检查
GET    /api/config                              # 获取平台配置

# ─────── Task 管理 ───────
POST   /api/tasks                               # 创建任务（提交 goal）
GET    /api/tasks                               # 任务列表（分页+筛选）
GET    /api/tasks/:taskId                       # 任务详情（含 DAG + Agents）
POST   /api/tasks/:taskId/cancel                # 取消任务
POST   /api/tasks/:taskId/retry                 # 从失败点重试

# ─────── Human Gate ───────
GET    /api/tasks/:taskId/gates                 # 获取待审批列表
POST   /api/tasks/:taskId/gates/:gateId/approve # 审批通过
POST   /api/tasks/:taskId/gates/:gateId/reject  # 审批拒绝

# ─────── Skill 查询 ───────
GET    /api/skills                              # Skill 列表（筛选: domain, status, tag）
GET    /api/skills/:name                        # Skill 详情
POST   /api/skills/:name/test                   # 测试执行 Skill
GET    /api/skills/:name/stats                  # Skill 调用统计

# ─────── Skill Creator ───────
POST   /api/skill-creator/create                # 提交创建请求
GET    /api/skill-creator/status/:requestId     # 查询创建进度

# ─────── 事件 ───────
GET    /api/events                              # 历史事件查询
GET    /api/events/stream                       # SSE 实时事件流
WS     /ws/events                               # WebSocket 实时事件流

# ─────── Chat/Planning ───────
POST   /api/chat                                # 自然语言目标 → 创建 Task + 开始规划

# ─────── Scenario Pack ───────
GET    /api/scenarios                           # 已加载场景包列表
GET    /api/scenarios/:name                     # 场景包详情

# ─────── LLM 配置 ───────
GET    /api/config/llm                          # 获取 LLM 配置（Key 遮罩）
POST   /api/config/llm                          # 更新 LLM 配置
POST   /api/config/llm/test                     # 联通性测试
```

### 3.2 核心 API 详细定义

#### POST /api/tasks — 创建任务

**Request**:
```json
{
  "goal": "从以下 3 个 URL 提取表格数据并合并为一个汇总报告",
  "constraints": {
    "urls": ["https://example.com/a", "https://example.com/b", "https://example.com/c"],
    "outputFormat": "markdown"
  }
}
```

**Response** (201):
```json
{
  "taskId": "task_abc123",
  "status": "planning",
  "createdAt": "2026-04-02T10:00:00Z"
}
```

#### POST /api/skill-creator/create — 创建新 Skill

**Request**:
```json
{
  "description": "读取指定 URL 页面，提取其中所有表格数据，输出结构化 JSON",
  "exampleInput": { "url": "https://example.com/data" },
  "exampleOutput": { "tables": [{ "headers": ["col1"], "rows": [["val1"]] }] },
  "preferredRuntime": "python3"
}
```

**Response** (202):
```json
{
  "requestId": "req_xyz789",
  "status": "processing",
  "estimatedDurationMs": 60000
}
```

后续通过 `GET /api/skill-creator/status/req_xyz789` 或 WebSocket 事件获取创建进度。

---

## 4. 非功能性需求

### 4.1 性能

| 指标                       | 目标                          |
| -------------------------- | ----------------------------- |
| Planning 规划延迟          | Fast Path ≤ 500ms, LLM ≤ 15s |
| Agent 调度开销             | ≤ 50ms（不含执行）           |
| 单任务最大并发 Agent       | 20+（可配置）                 |
| 平台并发任务               | 100+                          |
| Skill 热重载延迟           | ≤ 2s                          |
| 事件推送延迟               | ≤ 1s (P95)                    |
| LLM 流式首字               | ≤ 3s                          |
| 前端首屏 TTI               | ≤ 2.5s                        |

### 4.2 可靠性

| 机制             | 说明                                                   |
| ---------------- | ------------------------------------------------------ |
| Task 断点续跑    | 进程重启后从 PostgreSQL 恢复未完成 Task 状态           |
| Agent 重试       | 指数退避，可配置最大重试次数                           |
| Skill 熔断       | 连续失败超阈值自动标记 deprecated                      |
| 沙箱超时强杀     | SIGTERM → 5s → SIGKILL                                 |
| 数据库事务       | Agent 状态更新使用事务保证一致性                       |

### 4.3 安全

| 层面             | 措施                                                     |
| ---------------- | -------------------------------------------------------- |
| API 鉴权         | API Key / JWT Token                                      |
| 角色权限         | RBAC（管理员 / 操作员 / 只读用户）                       |
| LLM Key          | 仅服务端持有，前端不暴露                                 |
| 沙箱隔离         | 进程级/容器级隔离 + 网络限制 + 资源配额                  |
| 审计             | 全链路事件不可篡改持久化                                 |
| 输入校验         | 所有 API 入参通过 JSON Schema 校验                       |

### 4.4 可观测性

| 维度     | 内容                                                     |
| -------- | -------------------------------------------------------- |
| 指标     | 任务吞吐率、成功率、P95 延迟、Skill 调用次数、Token 消耗 |
| 日志     | 结构化日志，含 traceId / taskId / agentId                |
| 事件     | Task/Agent/Skill/HumanGate 全覆盖事件流                 |
| 告警     | Skill 连续失败、任务队列堆积、LLM 延迟异常              |

---

## 5. 业务目标与成功指标

| KPI                        | 目标       |
| -------------------------- | ---------- |
| 任务成功率                 | ≥ 95%      |
| Skill 执行成功率           | ≥ 98%      |
| 并发任务吞吐（对比串行）   | ≥ 3x 提升  |
| P95 端到端时延降低         | ≥ 40%      |
| Skill-Creator 一次成功率   | ≥ 70%      |
| Skill-Creator 三轮内成功率 | ≥ 90%      |
| 平台可用性                 | ≥ 99.9%    |
| 关键事件审计覆盖率         | 100%       |

---

## 6. 里程碑计划

### M0：基座准备（1 周）

| 交付物                        | 说明                                               |
| ----------------------------- | -------------------------------------------------- |
| 项目重命名 CORAL              | 包名、README、配置全部更新                         |
| PostgreSQL 引入               | Drizzle ORM + 迁移 + 核心表创建                    |
| 目录结构重组                   | 按新架构调整 server/src/ 目录                      |

### M1：文件系统 Skill 运行时（2 周）

| 交付物                        | 说明                                               |
| ----------------------------- | -------------------------------------------------- |
| SKILL.md 解析器                | gray-matter + JSON Schema 校验                     |
| 文件系统注册表                 | 内存 Map + chokidar watcher + 热重载              |
| Skill 执行器（LLM 路径）      | Prompt 组装 + LLM 调用 + 输出校验                  |
| 现有 Skill 迁移               | 将已有 TypeScript Skill 迁移为 SKILL.md 格式       |
| Skill API                     | `GET /api/skills`, `GET /api/skills/:name`         |

### M2：DAG 调度引擎（3 周）

| 交付物                        | 说明                                               |
| ----------------------------- | -------------------------------------------------- |
| DAG Scheduler                 | 拓扑排序 + 并发执行 + 入度驱动调度                 |
| Agent Runner                  | 单 Agent 执行器（调用 Skills + 超时 + 重试）       |
| Worker Pool                   | 并发控制 + 优先级队列                              |
| EventBus                      | 进程内发布订阅 + 事件持久化到 PostgreSQL            |
| Human Gate                    | 挂起/审批/恢复 + 超时自动拒绝                      |
| Task API                      | 创建/查询/取消/审批                                |
| WebSocket 事件推送             | 任务级事件订阅                                     |

### M3：Planning Engine + Chat（2 周）

| 交付物                        | 说明                                               |
| ----------------------------- | -------------------------------------------------- |
| Fast Path 规则引擎            | 简单任务快速匹配                                   |
| LLM Planning                  | 复杂任务 LLM 规划 DAG                             |
| Plan Validator                | DAG 校验 + Skill 存在性检查                        |
| Chat API                      | `POST /api/chat` → 创建 Task + 规划               |
| Replanner                     | 失败后局部重规划                                   |

### M4：Script Sandbox + Skill-Creator（2 周）

| 交付物                        | 说明                                               |
| ----------------------------- | -------------------------------------------------- |
| Script Sandbox（进程级）      | 子进程沙箱执行 + stdin/stdout JSON                 |
| Docker Sandbox（可选）        | Docker 容器隔离执行                                |
| Skill-Creator Meta-Skill     | 自然语言 → SKILL.md + scripts/ 自动生成            |
| Self-Correction 循环          | 沙箱验证 + 错误自动修复                            |
| 安全审查流程                   | 静态分析 + 沙箱试运行 + 审批                       |

### M5：前端监控看板（3 周）

| 交付物                        | 说明                                               |
| ----------------------------- | -------------------------------------------------- |
| Dashboard 重构                | 系统总览 + 活跃任务 + 健康指标                     |
| 任务列表 + 详情               | DAG 可视化 + 实时状态更新 + 日志流                 |
| Skills 浏览 + 详情            | Skill 卡片列表 + 元数据展示 + 调用统计             |
| Skill Creator 页面            | 多步骤交互 + 进度展示 + 结果预览                   |
| Chat 入口页面                 | 自然语言输入 → Task 创建 → 跳转监控                |
| WebSocket 集成                | useTaskEvents Hook + 断线重连 + 降级轮询           |

### M6：Scenario Pack 框架（2 周）

| 交付物                        | 说明                                               |
| ----------------------------- | -------------------------------------------------- |
| Scenario Pack 加载器          | 扫描/解析/注册场景包                               |
| SCENARIO.md 规范              | 场景包元数据标准                                   |
| Skills 符号链接                | 场景包 Skills 自动链接到主 skills/ 目录            |
| DAG 模板注册                   | 场景预设 DAG 注册到 Fast Path                      |
| 示例场景包                     | 将现有政策分析逻辑迁移为示例 Scenario Pack          |

---

## 7. 验收标准总览

### 7.1 平台内核验收

| 编号    | 验收项                  | 标准                                                           |
| ------- | ----------------------- | -------------------------------------------------------------- |
| AC-01   | Skill 文件系统注册      | 新增/修改/删除 SKILL.md 后 ≤ 2s 注册表自动更新                |
| AC-02   | LLM Skill 执行          | llm_only Skill 正确组装 Prompt 并返回符合 Schema 的结果        |
| AC-03   | Script Skill 沙箱执行   | script Skill 在沙箱中执行，stdin/stdout JSON 通信正常          |
| AC-04   | DAG 并发调度            | 无依赖 Agent 真并行，总耗时接近 max(A, B)                      |
| AC-05   | Agent 状态机            | 完整支持 pending → running → completed/failed/suspended → 恢复  |
| AC-06   | Planning Engine         | 复杂任务 ≤ 15s 输出合法 DAG                                    |
| AC-07   | Human Gate              | 审批请求前端可见，approve 后 Agent 自动恢复                    |
| AC-08   | 事件全覆盖              | 每个状态变更均有对应 audit_log 记录                            |
| AC-09   | 热重载                  | SKILL.md 修改后无需重启即生效                                  |
| AC-10   | 任务取消                | 取消后 ≤ 5s 所有 Agent 停止                                    |

### 7.2 Skill-Creator 验收

| 编号    | 验收项                  | 标准                                                           |
| ------- | ----------------------- | -------------------------------------------------------------- |
| AC-11   | 自然语言创建 Skill      | 输入描述 → 自动生成完整 Skill 目录                             |
| AC-12   | 沙箱自动验证            | 生成代码在沙箱中成功执行且输出合规                             |
| AC-13   | Self-Correction         | 代码错误时 ≤ 3 轮自动修复                                      |
| AC-14   | 热加载生效              | 创建完成后 ≤ 5s 新 Skill 可被其他 Task 使用                    |
| AC-15   | 审核流程                | 非自动审批模式下需管理员确认后方可生效                         |

### 7.3 前端验收

| 编号    | 验收项                  | 标准                                                           |
| ------- | ----------------------- | -------------------------------------------------------------- |
| AC-16   | DAG 可视化              | 正确渲染 Agent 节点和依赖边，状态颜色实时更新                  |
| AC-17   | 实时事件推送            | 状态变更 ≤ 2s 在前端可见                                       |
| AC-18   | 断线重连                | WebSocket 断线 ≤ 20s 降级轮询                                  |
| AC-19   | 大列表性能              | 1000+ 条任务滚动 ≥ 50 FPS                                      |
| AC-20   | Skill Creator UI        | 创建进度每步骤实时展示                                         |

### 7.4 场景零耦合验收

| 编号    | 验收项                  | 标准                                                           |
| ------- | ----------------------- | -------------------------------------------------------------- |
| AC-21   | 代码零耦合              | 平台内核代码中搜索不到任何业务域关键词（"政策"/"公文"等）      |
| AC-22   | 场景可插拔              | 添加/移除 Scenario Pack 不需修改平台内核代码                   |
| AC-23   | 换场景不改底座          | 完全不同的场景（如"合同审查"）仅需新 Scenario Pack 即可运行    |

---

## 8. 风险与缓解

| 风险                             | 影响     | 缓解策略                                                       |
| -------------------------------- | -------- | -------------------------------------------------------------- |
| LLM 规划输出不稳定               | 任务失败 | 结构化 JSON Schema 约束 + 输出校验 + 重试 + fallback Fast Path |
| 外部脚本不可控                   | 安全风险 | 沙箱隔离 + 静态分析 + 审核流程 + 资源配额                     |
| 并发竞态导致状态不一致           | 数据错误 | PostgreSQL 事务 + Agent 状态机 + 乐观锁                       |
| Skill-Creator 生成质量低         | 体验差   | Self-Correction + 人工审核兜底 + 参考已有 Skill                |
| 文件系统监控在高频变更下不稳定   | 注册表异常 | 防抖 + 校验前置 + 定期全量同步兜底                            |
| LLM Token 成本不可控             | 预算超支 | Token 计量 + 配额限制 + 成本告警                               |

---

## 9. 开放问题

| 编号 | 问题                                           | 当前建议                                       |
| ---- | ---------------------------------------------- | ---------------------------------------------- |
| Q1   | 多实例部署时 skills/ 目录如何同步               | 使用共享存储（NFS/S3 FUSE），后续可引入 Git 同步 |
| Q2   | Skill 脚本的 npm/pip 依赖如何安装               | 白名单机制 + 预构建 Docker 镜像                 |
| Q3   | 是否需要 Skill 版本管理（同名 Skill 多版本共存）| 当前版本号仅记录，不共存；后续可引入版本路由    |
| Q4   | Planning Engine 用专用模型还是共享              | 建议可独立配置 `PLANNING_MODEL`                |
| Q5   | 是否需要 Worker Threads 替代 Promise 并发       | Promise 并发足够，密集计算场景再引入 Worker      |
| Q6   | Scenario Pack 是否需要独立的 npm 包管理         | 当前简单目录即可，后续可引入 npm pack 标准       |

---

## 附录：术语表

| 术语              | 定义                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| **CORAL**         | 平台项目名（原 HiAgent），通用智能体运行时平台                            |
| **Skill**         | 最小可执行能力单元，由 `skills/<name>/SKILL.md` 声明                     |
| **SKILL.md**      | Skill 核心定义文件，YAML Frontmatter (元数据) + Markdown Body (Prompt)   |
| **Agent**         | 任务执行者实例，被分配一组 Skills，有完整生命周期状态机                   |
| **Task**          | 用户提交的顶层工作单元，包含自然语言目标和约束                           |
| **ExecutionPlan** | 由 Planning Engine 生成的 DAG 执行计划                                   |
| **DAG**           | 有向无环图（Directed Acyclic Graph），描述 Agent 间的依赖关系            |
| **Sandbox**       | Skill 脚本的隔离执行环境（进程级或容器级）                               |
| **Human Gate**    | 需要人工审批/确认的执行关卡                                               |
| **Scenario Pack** | 面向特定业务场景的 Skills + DAG 模板 + UI 扩展打包                       |
| **Fast Path**     | 预定义的简单任务直接执行路径，跳过 LLM 规划                             |
| **Skill-Creator** | 内置 Meta-Skill，AI 自动生成新 Skill 的自我进化引擎                     |
| **Self-Correction** | Skill-Creator 的自动修复机制，沙箱验证失败时 LLM 自动修复代码          |

---

*文档结束 — CORAL 平台底座产品需求文档 V1.0*
