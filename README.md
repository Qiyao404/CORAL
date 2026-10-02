# CORAL — 个人轻量级 Agent 运行时平台

**简体中文** | [English](./README.en.md)

[![CI](https://github.com/Qiyao404/CORAL/actions/workflows/ci.yml/badge.svg)](https://github.com/Qiyao404/CORAL/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **定位：本地优先、单命令启动、单文件存储的个人级 Agent 运行时**
> 自主 Agent Loop · 本地工作区读写 · 文件式长期记忆 · 技能生态

---

## 它能做什么

打开 Chat 页，用一句话描述目标，Agent 会**自主工作**：

- **自主循环**：模型自己决定下一步调什么工具，全程每一步实时可见、可随时停止
- **读写你的本地文件**：绑定一个工作区文件夹后，Agent 可以列目录、读文件、写改文件——写改前弹出 **diff 审批卡片**，你批准才落盘（三档权限：只读 / 询问 / 自动）
- **执行命令**：可选开启 shell 工具（每次执行都需审批），让它真的跑脚本、装依赖
- **联网**：给它任何网址，它自己抓取并阅读内容
- **长期记忆**：跨会话记住你的偏好与项目背景（就是你能直接打开编辑的 Markdown 文件）
- **派出子代理**：长任务自动隔离到独立上下文的 sub-agent，主线程不被噪音淹没
- **技能生态**：对话式创建技能、直接导入 Anthropic Agent Skills 格式技能、文件即注册表热重载

> 全程本地优先：SQLite 单文件存储、默认仅监听 127.0.0.1、密钥只存本机。没有 API Key？`--demo` 演示模式跑通全链路（结果带 mock 标记，绝不冒充真实输出）。

---

## 快速开始

```bash
# 1. 安装依赖（Node.js ≥ 20）
npm install

# 2. 配置环境（任何 OpenAI 兼容端点均可）
cp .env.example .env

# 3. 启动（后端 3001 + 前端 5173）
npm run dev
```

| 服务 | 地址 |
|------|------|
| Web UI（Chat / Skills / Tasks / Settings） | http://localhost:5173 |
| 后端 API | http://localhost:3001/api/health |

---

## 架构总览（v2）

```
┌──────────────────────────────────────────────────────────────────────┐
│  Web UI                                                               │
│  Chat（Agent 会话直播：todo 清单 / 工具卡片 / diff 审批 / 最终回答）      │
│  Skills（列表/编辑/导入/对话创建） Tasks（v1 编排） Settings（模型/工作区）│
└──────────────────────────────┬───────────────────────────────────────┘
                               │ REST + WS + SSE
┌──────────────────────────────▼───────────────────────────────────────┐
│  RunEngine（Free 模式入口：预算护栏 / 取消 / 事件溯源双写）               │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  Agent Loop（ReAct 主循环）                                      │ │
│  │  压缩检查 → LLM → 工具执行（审批位）→ 预算检查 → checkpoint        │ │
│  │  ├─ sub-agents（agent_spawn：独立上下文 / 工具子集 / 深度≤2）      │ │
│  │  └─ 上下文管理（工具结果裁剪 + 历史压缩，goal 永不丢失）            │ │
│  └───────────────────────────┬─────────────────────────────────────┘ │
│                              │ 统一 Tool 接口                          │
│  ┌───────────────────────────▼─────────────────────────────────────┐ │
│  │  Tool Registry：内置（fs 读写搜 / http_fetch / shell / memory /   │ │
│  │  todo / past_runs）│ Skills（SKILL.md 热重载）│ MCP（规划中）       │ │
│  └───────────────────────────┬─────────────────────────────────────┘ │
│  providers：OpenAI 兼容（DashScope/DeepSeek/OpenRouter/Ollama…）       │
│             + Anthropic 原生（prompt caching 默认开启）                 │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
   SQLite（WAL 单文件）：runs / events / checkpoints / llm_profiles / …
   事件溯源：每步 checkpoint + 全量事件，WS/SSE 实时下发，可回放
```

---

## 核心能力详解

### Agentic Workspace（本地文件读写）
- 多工作区：命名绑定多个本地文件夹，随时切换
- 三档权限：`readonly`（只读）/ `ask`（默认，写改弹 diff 批准）/ `auto`（直接执行）
- 路径三层守卫：越界 / 同前缀兄弟目录 / 软链接逃逸全部拦截
- Agent 可用：列目录、读文件、写文件、精确片段编辑（产出统一 diff）、关键词搜索、跑命令

### 长期记忆（文件式）
- `memory/` 目录 + Markdown：`memory_list / read / write / search` 四工具
- Agent 按指引自主记录（用户偏好、项目约定、教训）；会话结束后自动提炼归档
- 记忆就是你能直接打开编辑的文本——透明、可信、零依赖

### 双执行语义
- 真·取消：AbortSignal 全链路贯穿（LLM 调用 / 脚本进程树强杀）
- 真·超时：规划 / Agent / 脚本三层 deadline，超时按进程树强杀
- 重试分类学：瞬时错误（网络/429/5xx）指数退避重试，永久错误零重试；Skill 粒度重试，已成功的绝不重跑
- 预算护栏：步数 / token 双上限，耗尽时优雅收尾（总结已完成与剩余）

### 技能（Skills）
- `SKILL.md` 即技能：YAML frontmatter + Markdown 正文 + 附属脚本，保存即热加载
- 对话式创建（Skill Builder）：描述需求 → AI 反问澄清 → 生成 Node 脚本（零 Python 依赖）→ 落盘即用
- 一键导入 Anthropic Agent Skills：本地目录 / 父目录批量 / GitHub URL，附兼容性报告
- 进度协议：脚本通过 stderr 单行 JSON 实时上报进度/日志/产物（Python 与 Node 双 SDK）

---

## 关键 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/runs` | 发起 Agent 运行（goal + sessionId + workspaceId + 预算） |
| GET | `/api/runs/:id` · `/api/runs/:id/events` · `/api/runs/:id/stream` | 详情 / 事件增量 / SSE 直播 |
| POST | `/api/runs/:id/cancel` · `/api/runs/:id/approvals/:aid` | 取消 / 审批决定 |
| GET/POST/PATCH/DELETE | `/api/workspaces` | 工作区 CRUD + 激活 |
| POST | `/api/skills/import` | 导入 Agent Skills（目录/git URL） |
| POST | `/api/skill-builder/sessions…` | 对话式技能创建 |
| POST | `/api/tasks`（v1 DAG 模式） | 规划→DAG→技能编排 |
| GET/PUT/DELETE | `/api/skills/:name` | 技能 CRUD |

---

## 项目结构

```
CORAL/
├── packages/
│   ├── server/src/
│   │   ├── kernel/        ← Agent Loop / RunEngine / 上下文管理
│   │   ├── tools/         ← 统一 Tool 抽象 + 内置工具（fs/http/shell/memory…）
│   │   ├── providers/     ← 双厂商 LLM 接入 + 重试分类学
│   │   ├── skill-runtime/ ← SKILL.md 注册表 / 解析 / 导入 / 热重载
│   │   ├── store/         ← SQLite + 版本化迁移 + 仓储
│   │   ├── api/           ← REST 路由
│   │   └── services/      ← LLM facade / 记忆 / 工作区 / 技能构建器
│   ├── web/               ← React 前端（Chat 会话直播 / DAG 可视化 / 设置）
│   └── progress/          ← @coral/progress 进度协议 SDK（Node）
├── skills/                ← 技能目录（含 _lib 进度协议 helper：Python + Node）
└── docs/                  ← 文档（协议规范 / 技能编写标准）
```

---

## 开发进度

| 阶段 | 内容 | 状态 |
|------|------|:---:|
| M0 | 地基：SQLite / 真取消 / 真超时 / 重试语义 / 安全默认 / 测试+CI | ✅ |
| M1 | Harness 内核：Agent Loop · sub-agents · Agentic Workspace · 长期记忆 · 双 provider · 技能导入 · Chat 会话 | ✅ |
| M2 | Graph 模式：确定性 DAG + checkpoint / 人工审批中心 / 断点恢复 | 🚧 进行中 |
| M3 | MCP 双向桥 · 定时与 Webhook 触发器 · 进度协议 SDK 发布（npm/PyPI） | ⏳ |
| M4 | Time-Travel 调试器（回滚/分叉重放）· `npx coral` 单命令分发 | ⏳ |

质量基线：Vitest 241 用例 · GitHub Actions 三平台（ubuntu/windows/macos × Node 20/22）· TypeScript strict

---

## Authors

**[Qiyao404](https://github.com/Qiyao404)** · **[alstar501](https://github.com/alstar501)** — 联合开发

## License

[MIT](./LICENSE) © 2026 Qiyao404 & alstar501
