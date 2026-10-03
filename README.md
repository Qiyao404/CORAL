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

---

## 它能做什么

打开 Chat 页，用一句话描述目标，Agent 会**自主工作**：

- **读 Word / 写 Word**：上传 `.docx`，Agent 读取内容、总结要点、生成新文档（内置 OOXML 读写，零 Python 依赖）
- **读写你的本地文件**：绑定工作区文件夹后，列目录、读文件、写改文件 —— 写改前弹出 **diff 审批卡片**，你批准才落盘（三档权限：只读 / 询问 / 自动）
- **执行命令**：可选开启 shell 工具（每次执行都需审批），真的跑脚本、装依赖
- **联网**：给它任何网址，它自己抓取并阅读正文（零依赖 readability 抽取）
- **派出子代理**：长任务自动隔离到独立上下文的 sub-agent（深度 ≤ 2），主线程不被噪音淹没
- **技能生态**：对话式创建技能、一键导入 Anthropic Agent Skills 格式、文件系统即注册表热重载

详细使用指南 / 任务示例 / 故障排除 → [USE.md](./USE.md)

---

## 快速开始

```bash
# 1. 安装依赖（Node.js ≥ 20）
npm install

# 2. 配置环境（填入你的 API Key，任何 OpenAI 兼容端点均可）
cp .env.example .env

# 3. 启动（后端 3001 + 前端 5173）
npm run dev
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
| 质量 | Vitest（263 用例）+ GitHub Actions（ubuntu/windows/macos × Node 20/22） |

---

## 内置工具清单（16 个）

| 工具 | 说明 | 权限 |
|------|------|------|
| `todo_write` | 可见任务清单（整体替换式，UI 实时打勾） | auto |
| `fs_list` / `fs_read` / `fs_search` | 列目录 / 读文本 / 关键词搜索（二进制自动跳过并提示） | auto（只读） |
| `fs_write` / `fs_edit` | 写文件 / 精确片段编辑（产出统一 diff，走审批） | 随工作区档位 |
| `docx_read` / `docx_write` | Word .docx 读写（纯标准库 OOXML，零 Python 依赖） | 读 auto / 写随档位 |
| `http_fetch` | 抓取任意 URL 并阅读 | auto |
| `shell_run` | 执行命令（沙箱 env 白名单 + 进程树强杀） | **恒审批** |
| `memory_list` / `memory_read` / `memory_write` / `memory_search` | 长期记忆四件套（Markdown 文件） | auto |
| `agent_spawn` | 派出子代理（独立上下文 / 工具子集 / 深度 ≤ 2） | auto |
| `past_runs` | 检索历史运行（"上次那个任务怎么做的"） | auto |

---

## 技能生态

### 内置 Skill 清单

| Skill | 模式 | 说明 |
|-------|:--:|------|
| `summarize-document` | llm_only | 文档智能摘要 |
| `data-transform` | llm_only | 数据格式转换与结构化 |
| `policy-scraper` | script | 政策采集（流式 + MD/CSV 双产物 + 站点参数） |
| `policy-to-post` | script | 政策转推文（三输入互斥校验） |
| `information-filter` | script | 多源信息筛选（公司画像驱动） |
| `web-reader` | script | 网页正文抽取（零依赖 readability，article 策略 + 全文回退） |
| `official-doc-writer` | llm_only | 公文文本生成（通知/纪要等规范文种） |
| `official-doc-expander` | hybrid | 要点扩写为符合 GB/T 9704-2012 的党政机关公文 |
| `official-document-generator` | hybrid | 要点 → AI 辅助扩写 → 生成公文 docx |

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
| M2 | Graph 模式：确定性 DAG + checkpoint / 人工审批中心 / 断点恢复 | 🚧 进行中 |
| M3 | MCP 双向桥 · 定时与 Webhook 触发器 · 进度协议 SDK 发布（npm/PyPI） | ⏳ |
| M4 | Time-Travel 调试器（回滚/分叉重放）· `npx coral` 单命令分发 | ⏳ |

质量基线：Vitest 263 用例全绿 · GitHub Actions 三平台（ubuntu/windows/macos × Node 20/22）· TypeScript strict

---

## Authors

**[Qiyao404](https://github.com/Qiyao404)** · **[alstar501](https://github.com/alstar501)** — 联合开发

## License

[MIT](./LICENSE) © 2026 Qiyao404 & alstar501
