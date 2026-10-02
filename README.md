# CORAL — 个人轻量级 Agent 运行时平台

**简体中文** | [English](./README.en.md)

[![CI](https://github.com/Qiyao404/CORAL/actions/workflows/ci.yml/badge.svg)](https://github.com/Qiyao404/CORAL/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **版本：v2.0.0-M0（持续迭代中）**
> **定位：本地优先、单命令启动、单文件存储的个人级 Agent 运行时**

---

## 一句话定位

CORAL 是一个 **由 LLM 原生驱动、文件系统即技能注册表、组合任务自动编排** 的多智能体协作平台：

- 接收自然语言目标（含语音），自动分解为多 Skill 协作的 DAG 并发执行
- 流式可观测：进度 + 日志 + 产物全程实时可见，任务可随时取消
- 业务用户可在 UI 上**自助创建 / 编辑 / 删除技能**，无需写代码
- 本地优先：SQLite 单文件存储、默认仅监听 127.0.0.1、密钥只存本机

> v2 方向（进行中）：Agent Loop（自主循环 + sub-agents）、Graph 模式（checkpoint / 人工审批 / 断点恢复）、Agentic Workspace（本地文件读写）、MCP 双向桥、Time-Travel 调试器。详见 [docs/V2_PLAN.md](./docs/V2_PLAN.md)。

---

## 快速启动

```bash
# 1. 安装依赖（Node.js ≥ 20）
npm install

# 2. 配置环境（填入你的 API Key，任何 OpenAI 兼容端点均可）
cp .env.example .env

# 3. 开发模式启动（后端 3001 + 前端 5173）
npm run dev
```

```bash
# 没有 API Key？显式演示模式照样跑通全链路（结果带 mock 标记，绝不冒充真实输出）
npm run dev:server -- --demo
```

| 服务 | 地址 |
|------|------|
| 前端 UI | http://localhost:5173 |
| 后端 API | http://localhost:3001/api/health |

详细使用 / 任务示例 / 故障排除 → [USE.md](./USE.md)

---

## 架构总览

```
┌──────────────────────── 接入层（Web Dashboard + REST + WS/SSE）────────────────────────┐
│  Dashboard │ Chat(语音) │ SkillBuilder │ Skills CRUD │ Tasks 实时(DAG 可视化)          │
└──────────────────────────────────────┬────────────────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼────────────────────────────────────────────────┐
│  EventBus（发布订阅 + WS/SSE 双通道，全量事件落库可回放）                                │
└──────────┬──────────────────────┬──────────────────────────┬──────────────────────────┘
           ▼                      ▼                          ▼
   规划引擎（goal→DAG）     DAG 调度器（并发/优雅短路）    Skill Builder（对话生成技能）
           │                      │                          │
           └──────────┬───────────┴──────────────────────────┘
                      ▼
   SkillExecutor（llm_only / script / hybrid 三路径）
   · 真·取消与超时：AbortSignal 全链路贯穿，脚本按进程树强杀
   · 重试语义：错误分类（瞬时/永久/取消）+ 指数退避抖动，Skill 粒度重试
   · [CORAL_PROGRESS] stderr 协议：脚本实时进度/日志/产物上报
                      │
                      ▼
   SQLite（WAL 单文件）：runs / events / checkpoints / llm_profiles / mcp_servers / kv
```

---

## 技术栈

| 层 | 技术 |
|---|------|
| 前端 | React 19 + Vite 6 + Tailwind 3 + React-Flow + Lucide + Web Speech API |
| 后端 | Node.js ≥ 20 + Fastify 5 + TypeScript 5（strict） |
| LLM | openai SDK（任意兼容端点：DashScope / DeepSeek / OpenRouter / Ollama…），传输层自动重试 |
| 持久化 | SQLite（better-sqlite3，WAL 模式，schema 版本化迁移） |
| Skill | YAML frontmatter（gray-matter）+ chokidar 热重载 |
| 进度协议 | 自研 `[CORAL_PROGRESS]` stderr 单行 JSON 协议（见 [docs/AUTHORING_PROGRESS.md](./docs/AUTHORING_PROGRESS.md)） |
| 质量 | Vitest（203 用例）+ GitHub Actions（ubuntu/windows/macos × Node 20/22） |

---

## 内置 Skill 清单

| Skill | 模式 | 说明 |
|-------|:--:|------|
| `summarize-document` | llm_only | 文档摘要 |
| `data-transform` | llm_only | 数据转换 |
| `policy-scraper` | script | 政策采集（流式 + MD/CSV 双产物 + 站点参数）|
| `policy-to-post` | script | 政策转推文（三输入互斥）|
| `information-filter` | script | 多源信息筛选（公司画像驱动）|

---

## 创建自定义 Skill

**方式 1：UI 多轮对话**（推荐）— 左侧「技能创建」→ 描述需求 → AI 反问澄清 → 提交自动落盘，2 秒内热加载可用。

**方式 2：手写 SKILL.md**（推荐二次开发者）：

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

## 关键 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` · `/api/stats` · `/api/config` | 健康 / 统计 / 配置（Key 脱敏） |
| POST | `/api/tasks` | 创建任务（goal 自然语言） |
| POST | `/api/tasks/:id/cancel` | 取消任务（立即中止 LLM 调用与脚本进程） |
| GET | `/api/tasks/:id/stream` | SSE 任务事件流 |
| WS | `/ws/events` | WebSocket 全局事件流 |
| GET/PUT/DELETE | `/api/skills/:name` | Skill 查询 / 编辑 / 删除（内置需二次确认） |
| POST | `/api/skill-builder/sessions…` | 对话式技能创建 |
| GET/PUT | `/api/company-profile` | 公司业务画像 |

---

## 项目结构

```
CORAL/
├── LICENSE · .env.example · README.md · USE.md
├── docs/                    ← V2_PLAN（重构看板）/ 架构与需求历史文档 / 技能规范
├── .github/workflows/ci.yml ← CI：三平台 × Node 20/22
├── scripts/                 ← dev / start / e2e 冒烟脚本
├── packages/
│   ├── server/              ← Fastify 后端
│   │   └── src/
│   │       ├── api/         ← 路由层
│   │       ├── scheduler/   ← DAG 调度器（取消/超时/重试语义）
│   │       ├── planning/    ← 规划引擎（goal → DAG）
│   │       ├── skill-runtime/ ← 注册表/解析/热重载/执行/进度协议/沙箱env
│   │       ├── providers/   ← 错误分类 + 重试策略（M1 providers 层的第一块砖）
│   │       ├── store/       ← SQLite + 迁移 + 仓储
│   │       ├── event/       ← 事件总线
│   │       └── services/    ← LLM client / 配置 / 公司画像 / 技能构建器
│   └── web/                 ← React 前端（DAG 可视化 / 实时流 / 主题）
└── skills/                  ← 技能目录（文件系统即注册表，热重载）
    └── _lib/coral_progress.py ← 进度协议 Python helper
```

---

## 路线图（v2）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 地基修复：SQLite / 真取消 / 真超时 / 重试语义 / 去 mock / 安全默认 / 测试 + CI / 仓库卫生 | ✅ 完成 |
| M1 | Harness 内核：providers 层 · Tool 抽象 · Agent Loop + sub-agents · Agentic Workspace | ⏳ |
| M2 | Graph 模式：checkpoint / 人工审批 / 断点恢复 / 事件驱动调度重写 | ⏳ |
| M3 | 连接器：MCP 双向桥 · 进度协议 SDK（npm + PyPI） | ⏳ |
| M4 | 旗舰 UI：Time-Travel 调试器 · `npx coral` 单命令发布 | ⏳ |

路线图按里程碑推进，状态随版本更新。

---

## Authors

**[Qiyao404](https://github.com/Qiyao404)** · **[alstar501](https://github.com/alstar501)** — 联合开发

## License

[MIT](./LICENSE) © 2026 Qiyao404 & alstar501
