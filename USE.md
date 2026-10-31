# CORAL v1.1.0 · 快速使用说明

> 目标读者：业务用户 / 平台运维 / 二次开发者
> 目的：30 分钟内完成本地启动并跑通 1 个端到端任务

---

## 1. 环境要求

| 依赖 | 版本要求 | 说明 |
|------|---------|------|
| **Node.js** | ≥ 18 | 后端 + 前端运行环境 |
| **Python** | ≥ 3.9 | 仅 `policy-scraper` / `policy-to-post` / `information-filter` 这几个 Skill 需要 |
| **Chrome 浏览器** | 最新 | `policy-scraper` 用 Selenium 控制；建议预装 |

> **代理友好**：本机已开启 HTTP 代理（Clash / Surge / VPN）也能正常使用。
> 平台 LLM 走代理，政府网页（`.gov.cn`）会自动绕过代理直连，互不干扰。

---

## 2. 一键启动（开发模式）

### Windows · PowerShell

```powershell
# 在仓库根目录执行
./scripts/dev.ps1
```

### macOS / Linux

```bash
chmod +x scripts/dev.sh
./scripts/dev.sh
```

启动成功后：

| 服务 | 地址 | 说明 |
|------|------|------|
| 后端 API | http://localhost:3001 | Fastify 服务 |
| 前端 UI | http://localhost:5173 | Vite Dev 服务（自动打开浏览器） |
| 健康检查 | http://localhost:3001/api/health | 验活 |

---

## 3. 生产模式（构建并启动）

```powershell
# Windows
./scripts/start.ps1
```

```bash
# macOS / Linux
./scripts/start.sh
```

构建产物：

- 后端 → `packages/server/dist/`
- 前端 → `packages/web/dist/`

---

## 4. 默认 LLM 配置

v1.1.0 默认使用 **阿里云 DashScope Coding · kimi-k2.5**：

```env
LLM_BASE_URL=https://coding.dashscope.aliyuncs.com/v1
LLM_API_KEY=sk-sp-a264cb51d013452ba9eb52855c5bb7d9
LLM_MODEL=kimi-k2.5
```

> 平台首次启动时会自动把上述配置写入 `data/llm_configs.json` 并设为 active。
> 如果你之前用过老版本（v1.0.0）的 SiliconFlow 配置，会被自动迁移：
> - 旧 SiliconFlow 配置保留不删除
> - 新 dashscope 配置追加并设为 active

也可以在 UI 上调整：**「设置 → LLM 配置管理」**。

---

## 5. 第一个任务（5 分钟跑通）

### 5.1 简单任务（自然语言对话）

1. 浏览器访问 http://localhost:5173
2. 点左侧「**对话**」
3. 输入：`帮我总结一段文本：人工智能（AI）是计算机科学的一个分支...`
4. 提交 → 自动跳到任务详情页 → 看到流式进度推进 → 最终拿到 JSON 结果

### 5.2 政策采集任务（含真实抓取）

1. 「对话」中输入：`采集 2026 年 3 月广东工信厅的政策`
2. 平台规划引擎会自动：
   - 提取参数 `year=2026, month=3, sites=["gdii"]`
   - 生成 1 节点 DAG
3. 任务详情页可见：
   - 进度条按页码推进
   - 实时日志滚动
   - 完成后产物列表显示 MD + CSV 文件，可下载

### 5.3 组合任务（采集 → 筛选 → 推文）

> 这是 v1.1.0 的核心新功能（FR-I）

1. 先到「设置 → 公司业务画像」配置好你的关注关键词（默认已预填中试平台、机器人、人工智能等）
2. 「对话」中输入：
   ```
   采集广东工信厅 2026 年 3 月政策，筛出与中试平台、产业创新相关的，做成推文
   ```
3. 平台自动规划 3 节点 DAG：`policy-scraper` → `information-filter` → `policy-to-post`
4. 在任务详情页看到 React-Flow DAG 可视化，每个节点带流式进度

> **如果上游 `information-filter` 输出 0 条保留** → 下游 `policy-to-post` 会被优雅短路（标记 cancelled），不算失败。

---

## 6. 创建你自己的技能（无需写代码）

1. 左侧「**技能创建**」（或在 SkillsPage 点 `+ 创建技能`）
2. 输入需求：「我要一个能根据关键词从小红书采集前 50 条笔记并导出 Excel 的技能」
3. AI 多轮反问：name? 输入参数? 执行模式? ...
4. 右侧实时显示 SKILL.md 草稿
5. 字段进度条全绿后点「预览」检查 → 「提交」
6. 技能列表立即出现新 Skill，可直接调用

另一种方式是**安装现成的技能包**（npm / git / 本地目录三源）：

```bash
coral install npm:coral-skill-pack       # npm 技能包（--ignore-scripts 隔离安装）
coral install https://github.com/u/repo  # git 仓库（支持 tree 子路径）
coral install ./my-skill-dir             # 本地目录
coral install npm:coral-skill-pack --overwrite   # 同名覆盖（旧版备份进 skills/.history/）
```

多技能包约定把各技能放在包内 `skills/` 一级子目录，单技能包在包根放 `SKILL.md`；安装落盘即热加载，无需重启。

---

## 7. 编辑 / 删除技能

- 列表中每个卡片有 `测试 / 编辑 / 删除` 三个按钮
- **内置 Skill** 编辑或删除时弹窗要求输入完整名称二次确认
- 默认删除仅取消注册（保留物理文件），勾选「物理删除」会移到 `skills/.trash/`

---

## 8. 关键文件路径

```
CORAL/
  ├── .env                          # 平台配置（LLM、代理、数据库等）
  ├── data/
  │   ├── tasks.json                # 任务历史
  │   ├── plans.json                # 执行计划
  │   ├── agents.json               # Agent 实例
  │   ├── audit_logs.json           # 审计事件（不含高频 progress/log）
  │   ├── llm_configs.json          # LLM 配置档案
  │   ├── company_profile.json      # 公司业务画像
  │   ├── skill_builder_sessions.json  # 创建会话
  │   ├── memory/                   # 长期记忆（Markdown，可直接编辑）
  │   ├── sessions/                 # 会话上下文（文件摘要/决策/接力记录）
  │   ├── evidence/                 # 证据记录（超大工具结果的不可变存档，按 run 分目录）
  │   └── habits/                   # 习惯学习（observations.jsonl + habits.json）
  ├── skills/                       # 所有技能
  │   ├── _lib/coral_progress.py    # 进度协议 helper
  │   ├── policy-scraper/           # 政策采集（v1.1.0：流式 + MD/CSV 双产物）
  │   ├── policy-to-post/           # 政策转推文（v1.1.0：三输入互斥）
  │   ├── information-filter/       # 信息筛选（v1.1.0 新增）
  │   ├── data-transform/
  │   ├── summarize-document/
  │   └── .trash/                   # 物理删除的技能（可手动恢复）
  ├── packages/
  │   ├── server/                   # 后端 (Fastify + WebSocket + SSE)
  │   └── web/                      # 前端 (React + Vite + Tailwind)
  └── docs/
      ├── REQUIREMENTS.md
      ├── DESIGN.md
      ├── TASKS.md
      └── AUTHORING_PROGRESS.md     # 给 Skill 作者的进度协议指南
```

---

## 9. 运行时纪律与运维（v2.1）

### 9.1 健康自检：`coral doctor`

启动前或排障时跑一条命令，自动分诊七类高频故障（每项带修复建议）：

```powershell
node packages/server/bin/coral.mjs doctor
```

检查项：构建产物新鲜度（源码比 dist 新 = 你跑的还是旧代码）、端口占用（占用者是否 CORAL 实例）、数据目录可写、磁盘水位（50/30/15GB 三级）、数据库完整性、模型配置、技能损坏清单、MCP 连接态。

> 经验法则：改完代码务必 `npm run build` 后**先确认旧进程已退出再启动**，否则测的是旧版本。doctor 的 `[build]` 项会直接告诉你产物是否过期。

### 9.2 运行时纪律（自动生效，无需配置）

- **事实门**：Agent 改/覆盖已有文件前必须先读过它（盲改直接拒绝，读后重试放行）。
- **收工门**：复杂任务的最终回答含"测试先跳过/后续再修"式话术会被打回重写。
- **证据记录**：超大工具结果自动落盘（`data/evidence/<runId>/`），上下文只留摘要，`evidence_read` 工具可取回。
- **三层压缩 + 熔断**：上下文 60%/85%/100% 三档水位先收纳旧结果、再全量摘要；摘要连败 3 次自动熔断。
- **工具效果契约**：审批档位由工具效果声明推导，声明只能更严不能更松。

### 9.3 习惯学习（越用越懂你）

Agent 的工具调用被自动观察（`data/habits/observations.jsonl`），攒够量自动蒸馏出协作习惯（`data/habits/habits.json`）。置信度 ≥0.7 的习惯自动注入系统提示；`POST /api/habits` 查看全部，`POST /api/habits/:id/promote` 把 ≥0.8 且跨 ≥2 会话的习惯一键晋升为技能。

### 9.4 外部命令守卫（hooks）— 把纪律层变成开放接口

`data/hooks.json` 声明外部命令守卫，在 8 个生命周期点被调用，可以**否决 / 改写 / 补充**（修改后自动热加载）：

```jsonc
{
  "hooks": {
    "pre_tool_use": [
      { "matcher": "fs_write|fs_edit", "command": "node D:/guards/protect-env.mjs", "timeout": 30 }
    ],
    "stop": [
      { "command": "node D:/guards/final-check.mjs" }
    ]
  }
}
```

- **事件**：`pre_tool_use`（可 deny/ask/改写入参）、`post_tool_use`（观察结果）、`stop`（可打回最终回答）、`user_prompt_submit`（可拦任务/注入上下文）、`session_start`（注入上下文）、`session_end`（观察）、`pre_compact`（可拦压缩）、`notification`（审批通知）
- **契约**：stdin 收 JSON（事件+上下文）；stdout 可解析 JSON 时取 `{decision, reason, updatedInput, additionalContext}`；退出码 2 = 拒绝（stderr 为原因）
- **安全方向**：pre_tool_use 的守卫自身故障/超时 = 拒绝执行（fail-closed）；观察类事件故障 = 放行
- `matcher` 是工具名正则，仅工具类事件生效

**可视化管理的另一条路**：左侧「**钩子**」页可以完全替代手编 JSON——按事件分组添加/编辑/删除守卫、填写工具名正则与超时、逐条启停（停用保留配置不触发）、**测试按钮**用样例载荷真实执行一条命令（返回裁决解析 + 原始 stdout/stderr），页面底部是最近 100 条命中裁决流（事件 / 工具 / 决策 / 耗时）。两种方式等价（同一份 `hooks.json`），改动均自动热加载。

### 9.5 斜杠命令（用户快捷指令）

`data/commands/*.md`（首启自动播种 `/research` `/plan` `/review` `/brief` 四条）。聊天输入 `/research 量子计算` 会把命令模板展开成完整任务再执行（事件流 `run.created` 带 `expandedFrom` 留痕）。模板支持 `$ARGUMENTS`（全部参数）与 `$1..$9`（按词取参）。`GET /api/commands` 列出全部命令。

### 9.6 具名子代理（data/agents/*.md）

首启播种 4 个预置专员：`research-analyst`（调研）、`detail-reviewer`（评审）、`data-wrangler`(数据整理)、`doc-writer`(成文)。Agent 会通过 `agent_spawn` 的 `agent` 参数按名委派——预设的描述与触发例示注入主提示（教主模型何时委派），正文只进子代理。自定义：在 `data/agents/` 放一个 frontmatter 为 `name/description/when_to_use/tools` 的 Markdown，正文即子代理系统提示。`GET /api/agents` 列出。

### 9.7 ESTOP 急停与审批记忆

- **`coral pause [原因]`** 拉闸：所有新任务（含触发器/cron）被拒，运行中的不受影响；**`coral resume`** 解除。doctor 会提示当前是否拉闸中。
- 审批时传 `scope: "session"`（`POST /api/runs/:id/approvals/:aid` body `{approved:true, scope:"session"}`）= 本服务会话内同工作区同工具自动放行（事件 `tool.approval_auto` 留痕）；`DELETE /api/approvals/session-rules` 清空记忆。

### 9.8 运维 API

```
GET  /api/system/gc                 # 配置自清理扫描（过期证据/孤儿会话/损坏技能/回收站膨胀）
POST /api/system/gc                 # 逐项确认清理（body: {"ids": [...]}，软删除+日志可撤销）
GET  /api/runs/:id/evidence         # 该 run 的证据记录清单
POST /api/runs/:id/self-eval        # 五轴自评（准确/完整/清晰/可执行/简洁，低分必须给证据）
GET  /api/habits                    # 习惯列表
POST /api/habits/distill            # 手动触发蒸馏
```

---

## 10. 常见问题

### Q1：政府网页打不开（代理污染）？

**A**：`.env` 中默认开启了：

```env
POLICY_FORCE_DIRECT=true
POLICY_NO_PROXY_DOMAINS=gov.cn,foshan.gov.cn,gd.gov.cn
```

`policy-scraper` / `policy-to-post` 会强制对 `.gov.cn` 直连。如果你要禁用此行为，把 `POLICY_FORCE_DIRECT` 改 `false`。

### Q2：Mock 模式是什么？

**A**：当 LLM API 不可用（额度耗尽 / 网络异常 / Key 错误）时，平台会自动降级到本地 Mock 数据，让你能继续验证流程。Mock 状态会在控制台 / 设置页明显标识。

### Q3：进度事件不更新？

**A**：检查任务详情页右上角「传输：WS+SSE」状态。如果 WS 断开 → SSE 仍可兜底。两个都断开时检查后端是否运行。

### Q4：如何查看历史任务？

**A**：左侧「任务中心」按状态筛选。每个任务点进去能看到完整 DAG / 实时日志 / 产物。

### Q5：如何切换浅色 / 深色主题？

**A**：v1.1.0 起平台支持双主题：

- **快速切换**：左侧栏底部点击「深色 / 浅色」按钮，立即切换；右侧 `Monitor` 图标可切换到「跟随系统」
- **完整设置**：「设置 → 外观主题」中三选一（浅色 / 深色 / 跟随系统）
- 设置存于浏览器本地（`localStorage` 键名 `coral.theme`），不影响其他用户
- 选择「跟随系统」时会响应操作系统级的 `prefers-color-scheme` 变化

### Q6：技能创建只能生成 Markdown 吗？能不能自动生成 Python 脚本？

**A**：**支持**。当你在对话中告诉 AI 这个技能要 **采集 / 转换 / 计算 / 网页交互** 等"非纯文本"任务时，AI 会自动把 `execution_mode` 设为 `script`（或 `hybrid`），并直接生成完整的 `scripts/main.py`：

- 脚本会按 CORAL 协议从 stdin 读 JSON 输入、用 `emit_progress` / `emit_log` 推送实时进度、最终从 stdout 输出 JSON 结果
- 右侧「SKILL.md 实时草稿」面板下方有专门的 `scripts/main.py` 折叠预览，能看到完整代码 + 行数
- 如果 mode 是 `script/hybrid` 但脚本还没生成，**「提交」按钮会被禁用**，并提示「还差 X 项」直到 AI 把脚本补齐
- 提交时后端会原子写盘到 `skills/<name>/scripts/main.py`，触发热重载，**立即可用**

如果你只想让 AI 写一段 prompt 让平台 LLM 自己处理（不需要脚本），让 AI 把 mode 保持为 `llm_only` 即可。

### Q7：进了任务详情页一片黑屏？

**A**：v1.1.0 早期版本中 DAG 组件的一个 React Hook TDZ 缺陷可能导致这种情况，已在最新版修复（`packages/web/src/components/dag/AgentDag.tsx`）。
另外平台现在内置了**全局错误边界**（`components/ErrorBoundary.tsx`），即便子组件再抛错也只会出现一张友好的错误卡片，不会再变成黑屏 — 卡片上有「重试 / 刷新页面 / 返回任务列表」三个按钮可用。

### Q8：任务完成后再进入详情页，进度 / 产物 / 日志全没了？

**A**：v1.1.1 起已修复。原因和方案如下：

- 进度 / 日志事件（`skill.progress` / `skill.log`）频次很高，平台**不会**把它们写进 `data/audit_logs.json`（防止文件爆炸）— 这是设计取舍
- 但每个 Agent 的最终 `status` / `output` / `skillResults` 都已经持久化在 `data/agents.json`
- 高层事件（`agent.started/completed/failed/cancelled`、`skill.executing/completed/failed`、`skill.artifact` 等）也已经持久化在 `data/audit_logs.json`

修复后任务详情页的行为：

| 区域 | 实时态 | 完成态（修复后） |
|---|---|---|
| Agent 状态徽标 | 来自事件流 | 优先用 `agentStore` 的最终 status |
| DAG 进度 | 来自 `skill.progress` 事件 | 完成的 Agent 强制 100% |
| 产物列表 | 来自 `skill.artifact` 事件 | 从 `agents[].skillResults.*_path` 字段重建 |
| 事件时间线 | 实时 SSE/WS | 从 `audit_logs.json` 回灌 + 内存 ring buffer 合并去重 |
| 历史日志 | 来自 `skill.log` 事件 | 不可恢复（设计取舍）但会有提示横幅，并展示完整事件时间线 |

涉及代码：

- 后端：`packages/server/src/api/task.routes.ts`（详情接口 `agents` 字段 + 合并 audit/内存事件）
- 后端：`packages/server/src/api/event.routes.ts`（SSE 端点回灌时也合并 audit）
- 前端：`packages/web/src/hooks/useTaskStream.ts`（新增 `seedEvents` 方法）
- 前端：`packages/web/src/pages/TaskDetailPage.tsx`（`fallbackArtifacts` / `mergedProgress` 派生）

### Q9：技能创建时点击「提交」一直报 Bad Request？

**A**：v1.1.1 起已修复。原因和方案如下：

- **根因**：前端 `api.commitBuilder` 是无 body 的 POST，而 `request()` 函数固定加了 `Content-Type: application/json`。Fastify 看到该 header 但 body 为空时会返回 415（在浏览器侧 fetch 表现为 "Bad Request" / "请求失败"）。同样的问题也潜在影响 `cancelTask` / `activateLlmConfig` 等所有"动作型 POST"。
- **前端修复**（`packages/web/src/api/client.ts`）：`request()` 仅当 `options.body` 存在时才加 `Content-Type`
- **后端兜底**（`packages/server/src/index.ts`）：注册自定义 `application/json` parser，对空 body 解析为 `{}` 而不是 415

涉及代码：

```diff
- 'Content-Type': 'application/json',
+ if (options?.body !== undefined && options?.body !== null) {
+   headers['Content-Type'] = headers['Content-Type'] || 'application/json';
+ }
```

如果你看到老版本的提交报错，**升到最新版即可**。如果同名 skill 已经存在，会得到 409 并弹出"是否覆盖"确认框 — 这是正常流程。

### Q10：技能创建为 script 模式时，对话区生成了脚本但右侧"scripts/main.py 实时草稿"一直显示"脚本代码缺失"？

**A**：v1.1.1 起已修复。原因和方案如下：

- **根因 1**：旧版 `maxTokens=1600` 太小，~200 行 Python 脚本会被 LLM 截断 → JSON 不闭合 → 整段被当成自然语言显示在对话气泡里
- **根因 2**：把整段 Python 源码塞进 JSON 字符串字段时，`"` / `\n` / `\\` 转义极易出错 → JSON.parse 抛错 → 同样退化成纯文本
- **根因 3**：解析失败后旧代码直接抛弃 `draft_updates`，导致 `scriptContent` 永远写不进 draft

**修复方案**（双段输出协议）：

让 LLM 用两段独立的标签输出，Python 源码完全在 ```` ```python ``` ```` 围栏里**不需要任何 JSON 转义**：

```
<JSON>
{ "reply": "...", "draft_updates": { ... }, "ready_to_preview": true }
</JSON>

<SCRIPT>
```python
#!/usr/bin/env python3
import sys, json
...完整脚本，原样输出，不需要转义...
```
</SCRIPT>
```

后端 parser（`parseBuilderResponse`）按以下优先级抽取：

1. `<SCRIPT>` 标签内的 ```` ```python``` ```` → `draft.scriptContent`
2. `<JSON>` 标签 → 解析为 `reply` / `draft_updates` / `ready_to_preview`
3. 退化：全文里最长的 ```` ```python``` ```` 围栏 + brace-balanced JSON 抽取（兼容老协议输出 + 截断场景）

同时：

- `maxTokens` 提升到 **6000**（kimi-k2.5 上限 8192，足以承载 200+ 行脚本）
- 历史对话中 >2000 字的助手消息自动截断（防止"协议升级前"的脏数据污染新 prompt）
- 助手消息中 ```` ```python``` ```` 围栏内容会被替换为占位符（脚本本身已在 `draft.scriptContent` 持久化，无需在 conversation 中重复发回 LLM）

**遗留 session 怎么办？**

- 已经处于"脏数据"状态的 session（脚本只显示在对话气泡里）：在左侧对话框告诉 AI 一句 **"请按 system 协议重新输出 `<JSON>` 和 `<SCRIPT>` 双段，把脚本放在 `<SCRIPT>` 标签内的 ```python``` 围栏里"**，AI 会按新协议重新输出
- 实在恢复不了的旧 session 可以左上角「← 返回技能列表」→ 重新开一个新会话

涉及代码：

- `packages/server/src/services/skill-builder-service.ts`：新协议 system prompt + `parseBuilderResponse` + `stripPythonFences`
- `packages/web/src/pages/SkillBuilderPage.tsx`：`scriptMissing` 提示文案优化

### Q11：API 文档？

**A**：服务启动后访问下列端点：

```
GET  /api/health                              # 健康检查
GET  /api/config                              # 平台配置（脱敏）
GET  /api/stats                               # 统计

POST /api/tasks                               # 创建任务
GET  /api/tasks                               # 任务列表
GET  /api/tasks/:taskId                       # 任务详情（含 plan、agents、events）
POST /api/tasks/:taskId/cancel                # 取消任务
GET  /api/tasks/:taskId/stream                # SSE 实时事件流

POST /api/chat                                # 自然语言聊天入口（与 /api/tasks 等价）

GET  /api/skills?source=builtin|user          # 技能列表
GET  /api/skills/:name?full=1                 # 技能详情（含 frontmatter）
POST /api/skills/:name/test                   # 测试执行
PUT  /api/skills/:name                        # 编辑（X-Confirm-Builtin 头）
DELETE /api/skills/:name?physical=true        # 删除
GET  /api/skills/:name/artifacts?path=...     # 产物下载

POST /api/skill-builder/sessions              # 创建技能创建会话
GET  /api/skill-builder/sessions/:id          # 会话详情
POST /api/skill-builder/sessions/:id/messages # 发送消息
POST /api/skill-builder/sessions/:id/commit   # 落盘
DELETE /api/skill-builder/sessions/:id        # 取消

GET  /api/company-profile                     # 公司画像
PUT  /api/company-profile                     # 保存（version 自增）
POST /api/company-profile/reset               # 恢复默认

GET  /api/llm/configs                         # LLM 配置列表
POST /api/llm/configs                         # 新增/更新配置
POST /api/llm/configs/:id/activate            # 激活
DELETE /api/llm/configs/:id                   # 删除

GET  /api/events?taskId=...&type=...          # 事件历史
GET  /api/events/stream                       # 全局 SSE 事件流
GET  /ws/events                               # WebSocket（双工）
```

---

## 10. 升级 / 回滚

### 升级到 v1.1.0
- v1.0.0 → v1.1.0 完全向后兼容（详见 `docs/DESIGN.md §12`）
- 启动时自动迁移 LLM 配置；旧 Skill 缺 `source` 字段会自动视为 `builtin`

### 回滚到 v1.0.0
- 切换镜像/代码版本即可
- `data/` 目录无需清理（v1.1.0 新增的字段 v1.0.0 会忽略）
- 推荐先备份 `data/llm_configs.json` 与 `data/company_profile.json`

---

## 11. 下一步

- 想了解平台架构？→ [`docs/DESIGN.md`](./docs/DESIGN.md)
- 想给社区贡献新 Skill？→ [`docs/AUTHORING_PROGRESS.md`](./docs/AUTHORING_PROGRESS.md)
- 想看完整需求列表？→ [`docs/REQUIREMENTS.md`](./docs/REQUIREMENTS.md)
- 想跟踪开发进度？→ [`docs/TASKS.md`](./docs/TASKS.md)

---

**祝你使用愉快！如有问题请提 Issue 或在「设置 → LLM 配置管理」中调整。**

### 9.9 产物预览（回复底部）

每次回复的最下方自动列出本轮生成/修改的文件（点击预览，右侧面板打开）：
- Markdown / 文本 / JSON / CSV / 代码 → 直接渲染
- Word (.docx) → 自动提取全文文本
- PDF / 图片 → 浏览器原生渲染（iframe / img）
- 其他格式 → 一键下载

数据来自事件流（fs_write / fs_edit / docx_write 统一发产物事件）；`GET /api/runs/:id/artifacts` 与 `GET /api/sessions/:id/artifacts` 可编程获取。运行预算（Token/步数上限）在设置页"运行预算"卡片调整，范围 10 万 ~ 1000 万 token，对新任务即时生效。

### 9.10 @ 引用与提示词优化

- **`@` 引用文件**：输入框打 `@` 弹出工作区文件选择器（递归含子目录，实时过滤），↑↓/Tab/Enter 选择。发送时引用文件自动注入为任务上下文（指示 agent 开工前先读取；本会话已分析过且未变的文件可直接复用已有结论），并以附件标记形式挂在消息上。
- **✨ 优化提示词**：输入框右侧魔棒按钮 — 模型先理解你的意图（交付物/范围/约束），再改写为更明确的提示词（目标、可判定标准、输出格式），弹层可对照原文、可手动微调，采用后替换输入框。
