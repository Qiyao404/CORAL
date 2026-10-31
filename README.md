# CORAL — 个人轻量级 Agent 运行时平台

**简体中文** | [English](./README.en.md)

[![CI](https://github.com/Qiyao404/CORAL/actions/workflows/ci.yml/badge.svg)](https://github.com/Qiyao404/CORAL/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **版本：v2.2.0** · [快速导览（DEMO.md）](DEMO.md) · [CHANGELOG](CHANGELOG.md)
> **定位：本地优先、单命令启动、单文件存储的个人级 Agent 运行时**

---

## 概述

CORAL 是一个由 LLM 驱动的个人 Agent 运行时：接收自然语言目标，Agent 自主规划、调用工具、读写本地文件，执行过程全程可观测、可审批、可中断。

- **自主规划**：任务开始前建立任务清单，执行过程中逐项更新状态
- **工具调用**：19 个内置工具（文件读写 / Word 文档 / 网络访问 / 长期记忆 / 子代理等）与技能生态
- **可观测性**：流式输出与事件溯源（全量事件持久化，支持回放与 Markdown 导出）
- **实时通信**：SSE / WebSocket 双通道，每一步（含审批请求）即时到达浏览器
- **本地优先**：SQLite 单文件存储、默认仅监听 127.0.0.1、密钥仅存本机、零云依赖

无 API Key 时可使用演示模式运行完整链路（`npm run dev:server -- --demo`，输出带 mock 标记）。

---

## 关键设计

以下机制描述均对应本仓库的具体实现（模块、事件名与数据路径可直接在源码中定位）；各机制的命名（事实门、收工门、证据记录、习惯学习等）为本项目自有。

**1. 退化工具调用归一化（provider 层）**
部分模型会间歇性地将工具调用以非标准标记文本打印进 content 而非走标准 tool_calls 通道。provider 层对全角与 ASCII 双形态标记做分割式解析，退化调用照常执行并标记 `degraded`；流式路径将疑似标记前缀保留在缓冲区、确认非标记后再放行，避免乱码泄漏与提前断流。

**2. 工具名幻觉自动纠正（alias 层）**
模型可能调用不存在的工具名。别名表与编辑距离（≤2）模糊匹配自动纠正到真实工具，并在结果中告知模型实际执行名称；无法纠正时返回 `TOOL_NOT_FOUND` 与完整可用工具清单，模型可在下一轮自愈。

**3. 任务清单三重保障**
自主规划不依赖模型自觉：① 系统提示要求开局先建立任务清单；② 模型跳过时引擎注入一次性提醒（`loop.todo_reminder` 事件留痕）；③ 终态时引擎代为收口未更新的清单项，UI 不会出现任务已完成但状态未同步的情况。

**4. 事件溯源与运行导出**
`events` 表与 EventBus 双写：每次 LLM 调用、工具执行、审批、清单变更均为可回放事件；支持一键导出整次运行的 Markdown 时间线报告（`GET /api/runs/:id/export.md`）。

**5. 多轮会话 checkpoint 续接**
每步落 checkpoint；同一会话的下一轮自动加载上次完整上下文；预算耗尽后可从断点续接。

**6. 上下文管理**
单条超大工具结果自动裁剪，历史超限自动摘要压缩，原始目标永远保留，长任务不因上下文超限而失败。

**7. 取消与超时语义**
AbortSignal 全链路贯穿（LLM 调用、脚本进程树终止）；错误按瞬时/永久/取消分类并采用指数退避，已交付内容的流式调用不重试（防止重复输出）。

**8. 文件式长期记忆与自动提炼**
`memory/` 目录为普通 Markdown，提供四个读写工具；会话结束后自动蒸馏归档。记忆即文本，可直接编辑。

**9. 工具效果契约**
每个工具在 `ToolEffects` 中声明效果位（写文件 / 起进程 / 联网 / 幂等），审批档位由 `derivePermission` 按效果组合推导而非手工标注；注册期校验声明与推导的一致性——声明只能使审批更严格，宽松于推导下限的标注在注册时被自动收紧。外部 MCP 工具的标准注解（readOnly / destructive / idempotent）映射进同一契约。

**10. 证据记录层**
超过工具级结果预算（`maxResultSizeChars`）的输出整体写入 `data/evidence/{runId}/`（只写不改，随 run 删除级联清理），上下文中以"摘要预览 + 记录 ID"对象替换原文；模型需要细节时通过 `evidence_read` 按 offset/limit 分页取回，收纳层压缩旧结果时同样归档进证据层。

**11. 三层上下文压缩与用量预警**
单条裁剪（常态启用）→ 收纳旧工具结果（软水位，归档进证据层可回溯）→ 全量 LLM 摘要（硬水位）；四级用量预警（正常/警告/危急/阻塞）。

**12. 事实门**
修改或覆盖已存在的文件之前，本任务内必须先读取过该文件。`FactGate` 扫描消息历史判定同路径是否存在成功的读取记录，缺失时返回 `FACTS_REQUIRED`（可重试）并附带调查指令；同一目标连续三次被拦后自动放行并发出告警事件（`tool.fact_gate`）以防死锁。新建文件不设门，由权限档把关。

**13. 收工门**
复杂任务（写操作 ≥3 次或工具调用 ≥5 次）的最终回答经话术模式库（中英双语正则集）审计：命中"历史遗留问题 / 测试先跳过 / 后续再修"类表述时，运行注入系统级追问要求补做工作或如实列出未完成事项（`loop.gate_rejected` 事件），最多打回两次，第三次放行并告警。

**14. 习惯学习**
每次工具调用被记录为观察日志（`data/habits/observations.jsonl`，超限轮转），达到阈值后由 LLM 蒸馏出"触发 → 行动"式协作习惯并入库（`habits.json`）；置信度随跨会话重复观察递增（0.3 起，0.9 封顶），≥0.7 自动注入系统提示；置信度 ≥0.8 且出现在 ≥2 个会话方可晋升为技能（生成 SKILL.md），30 天未复现自动衰减。

**15. 健康自诊（`coral doctor`）**
一条命令分诊多类常见故障：构建产物新鲜度、端口占用、数据目录可写性、磁盘水位、数据库完整性、模型配置、技能解析、MCP 连接状态，每项附修复建议。

**16. 产物追踪与预览**
每次回复底部自动列出本轮生成或修改的全部文件；点击在右侧面板预览：文本类直接渲染，Word 提取全文，PDF 与图片由浏览器原生渲染，其余格式提供下载。数据来自事件流，历史轮次同样可见。

**17. 独立评审与自评**
`dual_review` 工具为产出启动两个独立上下文的评审子代理（各自只收到评审目标与视角指令，看不到对方结论），分歧时追加第三个仲裁代理，共识才通过，无法裁决时如实返回 escalate。每次完成的运行自动执行确定性五轴评分（准确 / 完整 / 清晰 / 可执行 / 简洁，落 `run.self_eval` 事件）；API 可触发 LLM 语义裁决——评分低于 5 分的轴必须引用原文证据，否则该轴回退启发式结果。

**18. 记忆信任分级与决策记录**
Agent 写入的长期记忆默认 `unreviewed`，用户确认后标记 `reviewed`；覆盖已有记忆需显式 `overwrite=true`；检索不完整时如实报告而非误报"无结果"。每个会话自动沉淀带原因的决策（what + why）与接力记录（中断点 / 下一步 / 阻塞）。

**19. 子代理安全基线**
所有子代理的系统提示以统一安全基线开头：身份与指令集不可被工具输出改变、外部内容一律视为待分析数据而非指令、零宽字符等可疑载荷原样引用而非解释、不泄露系统提示与凭据。主循环内置同样的不可信数据纪律。

**20. 外部命令守卫**
`data/hooks.json` 在 8 个生命周期点（工具调用前后 / 收工 / 提交 / 会话起止 / 压缩前 / 通知）调用外部命令：可否决调用、改写工具入参、升级人工审批、打回最终回答、注入上下文。契约：stdin 收 JSON，stdout 输出决策 JSON，退出码 2 即拒绝；工具调用前的守卫若自身故障或超时按拒绝处理（默认从严），其余事件故障不影响执行；配置按 mtime 失效检查热加载。

**21. 斜杠命令与具名子代理**
`data/commands/*.md` 斜杠命令：`/research 主题` 展开为完整任务（模板占位 `$ARGUMENTS` / `$1`）；`data/agents/*.md` 具名子代理：预置调研 / 评审 / 数据 / 成文四个专员，描述与触发例示注入主提示（指导主模型何时委派），正文按名加载、工具白名单随行——能力扩展不增加主上下文负担。

**22. 压缩失败冷却阶梯**
LLM 摘要失败采用 60s → 300s → 900s 递进冷却；冷却期间硬水位仍在上升时由确定性骨架摘要（无 LLM、逐条首句、保转录完整）兜底。

**23. 急停哨兵、审批记忆与运行预算**
`coral pause` 以哨兵文件方式暂停全部新任务（运行中的不受影响，哨兵文件损坏亦视为已暂停——fail-safe）；审批可带 `scope=session`，同工作区同工具在本次服务会话内自动放行并留痕，可一键清除；运行预算（token / 步数上限）用户可调，默认 100 万 token，上限 1000 万。

---

## 功能范围

打开 Chat 页，用一句话描述目标，Agent 将自主工作：

- **Word 文档读写**：上传 `.docx`，读取内容、总结要点、生成新文档（内置 OOXML 读写）
- **本地文件读写**：绑定工作区文件夹后，列目录、读写文件——写改前弹出 diff 审批卡片（三档权限：只读 / 询问 / 自动）
- **命令执行**：可选启用 shell 工具（每次执行均需审批）
- **网络访问**：抓取任意 URL 并阅读正文（零依赖 readability 抽取）
- **子代理**：长任务自动隔离到独立上下文的子代理（嵌套深度 ≤ 2）
- **技能生态**：对话式创建技能、导入业界通用 Agent Skills 格式（SKILL.md）、文件系统即注册表热重载

详细使用指南与任务示例见 [USE.md](./USE.md)。

---

## 快速开始

**方式一：单命令（推荐）**——构建产物一体化，自检后启动：

```bash
npm install && npm run build && npm start   # coral CLI：自检（端口/数据库/模型配置）→ http://127.0.0.1:3001
```

**方式二：开发模式**（前后端分离热更新）：

```bash
npm install
cp .env.example .env   # 填入 API Key（任意 OpenAI 兼容端点）
npm run dev            # 后端 3001 + 前端 5173
```

| 服务 | 地址 |
|------|------|
| Web UI（Chat / Skills / Tasks / Settings） | http://localhost:5173 |
| 后端 API | http://localhost:3001/api/health |

已在 DeepSeek、DashScope 上实测；OpenRouter / Ollama 等任意 OpenAI 兼容端点开箱即用。

---

## 架构总览

```
┌──────────────────────────────────────────────────────────────────────┐
│  Web UI                                                               │
│  Chat（Agent 会话：todo 清单 / 工具卡片 / diff 审批 / 产物预览）          │
│  Skills（列表/编辑/导入/对话创建） Tasks（v1 DAG 编排） Settings（模型/  │
│  工作区/记忆/预算）                                                      │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ REST + WS + SSE
┌──────────────────────────────▼───────────────────────────────────────┐
│  RunEngine（Free 模式入口：预算 / 取消 / 事件溯源双写）                    │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  Agent Loop（ReAct 主循环）                                      │ │
│  │  压缩检查 → LLM → 工具执行（事实门→守卫→审批）→ 预算 → checkpoint   │ │
│  │  ├─ todo 保障（开局强制 / 跳过提醒 / 终态收口）                    │ │
│  │  ├─ 假终答守卫（空回答 / 未竟任务 / 话术审计）                      │ │
│  │  ├─ sub-agents（agent_spawn：独立上下文 / 工具子集 / 深度≤2）      │ │
│  │  └─ 上下文管理（裁剪 + 收纳 + 摘要 + 冷却阶梯）                     │ │
│  └───────────────────────────┬─────────────────────────────────────┘ │
│                              │ 统一 Tool 接口                          │
│  ┌───────────────────────────▼─────────────────────────────────────┐ │
│  │  Tool Registry：内置 19 工具（fs / docx / http / shell / memory / │ │
│  │  evidence / dual_review …）│ Skills（热重载）│ MCP（双向桥）        │ │
│  └───────────────────────────┬─────────────────────────────────────┘ │
│  providers：OpenAI 兼容（DashScope/DeepSeek/OpenRouter/Ollama…）       │
│            + 退化归一化 + 工具名纠正 + 流式扣留                          │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
   SQLite（WAL 单文件）：runs / events / checkpoints / llm_profiles / …
   事件溯源：每步 checkpoint + 全量事件，WS/SSE 实时下发，可回放可导出
```

---

## 技术栈

| 层 | 技术 |
|---|------|
| 前端 | React 19 + Vite 6 + Tailwind 3 + React-Flow + Lucide + Web Speech API（语音输入） |
| 后端 | Node.js ≥ 20 + Fastify 5 + TypeScript 5（strict）+ ESM |
| LLM | openai SDK（任意兼容端点：DashScope / DeepSeek / OpenRouter / Ollama…），传输层重试分类 |
| 持久化 | SQLite（better-sqlite3，WAL 模式，schema 版本化迁移） |
| Skill | YAML frontmatter（gray-matter）+ chokidar 热重载 |
| 进度协议 | 自研 `[CORAL_PROGRESS]` stderr 单行 JSON 协议（Python + Node 双 SDK，见 [docs/AUTHORING_PROGRESS.md](./docs/AUTHORING_PROGRESS.md)） |
| 质量 | Vitest（403 用例）+ GitHub Actions（ubuntu/windows/macos × Node 20/22） |

---

## 测试与基准

- **测试**：404 个用例（Vitest），覆盖内核循环 / 门禁 / 上下文管理 / 持久化 / MCP / 技能运行时等模块；CI 在三平台（ubuntu / windows / macos × Node 20/22）全部通过。
- **GAIA 基准**：[docs/GAIA.md](./docs/GAIA.md) —— 官方 GAIA benchmark validation split，**82.0%**（50 题，确定性 exact match）。L1 86.4% / L2 **88.9%** / L3 60.0%。L2 超过 GPT-4+插件参考区间上限。
- **性能基准**：[docs/BENCHMARK.md](./docs/BENCHMARK.md) —— 上下文压缩收益（1.2MB 历史 → 169KB，-86%）、SQLite WAL 与 JSONL 持久化吞吐。脚本：`npx tsx scripts/benchmark.mts`。

---

## 内置工具清单（19 个）

| 工具 | 说明 | 权限 |
|------|------|------|
| `todo_write` | 可见任务清单（整体替换式，UI 实时更新） | auto |
| `fs_list` / `fs_read` / `fs_search` | 列目录 / 读文本 / 关键词搜索（二进制自动跳过并提示） | auto（只读） |
| `fs_write` / `fs_edit` | 写文件 / 精确片段编辑（产出统一 diff，走审批；改已有文件须先读过——事实门强制） | 随工作区档位 |
| `docx_read` / `docx_write` | Word .docx 读写（纯标准库 OOXML） | 读 auto / 写随档位 |
| `http_fetch` | 抓取任意 URL 并阅读 | auto |
| `shell_run` | 执行命令（沙箱 env 白名单 + 进程树终止） | 恒审批 |
| `memory_list` / `memory_read` / `memory_write` / `memory_search` / `memory_review` | 长期记忆读写（Markdown 文件；写入默认 create-only，覆盖需显式 overwrite；review 标记用户确认） | auto |
| `agent_spawn` | 派出子代理（独立上下文 / 工具子集 / 深度 ≤ 2 / 统一安全基线） | auto |
| `past_runs` | 检索历史运行 | auto |
| `evidence_read` | 取回证据记录（超大工具结果的不可变存档，支持分页） | auto |
| `dual_review` | 双独立评审与分歧仲裁 | auto |

---

## 技能生态

### 内置 Skill 清单

| Skill | 模式 | 说明 |
|-------|:--:|------|
| `summarize-document` | llm_only | 文档摘要 |
| `data-transform` | llm_only | 数据格式转换与结构化 |
| `policy-scraper` | script | 政策采集（流式 + MD/CSV 双产物）——场景包技能，见 examples/policy-analysis |
| `policy-to-post` | script | 政策转推文——场景包技能 |
| `information-filter` | script | 多源信息筛选 |
| `web-reader` | script | 网页正文抽取（零依赖 readability，article 策略 + 全文回退） |
| `web-search` | script | 联网搜索（三级后端：Tavily / SearXNG / 免 key 降级通道） |
| `official-doc-writer` | llm_only | 公文文本生成（通知 / 纪要等规范文种） |
| `official-doc-expander` | hybrid | 要点扩写为符合 GB/T 9704-2012 的党政机关公文 |
| `official-document-generator` | hybrid | 要点 → AI 辅助扩写 → 生成公文 docx |
| `deep-research` | llm_only | 深度调研：子问题分解 → 多源检索 → 交叉验证 → 带引用与置信分级的报告 |
| `goal-blueprint` | llm_only | 蓝图规划：目标 → 自包含步骤的施工计划（含依赖 / 并行组 / 对抗评审，可产出 Graph DAG） |
| `council-review` | llm_only | 多方议事：四个独立上下文的视角评审 + 分歧仲裁 + 异议存档 |
| `site-sentinel` | llm_only | 站点健康检查：八类信号的发布后冒烟测试，支持环境对比 |
| `story-board` | llm_only | 文件式项目推进：epic → story → sprint 的 Markdown 看板与状态流转 |
| `intel-collector` | llm_only | 情报采集：采集 → 提炼 → 增量归档，配合触发器做周期任务 |
| `prompt-doctor` | llm_only | 提示词审查：五维检查（触发 / 边界 / 输出契约 / 歧义 / 注入防护）与修订 |
| `decision-ledger` | llm_only | 决策账本：追加式多轮比较记录 + 一致性检查 + 晋升门槛 |
| `skill-authoring` | llm_only | 技能创作规范：查重 / 命名 / 触发式描述 / 质量自检 |

### 创建自定义 Skill

**方式 1：UI 多轮对话**——「技能创建」页描述需求，AI 反问澄清后生成（含 Node 脚本模板与提交质量门），落盘即热加载。

**方式 2：手写 SKILL.md**：

```markdown
---
name: my-skill
version: "1.0.0"
description: "我的自定义技能描述"
domain: custom
capabilities: [my_capability]
input_schema:
  type: object
  required: [input_text]
  properties:
    input_text: { type: string }
output_schema:
  type: object
  properties:
    result: { type: string }
execution_mode: llm_only
status: stable
tags: [自定义]
source: user
---

# 我的自定义技能

你是一个专业助手。请根据用户输入完成以下任务...
```

保存到 `skills/my-skill/SKILL.md` 即自动加载。完整规范见 [docs/SKILLS-STANDARD.md](./docs/SKILLS-STANDARD.md)。

---

## 核心能力详解

### Agentic Workspace（本地文件读写）
- 多工作区：命名绑定多个本地文件夹，随时切换，选择持久化
- 三档权限：`readonly` / `ask`（默认，写改需批准）/ `auto`
- 路径三层守卫：越界 / 同前缀兄弟目录 / 符号链接逃逸全部拦截
- 文件上传：Chat 页直接上传文件进工作区，附件与消息关联展示

### 长期记忆（文件式）
- `memory/` 目录 + Markdown，Agent 自主记录（用户偏好、项目约定、经验教训）
- 会话结束后自动提炼归档（可关闭）；Settings 页可视化编辑
- 信任分级：Agent 写入默认 `unreviewed`，用户确认后 `reviewed`

### 双执行语义（v1 DAG 编排保留）
- DAG 调度：goal → 规划引擎 → 多 Skill 并发执行，支持短路
- 重试语义：Skill 粒度重试，已成功节点不重跑
- 预算护栏：步数 / token 双上限，耗尽时优雅收尾，可从断点续接

---

## 关键 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` · `/api/stats` · `/api/config` | 健康 / 统计 / 配置（Key 脱敏） |
| POST | `/api/runs` | 发起运行（goal + sessionId + workspaceId + 预算） |
| GET | `/api/runs/:id` · `/events` · `/stream` | 详情 / 事件增量 / SSE 直播 |
| GET | `/api/runs/:id/export.md` · `/artifacts` | 导出运行报告 / 产物清单 |
| POST | `/api/runs/:id/cancel` · `/approvals/:aid` | 取消 / 审批决定（支持 scope=session） |
| GET/POST/PATCH/DELETE | `/api/workspaces` | 工作区 CRUD + 文件上传 / 预览 |
| GET/PUT/DELETE | `/api/skills/:name` | Skill 查询 / 编辑 / 删除（内置需二次确认） |
| POST | `/api/skills/import` | 导入 Agent Skills（目录 / git URL） |
| POST | `/api/skill-builder/sessions…` | 对话式技能创建 |
| GET/PUT/DELETE | `/api/memory…` | 记忆管理（Settings UI 同源） |
| GET/PUT | `/api/settings/run-budget` | 运行预算（token / 步数上限） |
| GET | `/api/habits` · POST `/api/habits/distill` | 习惯学习（列表 / 手动蒸馏 / 晋升） |
| GET | `/api/system/gc` · POST `/api/system/gc` | 配置自清理（扫描 / 逐项确认清理） |
| POST | `/api/prompt-optimize` | 提示词优化 |
| POST | `/api/tasks`（v1 DAG 模式） | 规划 → DAG → 技能编排 |
| WS | `/ws/events` | WebSocket 全局事件流 |

---

## 项目结构

```
CORAL/
├── LICENSE · .env.example · README.md · README.en.md · USE.md · DEMO.md
├── docs/                       ← 公开文档（技能规范 / 进度协议 / 基准 / 架构历史）
├── .github/workflows/ci.yml    ← CI：三平台 × Node 20/22
├── scripts/                    ← dev / start / benchmark 脚本
├── packages/
│   ├── server/                 ← Fastify 后端
│   │   └── src/
│   │       ├── kernel/         ← Agent Loop / RunEngine / 上下文管理 / 门禁 / 证据层
│   │       ├── tools/          ← 统一 Tool 抽象 + 内置工具 + 效果契约
│   │       ├── hooks/          ← 外部命令守卫（8 生命周期事件）
│   │       ├── providers/      ← LLM 接入（重试分类 / 退化归一化）
│   │       ├── skill-runtime/  ← SKILL.md 注册表 / 解析 / 导入 / 热重载 / 进度协议
│   │       ├── scheduler/      ← v1 DAG 调度器（取消/超时/重试语义）
│   │       ├── planning/       ← v1 规划引擎（goal → DAG）
│   │       ├── store/          ← SQLite + 版本化迁移 + 仓储
│   │       ├── api/            ← REST 路由
│   │       ├── event/          ← 事件总线（WS/SSE 双通道）
│   │       └── services/       ← LLM facade / 配置 / 记忆 / 工作区 / 习惯 / 预算
│   ├── web/                    ← React 前端（Chat 会话 / DAG 可视化 / 记忆 UI）
│   └── progress/               ← @coral/progress 进度协议 SDK（Node）
└── skills/                     ← 技能目录（文件系统即注册表，热重载）
    └── _lib/                   ← 进度协议 helper（Python + Node）+ readability
```

---

## 局限性

- **单用户、单进程**：面向个人本地使用设计，未做多租户与并发任务池；ESTOP 急停与审批记忆均为进程级语义。
- **压缩是有损的**：上下文收纳与摘要会丢弃旧工具结果的正文（可经证据记录取回）；确定性兜底摘要的质量低于 LLM 摘要。
- **评审与裁决依赖同一 LLM**：独立评审与自评的语义层由同一模型执行，独立性弱于人工评审；确定性启发式层不受此限。
- **门禁为启发式**：收工门的话术模式库与事实门的规则无法覆盖全部表述形态；均设有强制放行与告警，避免误拦阻塞交付。
- **MCP stdio 执行边界**：外部 MCP server 以本机子进程运行，其能力边界由各自实现决定；平台侧以注解映射与审批档位约束。

---

## Authors

**[Qiyao404](https://github.com/Qiyao404)** · **[alstar501](https://github.com/alstar501)** — 联合开发

## License

[MIT](./LICENSE) © 2026 Qiyao404 & alstar501
