# CORAL — 个人轻量级 Agent 运行时平台

**简体中文** | [English](./README.en.md)

[![CI](https://github.com/Qiyao404/CORAL/actions/workflows/ci.yml/badge.svg)](https://github.com/Qiyao404/CORAL/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **版本：v2.0.0-M1（持续迭代中）**
> **定位：本地优先、单命令启动、单文件存储的个人级 Agent 运行时**

---

## 一句话定位

CORAL 是一个**由 LLM 原生驱动的个人 Agent 运行时**：接收自然语言目标（含语音），Agent 自主规划、调用工具、读写本地文件，全程实时可观测、可审批、可中断：

- **自主规划**：开工先建任务清单（todo checklist），执行中逐项打勾，你全程看得见
- **工具调用**：16 个内置工具（文件读写 / Word 文档 / 联网抓取 / 长期记忆 / 子代理…）+ 技能生态
- **全程可观测**：流式逐字直播 + 事件溯源（全量事件落库，可回放、可导出 Markdown 报告）
- **实时已连接**：SSE / WebSocket 双通道，每一步（含审批卡片）即时到达浏览器
- **本地优先**：SQLite 单文件存储、默认仅监听 127.0.0.1、密钥只存本机、零云依赖

> 没有 API Key？`npm run dev:server -- --demo` 演示模式照样跑通全链路（结果带 mock 标记，绝不冒充真实输出）。

---

## 工程亮点：与真实模型搏斗出来的细节

这些是 CORAL 区别于"又一个 Agent demo"的地方 —— 全部来自真实模型（DeepSeek / Kimi）长跑实测中暴露并修复的问题：

**1. DSML 退化归一化（provider 层）**
DeepSeek V3.2 会间歇性把工具调用以 `<｜｜DSML｜｜ invoke name="...">` 文本打印进 content 而非走标准 tool_calls 通道。CORAL 在 provider 层做**分割式解析归一化**（全角/ASCII 双形态免疫），退化调用照常执行并标记 `degraded`；流式路径用**游标扣留法**（marker-aware withholding）把疑似标记前缀扣在缓冲区、确认后再放行 —— 既不让乱码漏到用户屏幕，也永不提前断流丢数据。

**2. 工具名幻觉自动纠正（alias 层）**
模型会幻觉出不存在的工具名（`web_fetch`、`fetch_url`…）。别名表 + 编辑距离 ≤ 2 的模糊匹配自动纠正到真实工具，并在结果里告知模型"已纠正，后续请用正确名"；彻底无法纠正时返回 `TOOL_NOT_FOUND` + 完整可用工具清单，模型下一轮自愈。

**3. 任务清单三重保障（可观测性）**
"自主规划"不能赌模型自觉：① 系统提示强制开局先 `todo_write` 列计划；② 模型跳过时引擎自动注入一次性提醒（`loop.todo_reminder` 留痕）；③ 终态自动收口 —— 模型忘了把最后一项标 completed？引擎合成最终 `todo.updated`，UI 永远不会"任务做完了还在转圈"。

**4. 事件溯源 + Run 导出**
`events` 表 + EventBus 双写：每一次 LLM 调用、工具执行、审批、清单变更都是可回放的事件流；一键导出整次运行的 Markdown 时间线报告（`GET /api/runs/:id/export.md`）。

**5. 多轮会话 checkpoint 续接**
Agent 每步落 checkpoint；同一会话的下一轮自动加载上次完整上下文（读过的文件、做过的工具调用都在），预算耗尽可一键"续接"从断点继续干。

**6. 上下文管理（长任务不崩）**
单条超大工具结果自动裁剪 + 历史超限自动摘要压缩，goal 永远保留 —— 深夜跑 16 步的 Word 分析任务不因上下文爆炸而失忆。

**7. 真·取消 / 真·超时 / 重试分类学（M0 地基）**
AbortSignal 全链路贯穿（LLM 调用、脚本进程树强杀）；错误分类（瞬时/永久/取消）+ 指数退避，已交付内容的流式调用绝不重试（防重复输出）。

**8. 文件式长期记忆 + 自动提炼**
`memory/` 就是普通 Markdown，四工具读写（`memory_list/read/write/search`），Agent 按指引记录偏好与教训，会话结束自动蒸馏归档 —— 你随时可以直接打开编辑，透明可信。

**9. 工具效果契约（声明式审批）**
每个工具声明自己的效果位（写文件/起进程/联网/幂等），审批档位由效果组合**推导**而非手工标注 —— 声明只能让审批更严、不能更松（注册期 fail-closed 封缄，手滑标 `auto` 的写盘工具会被自动升为 `approval`）。外部 MCP 工具的标准注解（readOnly/destructive/idempotent）自动映射进同一契约。

**10. 证据记录层（summary-first 结果管理）**
超大工具结果（网页全文、长文档、命令输出）不再硬塞上下文：整体落盘为**不可变证据记录**，上下文只留"摘要预览 + 记录 ID"，模型需要细节时用 `evidence_read` 分页取回 —— 长任务的上下文不再被单个大结果撑爆，且任何结果都可事后审计。

**11. 三层上下文压缩 + 熔断器**
单条裁剪（永远开）→ 收纳旧工具结果（软水位，cache-safe，归档进证据层可回溯）→ 全量 LLM 摘要（硬水位）；4 档用量预警（正常/警告/危急/阻塞）；摘要连续失败 3 次自动熔断 —— 压缩系统本身故障绝不拖死任务。

**12. 事实门（写前必读，确定性强制）**
改/覆盖一个已存在的文件之前，本任务内必须先读过它 —— 没读过就改 = 盲改，运行时直接拒绝并给出调查指令，读过重试即放行（同一目标连拦 3 次自动放行防死锁，全程事件留痕）。新建文件不设门（由权限档把关）。这条规则是纯确定性代码，不赌模型自觉。

**13. 收工门（合理化话术审计）**
复杂任务的最终回答若含"这是历史遗留问题 / 测试先跳过 / 后续再修"式开脱话术（中英双语模式库），直接打回要求要么真做完、要么老实列"未完成事项"；最多打回 2 次，第 3 次强制放行并告警。简单任务零打扰。

**14. 习惯学习管线（观察 → 置信度 → 晋升技能）**
运行时把每次工具调用确定性记录为观察日志，攒够阈值自动蒸馏出"触发→行动"式协作习惯，置信度随重复观察上升（0.3 试探 → 0.7 自动注入 → 0.9 封顶）；**置信度 ≥0.8 且出现在 ≥2 个会话**才可一键晋升为正式技能（单会话的巧合不配成为技能），30 天未复现自动衰减。你的 Agent 用得越久越懂你，且全程文件透明可纠偏。

**15. `coral doctor` 分发健康自检**
`npx coral doctor` 一条命令分诊七类高频故障：构建产物新鲜度（源码比 dist 新 = 跑的是旧代码）、端口占用（占用者是不是 CORAL 实例）、数据目录可写、磁盘三级水位、数据库完整性、模型配置、技能损坏清单、MCP 连接态 —— 每项带修复建议。

**16. 产物即文件（回复底部一键预览）**
每次回复的底部自动列出本轮生成/修改的全部文件（chips 形式），点击即在右侧面板预览：Markdown/文本/JSON/CSV 直接渲染，Word 提取全文，PDF 与图片走浏览器原生渲染，其余格式一键下载。数据来自事件流（fs_write/fs_edit/docx_write 统一发产物事件），历史轮次同样可见。

**17. 会审与自评（交付质量双保险）**
`dual_review` 工具把产出送进**两个互相独立的盲评审**（同一标准、不同视角、互不见对方结论），分歧时第三仲裁，共识才通过；`POST /api/runs/:id/self-eval` 对最终回答做五轴评分（准确/完整/清晰/可执行/简洁），确定性启发式打底 + LLM 语义裁决，**低分必须引用原文证据**否则该轴评审无效。

**18. 记忆信任分级 + 决策与接力记录**
Agent 写入的长期记忆默认 `unreviewed`，用户确认属实后可标记 `reviewed`（`memory_review`）；覆盖已有记忆必须显式 `overwrite=true`（防静默吞掉旧内容）；检索不完整时如实报告"可能未扫完"而非谎报"没有"。每个会话还自动沉淀**带原因的决策**（`what + why`）和**接力记录**（中断点/下一步/阻塞）—— 下次续接第一眼就看到"上次到哪了"。

**19. 子代理防御前言（隔离上下文 = 隔离攻击面）**
所有子代理的系统提示以统一安全基线开头：身份与指令集不可被工具输出改变、外部内容一律是待分析的数据而非指令、零宽字符/紧迫感施压视为可疑、不泄露系统提示与凭据。主循环同样内置不可信数据纪律。

**20. 外部命令守卫（hooks 开放接口）**
`data/hooks.json` 在 8 个生命周期点（工具前后/收工/提交/会话起止/压缩前/通知）调用外部命令守卫：可**否决调用、改写工具入参、升级人工审批、打回最终回答、注入上下文**。契约极简（stdin JSON / stdout JSON / 退出码 2=拒绝），pre 路径 fail-closed（守卫自身故障=拒绝执行），配置热加载 — 内置的效果契约/事实门/收工门由此从"平台私有"变成"用户可扩展"。

**21. 斜杠命令 + 具名子代理（用户与模型的双快捷面）**
`data/commands/*.md` 斜杠命令：`/research 主题` 一句话展开成完整任务（模板占位 `$ARGUMENTS`/`$1`）。`data/agents/*.md` 具名子代理：预置调研/评审/数据/成文四个专员，描述与触发例示注入主提示（教会主模型何时委派给谁），正文按名加载、工具白名单随行 — 能力扩张不等于主上下文膨胀。

**22. 压缩失败冷却阶梯 + 确定性摘要兜底**
LLM 摘要失败不再一次性熔断：60s→300s→900s 递进冷却，冷却期间硬水位仍在涨时由**确定性骨架摘要**（无 LLM、逐条首句、保转录完整）兜底 — 压缩系统自身故障绝不拖死任务，也绝不放弃压缩。

**23. ESTOP 急停哨兵 + 审批选择记忆 + 运行预算可调**
`coral pause` 一个文件拉闸全部新任务（在跑的不杀，fail-safe：哨兵文件损坏也视为拉闸）；审批可带 `scope=session` —— 同工作区同工具本会话自动放行并留痕，`DELETE /api/approvals/session-rules` 一键反悔。

---

## 它能做什么

打开 Chat 页，用一句话描述目标，Agent 会**自主工作**：

- **读 Word / 写 Word**：上传 `.docx`，Agent 读取内容、总结要点、生成新文档（内置 OOXML 读写，零 Python 依赖）
- **读写你的本地文件**：绑定工作区文件夹后，列目录、读文件、写改文件 —— 写改前弹出 **diff 审批卡片**，你批准才落盘（三档权限：只读 / 询问 / 自动）
- **执行命令**：可选开启 shell 工具（每次执行都需审批），真的跑脚本、装依赖
- **联网**：给它任何网址，它自己抓取并阅读正文（零依赖 readability 抽取）
- **派出子代理**：长任务自动隔离到独立上下文的 sub-agent（深度 ≤ 2），主线程不被噪音淹没
- **技能生态**：对话式创建技能、一键导入业界通用 Agent Skills 格式（SKILL.md）、文件系统即注册表热重载

详细使用指南 / 任务示例 / 故障排除 → [USE.md](./USE.md)

---

## 快速开始

**方式一：单命令（推荐）** — 构建产物一体化，自检后启动：

```bash
npm install && npm run build && npm start   # coral CLI：自检（端口/数据库/模型配置）→ http://127.0.0.1:3001
```

**方式二：开发模式**（前后端分离热更新）：

```bash
npm install
cp .env.example .env   # 填入你的 API Key（任何 OpenAI 兼容端点）
npm run dev            # 后端 3001 + 前端 5173
```

```bash
# 没有 API Key？演示模式跑通全链路（结果带 mock 标记）
npm run dev:server -- --demo
```

| 服务 | 地址 |
|------|------|
| Web UI（Chat / Skills / Tasks / Settings） | http://localhost:5173 |
| 后端 API | http://localhost:3001/api/health |

已在 DeepSeek、DashScope（Kimi）上实测；OpenRouter / Ollama 等任意 OpenAI 兼容端点开箱即用。

---

## 架构总览（v2）

```
┌──────────────────────────────────────────────────────────────────────┐
│  Web UI                                                               │
│  Chat（Agent 会话直播：todo 清单 / 工具卡片 / diff 审批 / 最终回答）      │
│  Skills（列表/编辑/导入/对话创建） Tasks（v1 DAG 编排） Settings（模型/  │
│  工作区/记忆）                                                          │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ REST + WS + SSE
┌──────────────────────────────▼───────────────────────────────────────┐
│  RunEngine（Free 模式入口：预算护栏 / 取消 / 事件溯源双写）               │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  Agent Loop（ReAct 主循环）                                      │ │
│  │  压缩检查 → LLM → 工具执行（审批位）→ 预算检查 → checkpoint        │ │
│  │  ├─ todo 保障（开局强制 / 跳过提醒 / 终态收口）                    │ │
│  │  ├─ sub-agents（agent_spawn：独立上下文 / 工具子集 / 深度≤2）      │ │
│  │  └─ 上下文管理（工具结果裁剪 + 历史压缩，goal 永不丢失）            │ │
│  └───────────────────────────┬─────────────────────────────────────┘ │
│                              │ 统一 Tool 接口                          │
│  ┌───────────────────────────▼─────────────────────────────────────┐ │
│  │  Tool Registry：内置 16 工具（fs / docx / http / shell / memory / │ │
│  │  todo / spawn / past_runs）│ Skills（SKILL.md 热重载）│ MCP（规划）│ │
│  └───────────────────────────┬─────────────────────────────────────┘ │
│  providers：OpenAI 兼容（DashScope/DeepSeek/OpenRouter/Ollama…）       │
│            + DSML 退化归一化 + 工具名纠正 + 流式游标扣留                 │
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
| LLM | openai SDK（任意兼容端点：DashScope / DeepSeek / OpenRouter / Ollama…），传输层重试分类学 |
| 持久化 | SQLite（better-sqlite3，WAL 模式，schema 版本化迁移） |
| Skill | YAML frontmatter（gray-matter）+ chokidar 热重载 |
| 进度协议 | 自研 `[CORAL_PROGRESS]` stderr 单行 JSON 协议（Python + Node 双 SDK，见 [docs/AUTHORING_PROGRESS.md](./docs/AUTHORING_PROGRESS.md)） |
| 质量 | Vitest（321 用例）+ GitHub Actions（ubuntu/windows/macos × Node 20/22） |

---

## 内置工具清单（19 个）

| 工具 | 说明 | 权限 |
|------|------|------|
| `todo_write` | 可见任务清单（整体替换式，UI 实时打勾） | auto |
| `fs_list` / `fs_read` / `fs_search` | 列目录 / 读文本 / 关键词搜索（二进制自动跳过并提示） | auto（只读） |
| `fs_write` / `fs_edit` | 写文件 / 精确片段编辑（产出统一 diff，走审批；改已有文件先读过——事实门强制） | 随工作区档位 |
| `docx_read` / `docx_write` | Word .docx 读写（纯标准库 OOXML，零 Python 依赖） | 读 auto / 写随档位 |
| `http_fetch` | 抓取任意 URL 并阅读 | auto |
| `shell_run` | 执行命令（沙箱 env 白名单 + 进程树强杀） | **恒审批** |
| `memory_list` / `memory_read` / `memory_write` / `memory_search` / `memory_review` | 长期记忆五件套（Markdown 文件；写入默认 create-only，覆盖需显式 overwrite；review 标记用户确认） | auto |
| `agent_spawn` | 派出子代理（独立上下文 / 工具子集 / 深度 ≤ 2 / 标准防御前言） | auto |
| `past_runs` | 检索历史运行（"上次那个任务怎么做的"） | auto |
| `evidence_read` | 取回证据记录（超大工具结果的不可变存档，支持分页） | auto |
| `dual_review` | 双盲会审（两个独立盲评审 + 分歧仲裁，共识才通过） | auto |

---

## 技能生态

### 内置 Skill 清单

| Skill | 模式 | 说明 |
|-------|:--:|------|
| `summarize-document` | llm_only | 文档智能摘要 |
| `data-transform` | llm_only | 数据格式转换与结构化 |
| `policy-scraper` | script | 政策采集（流式 + MD/CSV 双产物）— *场景包技能，见 examples/policy-analysis* |
| `policy-to-post` | script | 政策转推文 — *场景包技能，见 examples/policy-analysis* |
| `information-filter` | script | 多源信息筛选（公司画像驱动） |
| `web-reader` | script | 网页正文抽取（零依赖 readability，article 策略 + 全文回退） |
| `official-doc-writer` | llm_only | 公文文本生成（通知/纪要等规范文种） |
| `official-doc-expander` | hybrid | 要点扩写为符合 GB/T 9704-2012 的党政机关公文 |
| `official-document-generator` | hybrid | 要点 → AI 辅助扩写 → 生成公文 docx |
| `deep-research` | llm_only | 深度调研：子问题分解→多源抓取→交叉验证→带引用与置信分级的报告 |
| `goal-blueprint` | llm_only | 蓝图规划：一句话目标→自包含步骤的施工计划（含依赖/并行组/对抗评审，可产出 Graph DAG） |
| `council-review` | llm_only | 多方议事：四视角独立评审（agent_spawn 反锚定）+ 分歧仲裁 + 异议存档 |
| `site-sentinel` | llm_only | 站点哨兵：八类信号的发布后冒烟检查，支持 staging/生产对比 |
| `story-board` | llm_only | 文件式项目推进：epic→story→sprint 的 Markdown 看板与状态流转 |
| `intel-collector` | llm_only | 情报采集：采集→提炼→增量归档三段式，配合触发器做周期任务 |
| `prompt-doctor` | llm_only | 提示词体检：五维检查（触发/边界/输出契约/歧义/注入防护）+ 修订版 |
| `decision-ledger` | llm_only | 决策账本：追加式多轮比较记录 + 一致性检查 + 晋升门槛（防"重复即验证"） |

### 创建自定义 Skill

**方式 1：UI 多轮对话**（推荐）— 左侧「技能创建」→ 描述需求 → AI 反问澄清 → 生成 Node 脚本（零 Python 依赖）→ 落盘即热加载。

**方式 2：手写 SKILL.md**（二次开发者）：

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
- 三档权限：`readonly`（只读）/ `ask`（默认，写改弹 diff 批准）/ `auto`（直接执行）
- 路径三层守卫：越界 / 同前缀兄弟目录 / 软链接逃逸全部拦截
- 上传即用：Chat 页直接上传文件进工作区（1MB 上限，分块 base64），附件跟消息走（发送即消耗，消息上可见附带清单）

### 长期记忆（文件式）
- `memory/` 目录 + Markdown，Agent 自主记录（用户偏好、项目约定、教训）
- 会话结束后自动提炼归档（可关）；Settings 页可视化编辑
- 记忆就是你能直接打开编辑的文本 —— 透明、可信、零依赖

### 双执行语义（v1 DAG 编排保留）
- DAG 调度：goal → 规划引擎 → 多 Skill 并发执行，优雅短路
- 重试语义：Skill 粒度重试，已成功的绝不重跑
- 预算护栏：步数 / token 双上限，耗尽时优雅收尾（总结已完成与剩余），可一键续接

---

## 关键 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` · `/api/stats` · `/api/config` | 健康 / 统计 / 配置（Key 脱敏） |
| POST | `/api/runs` | 发起 Agent 运行（goal + sessionId + workspaceId + 预算） |
| GET | `/api/runs/:id` · `/events` · `/stream` | 详情 / 事件增量 / SSE 直播 |
| GET | `/api/runs/:id/export.md` | 导出运行报告（Markdown 时间线） |
| POST | `/api/runs/:id/cancel` · `/approvals/:aid` | 取消 / 审批决定 |
| GET/POST/PATCH/DELETE | `/api/workspaces` | 工作区 CRUD + 文件上传 |
| GET/PUT/DELETE | `/api/skills/:name` | Skill 查询 / 编辑 / 删除（内置需二次确认） |
| POST | `/api/skills/import` | 导入 Agent Skills（目录 / git URL） |
| POST | `/api/skill-builder/sessions…` | 对话式技能创建 |
| GET/PUT/DELETE | `/api/memory…` | 记忆管理（Settings UI 同源） |
| POST | `/api/tasks`（v1 DAG 模式） | 规划 → DAG → 技能编排 |
| WS | `/ws/events` | WebSocket 全局事件流 |

---

## 项目结构

```
CORAL/
├── LICENSE · .env.example · README.md · README.en.md · USE.md
├── docs/                       ← 公开文档（技能规范 / 进度协议 / 架构与需求历史）
├── .github/workflows/ci.yml    ← CI：三平台 × Node 20/22
├── scripts/                    ← dev / start / e2e 冒烟脚本
├── packages/
│   ├── server/                 ← Fastify 后端
│   │   └── src/
│   │       ├── kernel/         ← Agent Loop / RunEngine / 上下文管理（v2 心脏）
│   │       ├── tools/          ← 统一 Tool 抽象 + 内置 16 工具 + 别名纠正
│   │       ├── providers/      ← LLM 接入（重试分类学 / DSML 退化归一化）
│   │       ├── skill-runtime/  ← SKILL.md 注册表 / 解析 / 导入 / 热重载 / 进度协议
│   │       ├── scheduler/      ← v1 DAG 调度器（取消/超时/重试语义）
│   │       ├── planning/       ← v1 规划引擎（goal → DAG）
│   │       ├── store/          ← SQLite + 版本化迁移 + 仓储
│   │       ├── api/            ← REST 路由
│   │       ├── event/          ← 事件总线（WS/SSE 双通道）
│   │       └── services/       ← LLM facade / 配置 / 记忆 / 工作区 / 技能构建器
│   ├── web/                    ← React 前端（Chat 会话直播 / DAG 可视化 / 记忆 UI）
│   └── progress/               ← @coral/progress 进度协议 SDK（Node）
└── skills/                     ← 技能目录（文件系统即注册表，热重载）
    └── _lib/                   ← 进度协议 helper（Python + Node）+ readability
```

---

## 开发进度（v2）

| 阶段 | 内容 | 状态 |
|------|------|:---:|
| M0 | 地基：SQLite / 真取消 / 真超时 / 重试语义 / 安全默认 / 测试 + CI | ✅ |
| M1 | Harness 内核：Agent Loop · sub-agents · Agentic Workspace · 长期记忆 · 双 provider · 技能导入 · Chat 会话 · 创新五件套 | ✅ |
| M2 | Graph 模式：DSL + 事件驱动引擎 + goal→graph AI 编译 + 节点审批（改参数续跑）+ 断点恢复 + Workflow 页 | ✅ |
| M3 | MCP 双向桥（coral mcp serve + 外部 server 接入）· 定时/cron/Webhook 触发器 · 进度协议 SDK 双语言包 | ✅ |
| M4 | Time-Travel 调试器（checkpoint 时间轴/fork 重跑）· 内置技能五件 · `coral` CLI 单命令 · 场景包 | ✅ |

质量基线：Vitest 321 用例全绿 · GitHub Actions 三平台（ubuntu/windows/macos × Node 20/22）· TypeScript strict

---

## Authors

**[Qiyao404](https://github.com/Qiyao404)** · **[alstar501](https://github.com/alstar501)** — 联合开发

## License

[MIT](./LICENSE) © 2026 Qiyao404 & alstar501
