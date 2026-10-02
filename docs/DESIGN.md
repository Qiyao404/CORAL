# CORAL 平台升级 — 设计文档

> 版本：**v1.1.0**（rev 2 + impl 2026-04-25）  日期：2026-04-25  状态：**已实现**
> 关联文档：[需求文档 REQUIREMENTS.md](./REQUIREMENTS.md) ｜ [任务文档 TASKS.md](./TASKS.md) ｜ [快速使用 USE.md](../USE.md) ｜ [作者指南 AUTHORING_PROGRESS.md](./AUTHORING_PROGRESS.md) ｜ [视觉指南 DESIGN_SYSTEM_USAGE.md](./DESIGN_SYSTEM_USAGE.md)
>
> **rev 2 新增章节**：§5b（与 skill-creator 对比） §16（视觉设计系统） §17（公司画像） §18（information-filter Skill） §19（组合任务理解与参数提取） §20（React-Flow DAG 可视化）
>
> **impl 落地映射**（与代码对应关系）：
> - §3 数据模型 → `packages/server/src/types/index.ts`
> - §4 CORAL_PROGRESS 协议 → `packages/server/src/skill-runtime/progress-parser.ts` + `skills/_lib/coral_progress.py`
> - §5 Skill Builder → `services/skill-builder-service.ts` + `api/skill-builder.routes.ts` + `pages/SkillBuilderPage.tsx`
> - §6 Skill CRUD → `api/skill.routes.ts` + `skill-runtime/skill-writer.ts` + `pages/SkillsPage.tsx`
> - §7 进度事件管道 → `event-bus.ts`（audit 过滤 volatile）+ `skill-executor.ts`（流式 + stderr 解析）+ `api/event.routes.ts`（SSE）
> - §8 / §9 政策双 Skill → `skills/policy-scraper/scripts/scrape.py` + `skills/policy-to-post/scripts/convert.py`
> - §17 公司画像 → `services/company-profile-service.ts` + `api/company-profile.routes.ts`
> - §18 information-filter → `skills/information-filter/`
> - §19 组合任务规划 → `planning/planning-engine.ts` + `scheduler/dag-scheduler.ts`（cascadeSkip）
> - §20 React-Flow DAG → `packages/web/src/components/dag/AgentDag.tsx`

---

## 1. 设计目标

| 设计目标 | 对应需求 |
|----------|----------|
| **G1** 让 Skill 成为可对话生成的资产，而非只能写代码定义 | FR-A |
| **G2** 让 Skill 列表成为真正的"控制台"，对任何 Skill 增删改 | FR-B |
| **G3** 让用户在任意时刻能回答「现在在做什么、进度多少、产出了啥」 | FR-C / FR-F |
| **G4** 把两个政策 Skill 改造为"流式 + 双输入 + 双产物"标杆 | FR-D / FR-E |
| **G5** 不破坏现有 v1.0.0 架构，所有改动可回滚、可灰度 | NFR-9 / NFR-10 |
| **G6** 让平台理解组合任务，自动用多 Skill 协作完成 | FR-I |
| **G7** 让公司业务画像成为多 Skill 共享的语义上下文 | FR-G |
| **G8** 让平台外观和交互配得上"自动化多智能体"定位 | FR-J |

---

## 2. 总体架构

### 2.1 模块拓扑（升级后）

```
┌────────────────────────────────────────────────────────────────────┐
│                     接入层（Web Dashboard + API）                     │
│  ┌──────────┐ ┌──────────┐ ┌─────────────┐ ┌──────────┐ ┌────────┐│
│  │Dashboard │ │  Chat /  │ │SkillBuilder │ │  Skills  │ │ Tasks  ││
│  │+连接状态 │ │ Speech   │ │ (新增页面)  │ │CRUD+ 二确│ │+实时进度││
│  └──────────┘ └──────────┘ └─────────────┘ └──────────┘ └────────┘│
└─────────────────────┬─────────────────────────────────┬───────────┘
                      │                                 │
              [WebSocket /ws/events] ★主          [SSE /api/tasks/:id/stream] ★兜底
                      │                                 │
┌─────────────────────┴─────────────────────────────────┴───────────┐
│                        EventBus（升级）                              │
│  + skill.progress (新)                                              │
│  + skill.log      (新)                                              │
│  + skill.artifact (新)                                              │
│  + skill_builder.* (新)                                             │
└────────────┬──────────────────────────────────────────────────────┘
             │
   ┌─────────┴────────┬────────────────────────┐
   ▼                  ▼                        ▼
┌─────────────┐  ┌──────────────────┐  ┌────────────────────────┐
│ Planning    │  │   DAG Scheduler  │  │   Skill Builder Service │
│ Engine      │  │                  │  │   (新增模块)             │
│ (不变)      │  │   (不变)         │  │  - 多轮会话状态机        │
└─────────────┘  └────────┬─────────┘  │  - LLM 反问 / 生成草稿   │
                          │            │  - 写盘 + 注册表注入     │
                          ▼            └─────────┬──────────────┘
                ┌──────────────────┐             │
                │ SkillExecutor    │             │
                │ (升级)           │             │
                │ + 流式 LLM 调用  │             │
                │ + Stderr 解析    │             │
                │   (CORAL_PROG.)  │             │
                └────────┬─────────┘             │
                         │                       ▼
                         ▼          ┌──────────────────────────┐
              ┌────────────────┐    │  FilesystemRegistry +    │
              │  脚本子进程    │    │  SkillCrudService(新增)  │
              │ (含 stderr 协议)│   │  - update / delete       │
              └────────────────┘    │  - 二次确认守卫          │
                                    │  - 历史快照(.history/)   │
                                    └──────────────────────────┘
```

### 2.2 关键改动一览

| 模块 | 改动类型 | 说明 |
|------|---------|------|
| `EventBus` | 扩展 | 新增 3 类事件 + WS/SSE 双通道分发 |
| `SkillExecutor` | 重构 | LLM 路径改 streaming；Script 路径实时解析 stderr |
| `FilesystemSkillRegistry` | 扩展 | 增加 source 字段；提供 CRUD 钩子 |
| `Skill Builder Service` | 新建 | 多轮会话 + 草稿管理 + 落盘 |
| `Skill CRUD Routes` | 新建 | `PUT/DELETE /api/skills/:name` + builtin 守卫 |
| `policy-scraper/scrape.py` | 改造 | 输出 CORAL_PROGRESS + MD 产物 |
| `policy-to-post/convert.py` | 改造 | 双输入 + CORAL_PROGRESS |
| 前端 SkillsPage | 重构 | 新增编辑/删除 + 二确认 modal |
| 前端 TaskDetailPage | 重构 | 进度条 + 实时日志 + 产物列表 |
| 前端 SkillBuilderPage | 新建 | 多轮对话 + SKILL.md 实时预览 |

---

## 3. 数据模型

### 3.1 类型扩展（`packages/server/src/types/index.ts`）

```ts
// 在原 ParsedSkillManifest 上扩展
export interface ParsedSkillManifest {
  // ... 原有字段 ...
  source: 'builtin' | 'user';        // 新增；老 SKILL.md 缺省视为 builtin
  createdBy?: string;                 // 新增；user Skill 记录创建者
  creatorSessionId?: string;          // 新增；溯源到 SkillBuilder 会话
}

// 新增：CoralEventType 扩展
export type CoralEventType =
  | /* ...原有枚举... */
  | 'skill.progress'                  // 进度事件
  | 'skill.log'                       // 日志行
  | 'skill.artifact'                  // 中间产物
  | 'skill_builder.session_started'
  | 'skill_builder.message'
  | 'skill_builder.draft_updated'
  | 'skill_builder.committed'
  | 'skill_builder.failed';

// 新增进度事件 payload
export interface SkillProgressPayload {
  taskId: string;
  agentId: string;
  skillName: string;
  phase: string;                      // 如 "scraping" | "parsing" | "llm_call"
  step?: number;                      // 当前步骤
  total?: number;                     // 总步骤
  percent?: number;                   // 0-100
  message: string;                    // 人类可读的描述
  detail?: Record<string, any>;       // 扩展字段
}

// 新增日志事件 payload
export interface SkillLogPayload {
  taskId: string;
  agentId: string;
  skillName: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source: 'stdout' | 'stderr' | 'llm_stream';
}

// 新增产物事件 payload
export interface SkillArtifactPayload {
  taskId: string;
  agentId: string;
  skillName: string;
  artifact: {
    type: 'markdown' | 'csv' | 'json' | 'file' | 'text';
    name: string;
    path?: string;          // 服务器侧路径，前端可拼出下载 URL
    sizeBytes?: number;
    preview?: string;       // 前 1KB 预览
  };
}

// SkillBuilder 会话
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
  draftFilledFields: string[];        // 已确定的字段
  pendingFields: string[];            // 还需澄清的字段
  createdAt: string;
  updatedAt: string;
  committedSkillName?: string;        // 提交后填入
}
```

### 3.2 SKILL.md frontmatter 扩展

```yaml
---
name: my-skill
version: "1.0.0"
description: "..."
domain: ...
capabilities: [...]
input_schema: { ... }
output_schema: { ... }
execution_mode: llm_only
status: experimental
tags: [...]

# 新增字段（可选，缺省视为 builtin）
source: user                         # builtin | user
created_by: user-001                 # 创建者
creator_session_id: sess_xxx         # 溯源
---
```

### 3.3 持久化新增

```
data/
  └── skill_builder_sessions.json    # SkillBuilderSession 持久化
skills/
  └── <name>/
      ├── SKILL.md
      ├── scripts/
      ├── reference.md
      └── .history/                  # 编辑历史快照（可选 P2）
          └── 2026-04-25T103012.SKILL.md
```

---

## 4. CORAL_PROGRESS 协议（核心约定）

### 4.1 协议格式

脚本类 Skill 通过 **stderr** 输出**单行 JSON**，必须以前缀 `[CORAL_PROGRESS]` 标识：

```
[CORAL_PROGRESS] {"phase":"scraping","step":3,"total":8,"percent":37,"message":"正在抓取佛山政数局"}
```

字段定义：

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `phase` | string | ✅ | 当前阶段标识（自定义，如 `init`/`scraping`/`parsing`/`llm_call`/`writing`） |
| `step` | number | ❌ | 当前步骤（1-based） |
| `total` | number | ❌ | 总步骤数 |
| `percent` | number | ❌ | 0–100，前端进度条直接绑定 |
| `message` | string | ✅ | 人类可读描述 |
| `detail` | object | ❌ | 任意扩展数据（如 `{"site":"佛山政数局","items_found":12}`） |

### 4.2 普通日志兜底

stderr 中**非协议行**会被打包为 `skill.log` 事件，level 默认 `info`。stdout 仍按原约定承载 JSON 结果。

### 4.3 Python 端 helper（约定）

为了让脚本作者无需手写协议，在每个 Skill 的 `scripts/` 下统一约定一个工具函数（可由模板生成）：

```python
import json, sys

def emit_progress(phase: str, message: str, step=None, total=None, percent=None, **detail):
    payload = {"phase": phase, "message": message}
    if step is not None: payload["step"] = step
    if total is not None: payload["total"] = total
    if percent is not None: payload["percent"] = percent
    if detail: payload["detail"] = detail
    print(f"[CORAL_PROGRESS] {json.dumps(payload, ensure_ascii=False)}",
          file=sys.stderr, flush=True)
```

### 4.4 服务端解析

```ts
// SkillExecutor 中的 stderr 处理
child.stderr.on('data', chunk => {
  const lines = (buffer + chunk.toString()).split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    const m = line.match(/^\[CORAL_PROGRESS\]\s*(\{.*\})\s*$/);
    if (m) {
      try {
        const payload = JSON.parse(m[1]);
        eventBus.emit('skill.progress', { taskId, agentId, skillName, ...payload });
      } catch { /* 忽略 */ }
    } else if (line.trim()) {
      eventBus.emit('skill.log', {
        taskId, agentId, skillName,
        level: 'info', message: line, source: 'stderr'
      });
    }
  }
});
```

---

## 5. Skill Builder（多轮对话式创建）

### 5.1 状态机

```
   ┌────────────┐  user 描述需求  ┌──────────────┐
   │  IDLE      │ ──────────────▶ │ COLLECTING   │
   └────────────┘                 │ (LLM 反问)   │
                                  └──────┬───────┘
                                  全字段填齐│
                                          ▼
                                  ┌──────────────┐
                                  │ PREVIEWING   │
                                  │ (用户确认)   │
                                  └──┬─────┬─────┘
                                确认 │     │ 取消/重来
                                     ▼     ▼
                              ┌────────┐ ┌──────────┐
                              │COMMITTED│ │CANCELLED│
                              └────────┘ └──────────┘
```

### 5.2 LLM 反问 Prompt 模板

```
你是 CORAL 平台的 Skill 创建助手。你的任务是和用户进行多轮对话，
帮助他把一个能力需求转换成可执行的 SKILL.md。

# 当前已收集字段
{fields_filled}

# 还需澄清字段
{fields_pending}

# 用户最新输入
{user_message}

# 输出要求（严格 JSON，不要包含 ```json 标记）
{
  "reply": "你对用户的回复（中文，自然语气，可以追问）",
  "draft_updates": {
    "name": "...",
    "description": "...",
    "domain": "...",
    "capabilities": ["..."],
    "input_schema": { ... },
    "output_schema": { ... },
    "execution_mode": "llm_only|script|hybrid",
    "estimated_duration_ms": 30000,
    "tags": ["..."],
    "promptContent": "...",
    "scriptContent": "...(若 mode=script)"
  },
  "fields_pending": ["还需要用户回答的字段"],
  "ready_to_preview": false
}

# 反问优先级（自上而下逐项澄清）
1. name & description（用户没说就根据描述自动起名并征求确认）
2. execution_mode（默认 llm_only；明显是采集/转换/计算才推荐 script）
3. input_schema（关键参数 + 类型）
4. output_schema（产物结构）
5. tags & domain（可由 LLM 自动推断）

# 规则
- 一次只问 1-2 个问题，不要轰炸
- 当所有 P0 字段确定，输出 ready_to_preview: true
- 不要生成 SKILL.md 文本本身，只填 draft_updates
```

### 5.3 关键 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/skill-builder/sessions` | 创建会话 |
| GET | `/api/skill-builder/sessions/:id` | 获取会话（含 draft 与对话记录） |
| POST | `/api/skill-builder/sessions/:id/messages` | 用户发送一条消息，返回 AI 回复 + draft 更新 |
| GET | `/api/skill-builder/sessions/:id/preview` | 拼装出完整 SKILL.md 文本 |
| PATCH | `/api/skill-builder/sessions/:id/draft` | 用户手动修改 draft 字段 |
| POST | `/api/skill-builder/sessions/:id/commit` | 落盘到 `skills/<name>/` 并触发热重载 |
| DELETE | `/api/skill-builder/sessions/:id` | 取消会话 |

### 5.4 落盘流程（commit）

```
1. 校验 draft 完整性（name 不为空、execution_mode 合法、schema 符合 JSON Schema 子集）
2. 校验 name 唯一性（重名时返回 409；前端弹「覆盖/改名」选择）
3. 在临时目录构建产物：
   - SKILL.md（YAML frontmatter + promptContent + 可选 reference）
   - scripts/main.py（若 mode=script，把 scriptContent 写入）
4. 原子搬迁到 skills/<name>/（用 fs.rename 保证原子性）
5. 调用 registry.reloadSkill(name) 立即注册
6. emit 'skill_builder.committed' 事件 + 'skill.registered' 事件
7. 返回 { ok: true, skillName, skillDirPath }
```

### 5.5 安全校验

| 校验项 | 规则 |
|--------|------|
| 名称合法性 | `^[a-z][a-z0-9-]{1,40}$`（kebab-case） |
| 路径穿越 | 拒绝 name 含 `..` / `/` / `\` |
| 脚本内容长度 | scriptContent 上限 200KB |
| 写盘原子性 | 先写 `.tmp/<name>` 再 rename |
| 重名保护 | 默认 409；带 `?overwrite=true` 才覆盖 |

---

## 5b. 与 anthropics/skills/skill-creator 的对比与对齐

> 参考来源：[anthropics/skills/skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator)
> （目录结构：`SKILL.md` / `agents/` / `assets/` / `eval-viewer/` / `references/` / `scripts/` / `LICENSE.txt`）

CORAL 的 Skill Builder 在工程上直接借鉴了 skill-creator 的"渐进式生产 + 可评测"思路；但因为我们是**平台内置服务**而非"独立可分发 Skill"，所以做了适应性裁剪。

### 5b.1 关键概念映射

| anthropics/skill-creator | CORAL Skill Builder | 说明 |
|--------------------------|--------------------|------|
| `SKILL.md`（自身就是一个 Skill） | `services/skill-builder-service.ts` + 前端 SkillBuilderPage | 我们把"创建 Skill"做成平台一等公民服务，而非另一个 Skill |
| `agents/` 目录（创建专家、评测专家等） | LLM 多角色 prompt（草稿生成 + 字段校验 + 反问规划） | 对应在服务端用 prompt 段切分，未来可拆为独立 Skill |
| `references/` 目录（引导文档） | `skills/<name>/reference.md` + 平台 `docs/AUTHORING_*.md` | CORAL 同样支持 reference.md，并自动写入 |
| `scripts/` 目录（生成器/校验器脚本） | `packages/server/src/services/skill-builder/validators/*` + `progress-parser.ts` | 我们用 TypeScript 实现校验 + 协议解析 |
| `eval-viewer/`（结果对照查看器） | TaskDetailPage 中的"产物预览 + 测试面板" | 一期复用现有 Skill 测试面板，不另起 viewer |
| `assets/`（模板素材） | `skills/_lib/coral_progress.py` + 模板 fragment | 提供给生成的脚本 import |

### 5b.2 工程实践对齐点

| 方面 | skill-creator 做法 | CORAL 对齐方式 |
|------|--------------------|----------------|
| **渐进收集** | 多文件分阶段引导 | 多轮对话状态机 `collecting → previewing → committed` |
| **可评测** | 提供 eval 脚本与样例 | 提交后自动跑一次 dry-run 测试（默认输入），结果展示在 SkillBuilderPage |
| **可重现** | 会话日志保留 | 我们持久化 `SkillBuilderSession.conversation` 完整记录 + 关联到生成的 Skill 的 `creator_session_id` |
| **失败兜底** | 模板 fallback | LLM 反问失败时退回"表单填写"模式（用户直接编辑 frontmatter） |
| **可拓展** | 新增专家只需加一份 markdown | CORAL prompt 模板拆为 `system_prompt` + `field_specs[]` + `examples[]`，便于后续追加新字段 |

### 5b.3 故意没做的部分（与 skill-creator 的差异）

- ❌ **不引入 eval-viewer 独立页面**：复用 SkillsPage 的测试面板足以；后续若 Skill 数量大幅增长再单独立项。
- ❌ **不实现 agents/ 多专家分工**：当前所有逻辑在一个 prompt 内推理；当对话复杂度达到瓶颈后再拆分为多 Agent（如"分析师"+"工程师"+"评审"）。
- ❌ **不引入 LICENSE 元数据**：内部使用，统一遵循平台许可。

---

## 6. Skill CRUD（编辑/删除）

### 6.1 API 设计

| 方法 | 路径 | Body / Header | 说明 |
|------|------|---------------|------|
| GET | `/api/skills` | — | 列表（已有，新增 `source` 字段） |
| GET | `/api/skills/:name` | — | 详情（含完整 promptContent，已有） |
| PUT | `/api/skills/:name` | `{ frontmatter, promptContent, referenceContent?, scriptContent? }` Header: `X-Confirm-Builtin: <name>`（仅 builtin 必传） | 更新 SKILL.md（与 scripts） |
| DELETE | `/api/skills/:name` | Query: `?physical=true` 物理删除 Header: `X-Confirm-Builtin: <name>`（仅 builtin 必传） | 移除注册表，可选物理删除文件 |

### 6.2 Builtin 守卫

```ts
function requireBuiltinConfirm(skill: ParsedSkillManifest, header?: string) {
  if (skill.source === 'builtin') {
    if (header !== skill.name) {
      throw new HttpError(403, '内置 Skill 操作需要二次确认（请在请求头 X-Confirm-Builtin 写入 Skill 名）');
    }
  }
}
```

前端在弹窗中要求用户输入 Skill 名字才能点确认（防误操作）。

### 6.3 编辑流程（保留历史，P2）

```
PUT 收到请求
  └─ 读现有 SKILL.md → 拷贝到 .history/<timestamp>.SKILL.md
  └─ 写入新 SKILL.md
  └─ registry.reloadSkill(name)
  └─ emit 'skill.updated'
```

### 6.4 删除流程

```
DELETE 收到请求
  └─ 校验 builtin 守卫
  └─ registry.removeSkill(name)
  └─ if (physical=true) → 移动整个 skills/<name>/ 到 skills/.trash/<name>-<timestamp>/
  └─ emit 'skill.removed'
```

> 注：默认**只取消注册**（保留物理文件，便于恢复）；物理删除走回收站机制（避免误删）。

---

## 7. 进度事件管道与流式 LLM

### 7.1 LLM 流式调用改造

`packages/server/src/services/llm-client.ts` 增加 streaming 方法：

```ts
async completeStream(
  messages: ChatMessage[],
  onChunk: (delta: string) => void
): Promise<{ content: string; tokensUsed: number }> {
  const stream = await this.openai.chat.completions.create({
    model: this.model,
    messages,
    stream: true,
  });
  let full = '';
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || '';
    if (delta) {
      full += delta;
      onChunk(delta);
    }
  }
  return { content: full, tokensUsed: estimateTokens(full) };
}
```

`SkillExecutor.executeLlmOnly()` 中：

```ts
const { content } = await llmClient.completeStream(messages, (delta) => {
  eventBus.emit('skill.log', {
    taskId, agentId, skillName: manifest.name,
    level: 'info', message: delta, source: 'llm_stream',
  });
});
```

> Mock 模式下：分阶段假进度（按 estimatedDurationMs 等分时间，每 1s emit 一次 progress）。

### 7.2 SSE 端点

新增 `/api/tasks/:taskId/stream`：

```ts
app.get('/api/tasks/:taskId/stream', async (req, reply) => {
  const { taskId } = req.params;
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const handler = (event: CoralEvent) => {
    if (event.taskId === taskId) {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  };
  eventBus.on('*', handler);
  req.raw.on('close', () => eventBus.off('*', handler));
});
```

### 7.3 前端事件去重

```ts
const seenIds = useRef(new Set<string>());
function pushEvent(e: CoralEvent) {
  if (seenIds.current.has(e.eventId)) return;
  seenIds.current.add(e.eventId);
  setEvents(prev => [...prev.slice(-500), e]);
}
```

WS 事件 + SSE 事件统一进 `pushEvent`，按 `eventId` 去重。

---

## 8. policy-scraper 改造方案

### 8.1 进度埋点

| 阶段 | phase | step/total | message |
|------|-------|-----------|---------|
| 启动 | `init` | — | 「正在初始化采集环境…」 |
| 浏览器启动 | `init` | — | 「启动 Chrome…」 |
| 站点开始 | `scraping` | 当前/8 | 「[3/8] 佛山政数局 第 1 页」 |
| 翻页 | `scraping` | — | detail 含 `page_num` |
| 站点结束 | `scraping` | 当前/8 | 「[3/8] 佛山政数局 完成，共 12 条」 |
| 写出文件 | `writing` | — | 「写入 MD/CSV…」 |
| 完成 | `done` | 100% | 「全部完成，共 87 条」 |

### 8.2 MD 输出格式

```markdown
# 政策信息汇总（2026 年 3 月）

> 共 87 条，采集自 8 个机构，生成时间：2026-03-31 23:59:59

## 汇总

| 机构 | 条数 |
|------|-----|
| 佛山政数局 | 12 |
| 佛山住建局 | 8 |
| ... | ... |

---

## 佛山政数局（12 条）

### 关于印发《佛山市政务数据共享管理办法》的通知
- **发布日期**：2026-03-15
- **来源**：佛山政数局
- **链接**：<https://www.foshan.gov.cn/...>

### …
```

> CSV 仍按现有格式保留（向后兼容）。

### 8.3 output_schema 升级

```yaml
output_schema:
  type: object
  properties:
    md_path:
      type: string
      description: "Markdown 汇总报告路径"
    csv_path:
      type: string
      description: "CSV 数据文件路径"
    count:
      type: integer
    summary:
      type: object
      properties:
        by_site:
          type: object
          additionalProperties: { type: integer }
```

---

## 9. policy-to-post 改造方案

### 9.1 input_schema 升级

```yaml
input_schema:
  type: object
  oneOf:
    - required: [md_content]
    - required: [md_path]
    - required: [csv_path]
  properties:
    md_content:
      type: string
      description: "直接粘贴的 MD 文本（policy-scraper 格式或自定义）"
    md_path:
      type: string
      description: "MD 文件路径"
    csv_path:
      type: string
      description: "CSV 文件路径（向后兼容）"
    period_title:
      type: string
    output_path:
      type: string
```

### 9.2 MD 文本解析

`convert.py` 新增 `parse_md_content(md: str) -> List[PolicyItem]`：
- 识别 `### 标题` 作为政策标题
- 识别 `**发布日期**: YYYY-MM-DD`
- 识别 `**链接**: <url>` 或 markdown 链接
- 兼容 policy-scraper 输出格式

### 9.3 进度埋点

```python
emit_progress("init", "加载输入数据", percent=0)
emit_progress("init", f"共 {n} 条政策待处理", total=n)
for i, item in enumerate(items, 1):
    emit_progress("processing", f"[{i}/{n}] {item.title}",
                  step=i, total=n, percent=int(i/n*100))
    # 抓取正文
    emit_progress("fetching", "...", detail={"url": item.url})
    # LLM 解读
    emit_progress("llm_call", "...", detail={"item_index": i})
emit_progress("writing", "生成 MD 文件...", percent=95)
emit_progress("done", "完成", percent=100)
```

---

## 10. 前端设计

### 10.1 页面与路由

| 路径 | 页面 | 状态 |
|------|------|------|
| `/` | Dashboard | 增强：连接状态 / 运行中任务卡片 |
| `/tasks` | TasksPage | 增强：行内显示进度% |
| `/tasks/:taskId` | TaskDetailPage | 重构：Agent 进度条 + 实时日志 + 产物 |
| `/skills` | SkillsPage | 重构：编辑/删除按钮 + 二确认 + 来源筛选 |
| `/skill-builder` | SkillBuilderPage | **新增** |
| `/skill-builder/:sessionId` | 同上（恢复会话） | **新增** |
| `/chat` | ChatPage | 增强：「创建任务 / 创建技能」模式切换 + Web Speech 按钮 |
| `/settings` | SettingsPage | 不变 |

### 10.2 SkillBuilderPage 布局

```
┌──────────────────────────────────────────────────────────────┐
│  ← 返回 │  Skill Builder │  会话 ID: sess_xxxxx │  连接状态● │
├──────────────────────────────────────────────────────────────┤
│                                  │                            │
│   多轮对话区（ChatPage 风格）   │   SKILL.md 实时预览        │
│                                  │   (Monaco / CodeMirror)    │
│   ┌─AI: 你的技能叫什么名字？     │   ─────────────────────    │
│   ├─User: 小红书采集器           │   ---                      │
│   ├─AI: 好，name = xiaohongshu… │   name: xiaohongshu-...   │
│   │       接下来要登录吗？      │   description: ...         │
│   └─...                          │   ---                      │
│                                  │   # 你是…                  │
│   [文字输入框] [🎤语音] [发送]   │                            │
│                                  │                            │
├──────────────────────────────────┴────────────────────────────┤
│  字段进度: ✅name ✅desc ⏳input ⏳mode  [手动编辑] [取消] [预览][提交]│
└──────────────────────────────────────────────────────────────┘
```

### 10.3 SkillsPage 编辑/删除 UI

- 列表项右侧增加「···」菜单：编辑 / 测试 / 删除
- 点删除：
  - user：直接弹「确定删除？」
  - builtin：弹「警告：这是内置 Skill。请输入 `<name>` 确认」+ 文本框 + 必输入正确才能点确认
- 点编辑：进入抽屉式编辑面板（左侧 form 编辑 frontmatter，右侧编辑 prompt）
- 来源 tab：`全部 / 内置 / 用户`

### 10.4 TaskDetailPage 进度增强

每个 Agent 卡片：

```
┌──────────────────────────────────────────────────────┐
│ ● 政策采集智能体          状态: 运行中               │
│   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 62%  [3/8]      │
│   阶段: scraping · 正在抓取佛山政数局 (第 2 页)     │
│   skill: policy-scraper · 已耗时 2:15               │
└──────────────────────────────────────────────────────┘

[实时日志] ▼
─────────────────────────────────────────────────
10:12:33 [INFO] 启动浏览器...
10:12:35 [INFO] 访问: https://www.foshan.gov.cn/...
10:12:38 [INFO] 第 1 页找到 8 条目标数据
10:12:42 [INFO] 第 2 页找到 4 条目标数据
─────────────────────────────────────────────────

[产物] ▼
📄 政策信息_2026年3月.md  (12.3 KB)  [下载]
📊 政策信息_2026年3月.csv  (8.7 KB)  [下载]
```

### 10.5 useTaskStream Hook

新增统一 hook，封装 WS + SSE 双通道与去重：

```ts
function useTaskStream(taskId: string) {
  const [events, setEvents] = useState<CoralEvent[]>([]);
  const [progress, setProgress] = useState<Record<string, ProgressState>>({});
  // WS + SSE 各一份订阅，pushEvent 内 dedup
  // 派生 progress: 按 agentId 取最近一条 skill.progress
  return { events, progress, connected, transport };
}
```

### 10.6 Web Speech API 集成

```ts
const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
recognition.lang = 'zh-CN';
recognition.continuous = false;
recognition.onresult = (e) => setMessage(e.results[0][0].transcript);
```

不支持的浏览器隐藏麦克风按钮，给出提示。

---

## 11. 测试用例与验收标准

> **测试分级**：U=单元 / I=集成 / E=E2E（端到端）

### 11.1 Skill Builder（FR-A）

| 编号 | 级别 | 用例 | 输入 | 期望结果 | 验收标准 |
|------|:--:|------|------|---------|----------|
| TC-A1 | I | 创建会话 | POST `/api/skill-builder/sessions` `{userId:"u1"}` | 返回 sessionId 与 status=`collecting` | ✅ HTTP 201 |
| TC-A2 | I | 第一轮对话（仅描述） | `messages` body: `{content:"做个采集小红书帖子的工具"}` | reply 中含追问；draft.name 已填、execution_mode 已推断 | ✅ `fields_pending` 不为空 |
| TC-A3 | I | 多轮对话直到完整 | 5 轮以内回答 AI 反问 | `ready_to_preview=true` | ✅ draft 包含所有 P0 字段 |
| TC-A4 | I | 预览拼装 | GET `/preview` | 返回完整 SKILL.md 字符串 | ✅ 含合法 frontmatter + 正文 |
| TC-A5 | I | 落盘 | POST `/commit` | 文件 `skills/<name>/SKILL.md` 存在；注册表新增 1 条；发出 `skill.registered` 事件 | ✅ 3 项全部满足 |
| TC-A6 | I | 重名检测 | 已有 `summarize-document`，commit name=`summarize-document` 无 `?overwrite` | HTTP 409 | ✅ 错误码正确 |
| TC-A7 | I | 重名 + overwrite | 同上但 `?overwrite=true` | 写入成功 | ✅ 文件被覆盖 |
| TC-A8 | I | 路径穿越攻击 | name=`../etc/passwd` | HTTP 400 | ✅ 不写盘 |
| TC-A9 | U | LLM 输出非 JSON | 模拟 LLM 返回 markdown 代码块包裹 | 服务端能 strip 后 parse 成功 | ✅ 不抛异常 |
| TC-A10 | E | 业务用户全流程 | UI 上输入「我要采集小红书」→ 完成 5 轮对话 → 提交 | 列表中出现新 Skill；可在列表点击执行 | ✅ 总耗时 < 3 分钟 |

### 11.2 Skill CRUD（FR-B）

| 编号 | 级别 | 用例 | 期望结果 |
|------|:--:|------|---------|
| TC-B1 | I | 编辑 user Skill | PUT 不带 confirm header → 200，文件被修改 |
| TC-B2 | I | 编辑 builtin Skill 不带 confirm | PUT 无 `X-Confirm-Builtin` → 403 |
| TC-B3 | I | 编辑 builtin Skill 带 confirm | PUT `X-Confirm-Builtin: data-transform` → 200 |
| TC-B4 | I | 删除 user Skill（默认） | DELETE → 200，注册表已移除，物理文件保留 |
| TC-B5 | I | 删除 user Skill（physical） | DELETE `?physical=true` → 文件移到 `skills/.trash/` |
| TC-B6 | I | 删除 builtin 不带 confirm | DELETE → 403 |
| TC-B7 | E | UI 二次确认 | 点删除内置 Skill，弹窗输错名字 → 按钮置灰；输对名字 → 可点 |
| TC-B8 | I | 编辑后立即可调用 | PUT 后 ≤ 2 秒，新 prompt 已生效（通过 `/api/skills/:name` 查询验证） |
| TC-B9 | I | 列表筛选 | GET `/api/skills?source=user` → 仅返回 source=user |
| TC-B10 | U | YAML frontmatter 序列化往返 | parse → modify → stringify 后能再次 parse 出相同对象 |

### 11.3 进度事件（FR-C）

| 编号 | 级别 | 用例 | 期望结果 |
|------|:--:|------|---------|
| TC-C1 | U | CORAL_PROGRESS 协议解析 | 多种协议行 + 普通行混合 stderr → 正确分类为 progress 与 log |
| TC-C2 | I | 脚本 Skill 端到端事件 | 跑一个会输出 5 次 progress 的脚本 → eventBus 收到 5 条 `skill.progress` |
| TC-C3 | I | LLM 流式调用 | 触发 LLM Skill → 按 chunk 数量 emit `skill.log` 事件 |
| TC-C4 | I | SSE 端点连通 | curl `/api/tasks/:id/stream` → 收到 SSE 格式事件 |
| TC-C5 | I | WS + SSE 双订阅 | 同时建两个连接，触发任务 → 两边都收到事件 |
| TC-C6 | E | WS 断开 SSE 兜底 | 浏览器 devtools 关闭 WS，长任务进度仍持续更新（来自 SSE） |
| TC-C7 | U | 前端事件去重 | 同 eventId 入两次 → 列表只 1 条 |
| TC-C8 | I | Mock 模式假进度 | mockMode=true 时跑 LLM Skill → 仍能定时 emit progress |
| TC-C9 | E | 进度延迟 | 脚本 emit 到 UI 渲染端到端延迟 p95 < 500ms |
| TC-C10 | E | 长日志不卡 UI | 持续 emit 1000 条 log → 前端流畅滚动（最多保留 500 条） |

### 11.4 政策采集改造（FR-D）

| 编号 | 级别 | 用例 | 期望结果 |
|------|:--:|------|---------|
| TC-D1 | U | emit_progress helper | 调用产生合法的 stderr 行 |
| TC-D2 | I | 单站点 mock 抓取 | mock 一个站点返回 5 条 → MD 文件含分组、CSV 不变 |
| TC-D3 | I | 全 8 站点真实运行 | 至少有 1 个站点失败 → 整体仍完成，失败站点在 MD 中标记 |
| TC-D4 | I | output_schema 校验 | 返回值含 md_path、csv_path、count、summary | 
| TC-D5 | E | UI 进度推进 | 8 个站点跑完，前端进度条从 0% 走到 100%，每个站点至少 1 次更新 |
| TC-D6 | E | MD 内容正确性 | 抽检 5 条政策，标题/日期/URL 与 CSV 一致 |
| TC-D7 | I | 超时不影响其他 | 设置某站超时 30 秒 → 仍跳过继续 |
| TC-D8 | E | 双产物下载 | 完成后 UI 上 MD 与 CSV 都可点击下载，文件可正常打开 |

### 11.5 政策转推文改造（FR-E）

| 编号 | 级别 | 用例 | 期望结果 |
|------|:--:|------|---------|
| TC-E1 | U | parse_md_content | 输入 policy-scraper 格式 MD → 正确解析出 N 条 |
| TC-E2 | U | parse_md_content（异常） | 不规范 MD → 返回空列表，不抛异常 |
| TC-E3 | I | md_content 输入 | input={md_content:"..."} → 生成推文 |
| TC-E4 | I | md_path 输入 | input={md_path:"./xx.md"} → 生成推文 |
| TC-E5 | I | csv_path 输入（向后兼容） | 用现有 CSV → 生成推文 |
| TC-E6 | I | 三种输入都没传 | 返回 400 + 明确错误信息 |
| TC-E7 | I | 单条政策抓取失败 | 跳过并标注，整体不中断；最终 MD 含「N 条成功 / M 条失败」 |
| TC-E8 | E | UI 进度 | N=10 条政策，进度条从 0 → 100，每条至少 1 次更新 |
| TC-E9 | I | 串接 policy-scraper | 先跑 scraper 再用其 md_path 跑 to-post → 端到端成功 |

### 11.6 端到端用户故事验收（核心交付门）

| 编号 | 用例 | 通过条件 |
|------|------|---------|
| **TC-Z1**（US-1） | 业务用户创建小红书采集 Skill | UI 上 ≤ 5 轮对话生成 → 落盘 → 出现在列表 → 可执行测试 |
| **TC-Z2**（US-2） | 修改 summarize-document 的 prompt | 编辑保存后 2s 内生效，新任务用新 prompt |
| **TC-Z3**（US-3） | 跑一次政策采集（2026-03） | 全程进度条不停顿超过 10s；MD/CSV 都生成；条数 > 0 |
| **TC-Z4**（US-4） | 粘贴 MD 文本跑 policy-to-post | 30 条政策 ≤ 2 分钟生成推文，进度持续 |
| **TC-Z5**（US-5） | 删除内置 data-transform | 弹窗输入名字才能确认；列表中消失；文件移入 .trash |

### 11.7 非功能验收

| 编号 | 指标 | 验证方式 | 通过线 |
|------|------|---------|--------|
| TC-N1 | Skill Builder 单轮 p95 延迟 | 跑 50 次单轮 | < 8 秒 |
| TC-N2 | progress 端到端延迟 p95 | 1000 次注入 → 浏览器接收时间戳 | < 500ms |
| TC-N3 | WS 断线自动重连 | 手动 kill WS → 观察 | ≤ 3s 自动重连 |
| TC-N4 | 旧版 SKILL.md 加载兼容 | 现有 4 个内置 Skill 全部加载 | 100% |
| TC-N5 | 新 Skill 的 SKILL.md 也能被现有解析器加载 | 创建后重启服务 | 加载成功 |
| TC-N6 | 路径穿越拒绝 | name=`../foo` / `..\\bar` / `/abs/path` | 全部 400 |
| TC-N7 | 内置二次确认绕过 | 直接 curl PUT/DELETE 不带 header | 全部 403 |

> **rev 2 新增的测试用例**位于本文档末尾（§11.8 信息筛选 / §11.9 组合任务 / §11.10 公司画像 / §11.11 视觉系统），延续 TC-H/I/G/J 编号。

---

## 12. 兼容与降级

### 12.1 向后兼容矩阵

| 项 | 升级前 | 升级后 | 兼容性 |
|----|--------|--------|--------|
| SKILL.md frontmatter 无 `source` | 加载 | 加载，视为 builtin | ✅ |
| `/api/skills` 返回字段 | 不含 source | 增加 source | ✅ 加字段不破坏 |
| `policy-scraper` output | csv_path/count | + md_path/summary | ✅ 加字段 |
| `policy-to-post` input | input_file | + md_content/md_path/csv_path | ✅ input_file 视为 csv_path 别名 |
| 现有事件类型 | 不变 | + 新增 3 类 | ✅ |

### 12.2 降级策略

| 场景 | 行为 |
|------|------|
| LLM 不可用（mock 模式） | Skill Builder 返回提示「当前不可用」，但已有 Skill 仍可创建（用模板） |
| 流式 LLM 不支持 | 退回非流式调用 + 定时 progress 模拟 |
| WS 端点不可用 | SSE 接管，前端连接状态指示灯黄色 |
| stderr 解析异常 | 当作普通 log；不影响主流程 |

---

## 13. 安全考量（最小集）

- **路径穿越**：所有用户输入的 name、path 严格白名单
- **脚本注入**：用户写入的 scriptContent 不会自动执行（仅在 Skill 被调用时进沙箱）
- **Builtin 守卫**：服务端校验 + 前端确认双保险
- **SKILL.md 写盘**：用 `fs.rename` 原子搬迁，避免半成品
- **历史记录**：编辑前快照（P2）；删除走回收站

---

## 14. 部署与回滚

- 平台 v1.1.0 发布前，先在 dev 环境跑完 §11.6 的 5 个核心 E2E
- 数据迁移：data 目录新增 `skill_builder_sessions.json`（首次启动时自动创建空文件）
- **回滚方案**：v1.1.0 完全向后兼容 v1.0.0，回滚仅需切换镜像/代码版本，data 目录不需要回写

---

## 15. Open Items / 待评审

- [ ] 是否需要为 Skill Builder 提供「从模板派生」（FR-A10，P2）
- [ ] `.history/` 是否进入本期（FR-B6，P2）
- [ ] 大量 log 事件的服务端持久化策略（auditStore 是否需要按容量裁剪）
- [ ] policy-to-post 流式 LLM 是否要把每个 chunk 推前端（FR-E5，P1，可灰度）
- [ ] DAG 可视化是否在 P1 内支持节点拖拽编辑（保留为 P2）
- [ ] 公司画像的多公司/多用户切换（多租户）是否进入下一迭代

---

## 16. 视觉设计系统（FR-J）

> 设计依据：通过 `ui-ux-pro-max` 工具针对「multi-agent automation platform dashboard SaaS professional dark modern」生成。

### 16.1 设计哲学

- **科技感**：深色主背景 + 强对比度的 CTA 色（绿）传达"运行中、可信赖、智能"
- **层次感**：Glassmorphism 提供"前后景分离"和"信息分层"
- **生命感**：运行态用呼吸动效暗示"系统在思考"
- **克制**：动效服务于反馈而非装饰，遵循 reduced-motion

### 16.2 调色板（Tokens）

```css
/* tailwind config 注入（packages/web/tailwind.config.ts） */
colors: {
  /* 背景层（从深到浅） */
  bg: {
    base:  '#020617',   /* 页面底色 */
    panel: '#0F172A',   /* 一级面板 */
    raise: '#1E293B',   /* 浮起卡片 */
    elev:  '#334155',   /* 悬停态 */
  },
  /* 文字 */
  fg: {
    primary:   '#F8FAFC',
    secondary: '#CBD5E1',
    muted:     '#94A3B8',
    disabled:  '#64748B',
  },
  /* CTA 与状态 */
  brand: {
    DEFAULT: '#22C55E',  /* 主 CTA 绿 */
    hover:   '#16A34A',
    active:  '#15803D',
    soft:    'rgba(34, 197, 94, 0.12)',
  },
  status: {
    info:    '#38BDF8',
    success: '#22C55E',
    warn:    '#F59E0B',
    danger:  '#EF4444',
    pending: '#94A3B8',
  },
  /* Glass 描边 */
  glass: {
    border: 'rgba(255, 255, 255, 0.10)',
    borderStrong: 'rgba(255, 255, 255, 0.18)',
  },
}
```

### 16.3 字体

```css
@import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;500;600;700&family=Poppins:wght@400;500;600;700&display=swap');

:root {
  --font-heading: 'Poppins', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  --font-body:    'Open Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  --font-mono:    'JetBrains Mono', 'Fira Code', monospace;
}

h1,h2,h3,h4 { font-family: var(--font-heading); font-feature-settings: 'cv11'; }
body { font-family: var(--font-body); font-display: swap; }
```

### 16.4 Glass 卡片基类

```css
.glass {
  background: linear-gradient(135deg, rgba(15,23,42,0.65), rgba(30,41,59,0.45));
  backdrop-filter: blur(16px) saturate(120%);
  -webkit-backdrop-filter: blur(16px) saturate(120%);
  border: 1px solid theme('colors.glass.border');
  box-shadow:
    0 1px 0 rgba(255,255,255,0.04) inset,
    0 8px 32px rgba(2, 6, 23, 0.45);
}
.glass:hover {
  border-color: theme('colors.glass.borderStrong');
  transform: translateY(-1px);
  transition: transform 200ms ease, border-color 200ms ease;
}
```

### 16.5 动效规范

| 场景 | 时长 | Easing | 实现 |
|------|------|--------|------|
| 卡片悬停上浮 | 200ms | `ease-out` | `transform: translateY(-1px)` + 边缘提亮 |
| 按钮 hover | 150ms | `ease-out` | bg lighten + 微 scale 1.02 |
| 按钮 active | 80ms | `ease-in` | scale 0.98 |
| 页面切换 | 250ms | `cubic-bezier(0.16,1,0.3,1)` | fade-in + translateY(8px → 0) |
| Modal/Drawer | 280ms | 同上 | + 背景遮罩淡入 |
| 运行中节点脉冲 | 1.6s | `ease-in-out` infinite alternate | `box-shadow` 周期渐变（柔和绿光） |
| 进度条流光 | 1.8s | `linear` infinite | `linear-gradient` + `background-position` 动画 |
| 骨架闪烁 | 1.2s | `ease-in-out` infinite | opacity 0.5 → 1 |
| 列表新条目入场 | 200ms | `ease-out` | fade-in + translateY(4px) |

```css
/* 进度条流光关键样式 */
.progress-bar {
  background: linear-gradient(
    90deg,
    theme('colors.brand.DEFAULT') 0%,
    rgba(255,255,255,0.45) 50%,
    theme('colors.brand.DEFAULT') 100%
  );
  background-size: 200% 100%;
  animation: progress-flow 1.8s linear infinite;
}
@keyframes progress-flow { to { background-position: -200% 0; } }

/* 运行中节点脉冲 */
.node-running {
  box-shadow: 0 0 0 0 rgba(34,197,94,0.45);
  animation: node-pulse 1.6s ease-in-out infinite alternate;
}
@keyframes node-pulse {
  to { box-shadow: 0 0 0 8px rgba(34,197,94,0.05); }
}

/* prefers-reduced-motion */
@media (prefers-reduced-motion: reduce) {
  .progress-bar { animation: none !important; background: theme('colors.brand.DEFAULT'); }
  .node-running { animation: none !important; }
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

### 16.6 图标体系

- 全站统一 [Lucide React](https://lucide.dev)（已有生态、轻量）
- 引入方式：按需 import（避免全量打包）
  ```tsx
  import { PlayCircle, CheckCircle2, AlertTriangle } from 'lucide-react';
  ```
- 尺寸规范：导航 18px / 卡片标题 16px / 内联文本 14px / 大按钮 20px
- 状态色映射：成功 `text-status-success` / 失败 `text-status-danger` / 运行中 `text-status-info animate-pulse`

### 16.7 组件设计 Tokens（节选）

| 组件 | 关键样式 |
|------|----------|
| 主按钮 | `bg-brand text-bg-base font-semibold rounded-xl px-5 py-2.5 hover:bg-brand-hover active:scale-[0.98] transition` |
| 次要按钮 | `glass text-fg-primary border border-glass-borderStrong hover:bg-bg-elev` |
| 危险按钮 | `bg-status-danger/15 text-status-danger border border-status-danger/30 hover:bg-status-danger/25` |
| 输入框 | `bg-bg-panel/60 backdrop-blur border border-glass-border rounded-lg focus:border-brand focus:ring-2 focus:ring-brand/30` |
| Tag/Badge | `bg-bg-elev/60 border border-glass-border rounded-full text-xs px-2.5 py-0.5` |
| 卡片 | `glass rounded-2xl p-5` |
| 滚动条 | 自定义：`scrollbar-thin scrollbar-thumb-bg-elev scrollbar-track-transparent` |

### 16.8 页面结构示例（TaskDetailPage 重构后）

```
┌────────────────────────────────────────────────────────────────────┐
│  ●    CORAL          [Tasks ▸ task_xxx]      ●WS  ●SSE  💡Mock     │ 顶部状态栏
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│   ┌──────────────────── glass 卡片 ─────────────────────────┐      │
│   │  采集广东工信厅 3 月政策...                状态: 执行中  │      │
│   │  ID: task_xxx · 2026-04-25 11:23                         │      │
│   └──────────────────────────────────────────────────────────┘      │
│                                                                    │
│   ┌─ DAG 可视化（React-Flow） ───────────────────────────────┐      │
│   │                                                          │      │
│   │   [scraper]──data──▶[filter]──data──▶[to-post]           │      │
│   │      ●●● 运行中     ⏸ 等待           ⏸ 等待               │      │
│   │      62% [3/8]                                          │      │
│   │                                                          │      │
│   └──────────────────────────────────────────────────────────┘      │
│                                                                    │
│   ┌─ 实时日志（虚拟滚动） ─────┐ ┌─ 产物（实时聚合） ─────┐        │
│   │ 11:23:01 启动浏览器...     │ │ 📄 政策_3月.md 12.3KB │        │
│   │ 11:23:04 [3/8] 工信厅 第1页│ │ 📊 政策_3月.csv 8.7KB │        │
│   │ ...                        │ │                       │        │
│   └────────────────────────────┘ └────────────────────────┘        │
└────────────────────────────────────────────────────────────────────┘
```

### 16.9 视觉重构的渐进路径

为避免一次性重构带来回归，采用 **3 步推进**：

1. **Step 1：tokens + 全局样式**（不改业务组件结构）—— 仅替换颜色变量、字体、滚动条、按钮基类。
2. **Step 2：核心 3 页深度改造**（TaskDetail / SkillsPage / SkillBuilder）—— 全套 glass + 动效。
3. **Step 3：剩余页面对齐**（Dashboard / Tasks / Chat / Settings）。

每一步独立可发布，可灰度。

---

## 17. 公司业务画像（FR-G）

### 17.1 数据模型

```ts
// 新增：CompanyProfile（持久化到 data/company_profile.json）
export interface CompanyProfile {
  version: number;                  // 每次保存自增
  companyName: string;              // 公司名
  industries: string[];             // 行业领域
  coreBusinesses: string[];         // 核心业务（中试平台、科技成果转化、产业创新、数字化转型...）
  focusKeywords: string[];          // 关注关键词
  excludeKeywords: string[];        // 排除关键词（黑名单）
  policyTypes: {                    // 偏好的政策类别
    keep: string[];                 // 「办法」「措施」「申报」...
    exclude: string[];              // 「公示」「名单」「人事」...
  };
  description: string;              // 自由文本补充（150-500 字）
  updatedAt: string;
}
```

### 17.2 默认画像（首次启动种子）

```json
{
  "companyName": "示例公司（请在设置中替换）",
  "industries": ["制造业", "高新技术"],
  "coreBusinesses": ["中试平台建设", "科技成果转化", "产业创新", "数字化转型"],
  "focusKeywords": ["中试", "概念验证中心", "科技成果转化", "机器人", "人工智能",
    "生物医药", "新材料", "技术改造", "专精特新", "首台套", "奖补", "专项资金"],
  "excludeKeywords": ["公示", "名单", "结果", "人事任命", "招标公告"],
  "policyTypes": {
    "keep": ["办法", "措施", "意见", "规划", "行动计划", "指引", "条例", "申报", "征集", "组织开展"],
    "exclude": ["公示", "名单", "拟认定", "通过", "通报"]
  },
  "description": ""
}
```

### 17.3 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/company-profile` | 读取（无则返回默认） |
| PUT | `/api/company-profile` | 全量替换（version 自增） |
| GET | `/api/company-profile/history` | 历史版本（P2） |

### 17.4 注入机制

- **Skill 端**：在 `SkillExecutor.buildSystemPrompt()` 中检测 manifest 是否声明 `consumes_company_profile: true`（frontmatter），是则在 prompt 末尾注入完整 profile JSON。
- **任务级覆盖**：`POST /api/tasks` 的 `constraints.companyProfileOverride` 可临时覆盖（深合并）。
- **规划引擎**：在生成 DAG 时同样可读取 profile，作为参数提取的语义提示。

### 17.5 设置页 UI

```
┌─ 公司业务画像 ──────────────────────────── ✅ 已启用 v3 ──┐
│                                                          │
│  公司名称*：[ 中试科技有限公司                          ] │
│  行业领域：[制造业] [高新技术]  + 添加                  │
│  核心业务：☑ 中试平台 ☑ 成果转化 ☑ 产业创新 ☑ 数字化转型│
│  关注关键词（每行一个，或逗号分隔）：                    │
│   ┌────────────────────────────────────────────────────┐ │
│   │ 中试                                                │ │
│   │ 科技成果转化                                        │ │
│   │ ...                                                 │ │
│   └────────────────────────────────────────────────────┘ │
│  排除关键词：[公示] [名单] [人事] + 添加                 │
│  自由描述：[ ... ]                                       │
│                                                          │
│              [恢复默认]  [取消]  [保存（生成 v4）]       │
└──────────────────────────────────────────────────────────┘
```

---

## 18. 多源信息筛选 Skill（FR-H）

### 18.1 SKILL.md frontmatter

```yaml
---
name: information-filter
version: "1.0.0"
description: >-
  根据公司业务画像，从多源信息（政策清单/展会信息/行业新闻/单篇文章）中筛出相关条目，
  保留原结构并附筛选理由。
domain: information-processing
capabilities:
  - content_filtering
  - relevance_scoring
  - structured_extraction
input_schema:
  type: object
  oneOf:
    - required: [md_content]
    - required: [md_path]
    - required: [csv_path]
    - required: [urls]
    - required: [text]
  properties:
    md_content:  { type: string }
    md_path:     { type: string }
    csv_path:    { type: string }
    urls:        { type: array, items: { type: string } }
    text:        { type: string }
    dry_run:     { type: boolean, default: false }     # 仅评估前 5 条
    output_path: { type: string }
output_schema:
  type: object
  properties:
    md_path:           { type: string }
    csv_path:          { type: string }
    kept_count:        { type: integer }
    excluded_count:    { type: integer }
    summary_by_topic:  { type: object }
execution_mode: llm_only
consumes_company_profile: true     # 自动注入公司画像
estimated_duration_ms: 180000
cost_level: high
status: stable
tags: [信息筛选, 内容过滤, 公司画像驱动]
---
```

### 18.2 输入归一化（normalizer）

| 输入字段 | 处理方式 |
|----------|----------|
| `md_content` | 解析 Markdown，识别 `### 标题` / `**链接**` / `**日期**` 等元数据，回退到段落整体 |
| `md_path` | 读文件后等同 `md_content` |
| `csv_path` | pandas 读取，按列名（标题/日期/链接/部门）映射到统一 PolicyItem 结构 |
| `urls` | 对每个 URL 抓取标题与首段（不抓全文，节约 token） |
| `text` | 单条文章直接作为 `{title: 推断, content: text}` 喂入 |

归一化后所有输入合并为统一结构：

```ts
interface FilterableItem {
  index: number;
  title: string;
  date?: string;
  source?: string;     // 部门 / 网站
  url?: string;
  excerpt: string;     // 标题外的描述（≤ 200 字）
  raw: any;            // 保留原始字段便于回写
}
```

### 18.3 LLM 评估 prompt 模板

```
你是一位专业的{industries}领域分析师和项目申报专家，
熟悉{coreBusinesses}相关的政策与产业生态。

# 公司业务画像
{company_profile_json}

# 评估对象（共 {n} 条）
{items_compact_json}      # 仅保留 index/title/source/date/excerpt

# 任务
对每条信息基于"标题 + 摘要"做语义判断，决定保留或剔除，并给出 ≤ 30 字的理由。

## 保留规则（参考但不限于）
- 实质性政策文件：办法、措施、意见、规划、行动计划、指引、条例
- 项目申报与认定：申报、征集、组织开展、入库、培育（前瞻性动作）
- 公司画像内的关键词命中（{focusKeywords}）
- 与公司核心业务（{coreBusinesses}）相关的重大行业动态

## 剔除规则（参考但不限于）
- 已有结果：公示、名单、拟认定、通过
- 行政/人事/党建：人事任命、领导、座谈会、值班
- 非政策性公告：单纯采购/招标（非项目承担单位遴选）、统计数据、新闻
- 命中排除关键词：{excludeKeywords}

# 输出（严格 JSON，不要 markdown 代码块）
{
  "decisions": [
    { "index": 0, "keep": true,  "reason": "属于中试平台相关申报政策" },
    { "index": 1, "keep": false, "reason": "结果公示，非新机会" }
  ]
}
```

### 18.4 分批与重试

- 每批 ≤ 20 条（按 token 预估动态调整）
- 失败重试 ≤ 3 次（指数退避：2s/4s/8s）
- `dry_run: true` 仅评估前 5 条且不写文件
- 进度：每完成一批 emit `skill.progress`（percent = batch_done/total_batch * 100）

### 18.5 输出 MD 模板

```markdown
# 信息筛选结果

> 输入 {N} 条 · 保留 {K} 条 · 剔除 {N-K} 条 · 公司画像 v{X}
> 处理时间：2026-04-25 11:30:00

## 筛选汇总

| 关键关注领域 | 命中条数 |
|-------------|---------|
| 中试平台 | 5 |
| 科技成果转化 | 3 |
| 数字化转型 | 2 |

## 保留条目

### {机构 / 来源 1}（{n} 条）

#### {标题}
- **发布日期**：YYYY-MM-DD
- **来源**：{机构}
- **链接**：<url>
- **筛选理由**：{≤30 字}

...

## 剔除条目（折叠展示，附理由）

<details><summary>共 {M} 条 — 点击展开</summary>

| 标题 | 来源 | 剔除理由 |
|------|------|---------|
| ... | ... | ... |

</details>
```

> 同时输出 CSV：原始字段 + `keep`（boolean） + `reason`（string）。

---

## 19. 组合任务理解（参数提取与多 Skill 编排，FR-I）

### 19.1 PlanningEngine 升级

在原有 `llmPlan()` 之上新增**组合任务规划 prompt**，强调：

1. **意图分解**：从一句话中识别多个动作（采集/筛选/转换/汇总…）
2. **Skill 选择**：基于 `description` + `capabilities` + `tags` 与意图匹配
3. **参数提取**：基于每个 Skill 的 `input_schema` 反向填充
4. **DAG 编排**：基于上下游 schema 推断 dataMapping
5. **优雅短路**：明确告诉 LLM 在某节点输出空时下游应跳过而非失败

### 19.2 升级版 prompt（节选）

```
你是 CORAL 平台的规划引擎。把用户目标分解为可并发执行的 Agent DAG。

# 可用 Skills（含 input_schema 关键字段与示例）
[
  {
    "name": "policy-scraper",
    "description": "...",
    "input_keys": ["year","month","sites"],
    "site_aliases": {"广东工信厅": "gdii", "佛山住建局": "fszj", ...},
    "default": { "year": "<current_year>", "month": "<current_month-1>", "sites": "all" }
  },
  {
    "name": "information-filter",
    "consumes_company_profile": true,
    "input_keys": ["md_content","md_path","csv_path","urls","text"]
  },
  {
    "name": "policy-to-post",
    "input_keys": ["md_content","md_path","csv_path","period_title"]
  }
]

# 公司业务画像（用于辅助 information-filter）
{company_profile_json}

# 用户目标
{goal}

# 输出（严格 JSON）
{
  "reasoning": "...",
  "agents": [...],
  "edges": [
    {"from":"a1","to":"a2","dataMapping":{"md_path":"md_path"}}
  ]
}

# 重点规则
1. 当用户提及具体站点（"广东工信厅"），用 site_aliases 转换为 ID 数组传给 scraper
2. 若用户提到"筛选"、"挑出与公司相关"、"过滤"，必须加入 information-filter
3. 串接顺序：采集类 → 筛选类 → 输出类（推文/摘要/汇总）
4. 默认使用上游产物路径作为下游输入（dataMapping）
5. 当用户描述模糊（如"最近的政策"），用 default 字段并在 reasoning 解释
```

### 19.3 站点别名表（policy-scraper/reference.md）

```yaml
site_aliases:
  gdii:
    names: ["广东工信厅", "广东工业和信息化厅", "工信厅", "工信"]
    url: "https://gdii.gd.gov.cn/gkmlpt/index"
  fszj:
    names: ["佛山住建局", "住建局", "佛山住建"]
    url: "https://fszj.foshan.gov.cn/gkmlpt/index"
  # ... 其余 6 个
```

PlanningEngine 在解析时通过别名表把自然语言转成 ID 数组。

### 19.4 参数提取保底机制

如果 LLM 输出的 `agents[i].skillInputTemplates[skill]` 缺少必填字段：

1. 尝试用 Skill 的 `default` 填充
2. 仍然不足 → 在 DAG 第一个节点前插入 **HumanGate 询问步骤**（暂不实现 UI，本期触发 → 任务 `failed` 并在 error.reason 中说明缺哪些参数，引导用户补充）

### 19.5 组合任务的优雅短路

在 `DAGScheduler.runAgent()` 末尾新增：

```ts
// 如果上游产物明显为"空"（如 kept_count === 0），下游标记 skipped
if (isEmptyOutput(agent.output) && hasDownstream(agent)) {
  for (const downstream of getDownstream(agent)) {
    downstream.status = 'cancelled';   // 复用 cancelled 状态
    downstream.error = { code: 'UPSTREAM_EMPTY', message: '上游产物为空，跳过执行', retryable: false };
    eventBus.emit('agent.cancelled', { ..., reason: 'upstream_empty' });
  }
}
```

判定规则（可由 Skill 在 frontmatter 声明 `empty_when`）：

```yaml
empty_when:
  - field: kept_count
    op: eq
    value: 0
```

---

## 20. DAG 可视化（React-Flow）

### 20.1 选型

- 库：[React-Flow](https://reactflow.dev/) v11
- 体积：约 70KB gzip（含核心）；按需加载（dynamic import）
- 优势：node 拖拽、连线、缩放、minimap 开箱即用；高度可定制节点
- 备选（不选）：D3.js（自写量大）/ Cytoscape.js（API 偏命令式）

### 20.2 节点类型与颜色映射

| 节点状态 | 颜色 | 边框 | 动效 |
|---------|------|------|------|
| `pending` | `bg-bg-raise` `text-fg-muted` | `border-glass-border` | 无 |
| `running` | `bg-status-info/15` `text-status-info` | `border-status-info` | `node-running` 脉冲 |
| `completed` | `bg-status-success/15` `text-status-success` | `border-status-success` | 一次性"打勾"动画 |
| `failed` | `bg-status-danger/15` `text-status-danger` | `border-status-danger` | 抖动 200ms |
| `cancelled (skipped)` | `bg-bg-raise/50 opacity-60` | dashed | 无 |

### 20.3 自定义节点组件

```tsx
function AgentNode({ data }: NodeProps<AgentNodeData>) {
  const { name, role, status, skill, progress } = data;
  return (
    <div className={`glass rounded-xl p-3 w-64 ${statusClasses[status]}`}>
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <StatusIcon status={status} />
        <span className="font-semibold text-sm truncate">{name}</span>
      </div>
      <div className="text-xs text-fg-muted mt-1 line-clamp-2">{role}</div>
      <div className="mt-2 flex items-center gap-2">
        <Tag>{skill}</Tag>
        {status === 'running' && <ProgressBar value={progress} compact />}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
```

### 20.4 边样式

- happy path（已完成）：`#22C55E` 粗 2px，带渐变流光
- 待执行：`#475569` 1.5px dashed
- 数据流标签：在边中点显示 `dataMapping` 简写（如 `md_path`）

### 20.5 自动布局

使用 [dagre](https://github.com/dagrejs/dagre) 计算节点坐标：

```ts
import dagre from 'dagre';

function layout(nodes, edges, direction='LR') {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 60, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach(n => g.setNode(n.id, { width: 256, height: 100 }));
  edges.forEach(e => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map(n => ({ ...n, position: g.node(n.id) }));
}
```

### 20.6 与事件流的联动

`useTaskStream` 派生的 `progressByAgent` 直接喂入 React-Flow 节点 data；事件触发的状态变更通过 `setNodes(prev => prev.map(...))` 局部更新，不重渲整图。

---

## 11.8 信息筛选测试用例（FR-H）

| 编号 | 级别 | 用例 | 期望结果 |
|------|:--:|------|---------|
| TC-H1 | U | normalizer：MD → FilterableItem[] | policy-scraper 格式 MD（10 条）→ 解析得 10 个对象 |
| TC-H2 | U | normalizer：CSV → FilterableItem[] | 标准 CSV 列名 → 正确映射 |
| TC-H3 | U | normalizer：URL 抓取失败 | 返回 `{title: url, excerpt: ""}` 占位，不抛异常 |
| TC-H4 | U | normalizer：text 单文章 | 返回 1 个对象，title 取首句 |
| TC-H5 | I | LLM 评估返回不完整 | 缺失 index 的项默认 keep=true（保守不漏） |
| TC-H6 | I | 公司画像注入 | LLM prompt 中含 `companyName/coreBusinesses/focusKeywords` |
| TC-H7 | I | 任务级覆盖 | constraints.companyProfileOverride.focusKeywords 生效 |
| TC-H8 | I | 全部剔除 | 输入 5 条全是公示 → 输出 MD 含「无符合条件的内容」 |
| TC-H9 | I | dry_run | dry_run=true → 仅评估前 5 条，输出 kept_count ≤ 5 |
| TC-H10 | I | 大量输入分批 | 输入 50 条 → 自动分 3 批 → 进度推 3 次 |
| TC-H11 | E | 全流程 UI | 设置画像 → 上传 MD → 看到筛选结果 + 折叠剔除区 |
| TC-H12 | I | 历史 prompt 兼容 | 用用户提供的政策筛选 prompt 模板做 baseline → 决策一致率 ≥ 85% |

## 11.9 组合任务测试用例（FR-I）

| 编号 | 级别 | 用例 | 期望结果 |
|------|:--:|------|---------|
| TC-I1 | I | 站点别名识别 | 「广东工信厅 3 月」 → year=当前年, month=3, sites=["gdii"] |
| TC-I2 | I | 多站点识别 | 「广东工信厅和佛山住建局 2026 年 2 月」 → sites=["gdii","fszj"], year=2026, month=2 |
| TC-I3 | I | 隐含意图识别 | 「采集广东工信厅 3 月，做成推文」 → 自动 2 节点 DAG（无 filter） |
| TC-I4 | I | 完整三段链 | 「采集… 筛选与公司相关的… 做成推文」 → 3 节点 DAG，按序串接 |
| TC-I5 | I | dataMapping 推断 | scraper.md_path → filter.md_path → toPost.md_path | 无需用户指定 |
| TC-I6 | I | 模糊输入 | 「最近的政策做成推文」 → year=当前年, month=当前月-1, sites=all, reasoning 含说明 |
| TC-I7 | I | 缺参兜底 | 用户什么都不说 → 任务 failed，error.reason 列出缺哪些参数 |
| TC-I8 | I | 优雅短路 | filter 输出 kept_count=0 → toPost 状态 cancelled 而非 failed |
| TC-I9 | E | UI DAG 可视化 | TaskDetail 上 3 节点完整渲染；运行中节点脉冲；完成后流光从首节点流到末节点 |
| TC-I10 | E | 用户故事 US-6 端到端 | 一句话「采集广东工信厅和佛山住建局 3 月政策…」≤ 5 分钟跑完 |

## 11.10 公司画像测试用例（FR-G）

| 编号 | 级别 | 用例 | 期望结果 |
|------|:--:|------|---------|
| TC-G1 | I | 首次启动种子 | data 目录不存在 profile → 自动写入默认 |
| TC-G2 | I | PUT 后 version+1 | 连续保存 3 次 → version=4（含初始 v1） |
| TC-G3 | I | 任务级覆盖 | constraints.companyProfileOverride 深合并到全局 |
| TC-G4 | I | consumes_company_profile=false 不注入 | summarize-document 的 prompt 不含 profile |
| TC-G5 | E | 设置页保存即生效 | 改完 focusKeywords 立刻跑 filter，可观察到新关键词命中 |

## 11.11 视觉系统测试用例（FR-J）

| 编号 | 级别 | 用例 | 期望结果 |
|------|:--:|------|---------|
| TC-J1 | E | 整体风格切换 | 全站背景为深色 #020617，主 CTA 为 #22C55E |
| TC-J2 | E | Glass 卡片 | 任务卡片在不同背景下都有可见边缘和阴影 |
| TC-J3 | E | 悬停反馈 | 卡片 hover → 上浮 1px + 边缘提亮 + cursor pointer |
| TC-J4 | E | 运行中节点脉冲 | running 状态节点周期性外发光 |
| TC-J5 | E | 进度条流光 | 进度条带光斑从左到右循环 |
| TC-J6 | E | 骨架屏 | 加载中页面显示骨架而非全屏 spinner |
| TC-J7 | U | 颜色对比度 | 主要 fg/bg 组合 ≥ 4.5:1（用 axe-core 自动测） |
| TC-J8 | U | 无 emoji 图标 | 全站组件 grep 不到 emoji 字符（除用户内容） |
| TC-J9 | E | reduced-motion | 系统开启该选项后所有动画时长归零 |
| TC-J10 | E | 响应式 | 在 375/768/1024/1440 四档无横向滚动 |
| TC-J11 | E | 字体加载 | Network 中 Poppins/Open Sans 被加载，font-display=swap |
