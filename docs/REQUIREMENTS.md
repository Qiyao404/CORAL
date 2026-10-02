# CORAL 平台升级 — 需求文档

> 版本：**v1.1.0**（rev 2 + impl 2026-04-25）  日期：2026-04-25  状态：**已实现**
> 关联文档：[设计文档 DESIGN.md](./DESIGN.md) ｜ [任务文档 TASKS.md](./TASKS.md) ｜ [快速使用 USE.md](../USE.md)
> 基线版本：CORAL v1.0.0
>
> **rev 2 变更摘要**（基于第二轮需求澄清）：
> - 新增 FR-G 公司业务画像（平台配置 + 任务覆盖）
> - 新增 FR-H 多源信息筛选 Skill（`information-filter`）
> - 新增 FR-I 组合任务理解（自然语言 → 多 Skill DAG 自动编排）
> - 增强 FR-D：政策采集支持自然语言「指定站点 / 月份」参数提取
> - 新增 FR-J 视觉系统重构（Glassmorphism + 动效，参考 ui-ux-pro-max 输出）
> - 新增用户故事 US-6 / US-7
>
> **impl 实现摘要**（2026-04-25 落地）：
> - LLM 默认配置切换为 **DashScope Coding · kimi-k2.5**（旧 SiliconFlow 配置自动迁移保留）
> - 进度三件套（`skill.progress` / `skill.log` / `skill.artifact`）+ `[CORAL_PROGRESS]` 协议
> - SSE 端点 `/api/tasks/:taskId/stream` + WS 双订阅去重
> - 政策采集脚本支持 `--sites` 参数 + 流式埋点 + MD/CSV 双产物 + 政府站点直连穿透代理
> - 政策转推文支持三种输入互斥（md_content / md_path / csv_path）
> - `information-filter` Skill 完整落地（公司画像 prompt 注入 + 分批 + 重试）
> - PlanningEngine 升级（站点别名表 + 公司画像 + 优雅短路 + 缺参兜底）
> - 前端深色 + Glassmorphism + Lucide 图标 + React-Flow DAG 全量视觉重构

---

## 1. 背景与目标

### 1.1 现状回顾

CORAL 当前是一个**通用、并发、文件系统驱动**的多智能体运行时平台，已经具备：

- 文件系统 Skill 注册表（`skills/<name>/SKILL.md`）+ 热重载
- 自然语言目标 → LLM 规划 → DAG 调度的完整链路
- WebSocket 事件总线，可推送任务/Agent/Skill 级生命周期事件
- 4 个内置 Skill：`summarize-document` / `data-transform` / `policy-scraper` / `policy-to-post`

### 1.2 痛点

| 编号 | 痛点 | 用户感受 |
|------|------|----------|
| P-1 | Skill 只能由开发者手写 SKILL.md 落盘 | 普通用户无法自助沉淀新能力 |
| P-2 | Skill 列表页没有编辑/删除入口 | 改一个错字也得登服务器 |
| P-3 | `policy-scraper` 单次运行 5–10 分钟，前端只有 `agent.started`，中间无任何反馈 | 用户以为页面卡死 |
| P-4 | `policy-to-post` 必须先有 CSV 文件，无法直接基于一段政策正文生成推文 | 接入门槛高，闭环断裂 |
| P-5 | Skill 内部进度（如「第 3/8 个站点」「LLM 处理第 12/45 条」）完全黑盒 | 出了问题无从判断 |
| P-6 | 仅 WebSocket 单通道，弱网/代理下偶发断流后体验恶化 | 长任务可靠性不足 |
| P-7 | 平台不理解「采集 → 筛选 → 转推文」类组合任务，需要用户自己发起多次 | 复杂工作流断裂，体验降级到串脚本 |
| P-8 | 政策采集只能跑全部 8 个站点，不能根据用户描述「只抓佛山住建局 3 月」 | 浪费时间和资源 |
| P-9 | 没有「公司业务画像」概念，每次筛选都需要重复说明业务背景 | 信息冗余、回答漂移 |
| P-10 | 整体视觉风格停留在简单卡片堆叠，与"多智能体自动化平台"定位不匹配，缺少专业感 | 用户对平台的"科技感"和可信度感知不足 |

### 1.3 升级目标

> **一句话目标**：把 CORAL 从「程序员可用」升级为「业务用户可用」的**自动化多智能体协作平台** —— 自然语言进、可观测出，技能能创、能改、能删，组合任务一句话搞定。

七大子目标：

1. **Skill 自助生产**：用户用自然语言（含语音转文字）描述 → AI 多轮澄清 → 自动生成可执行的 SKILL.md → 预览 → 入库（参考 [anthropics/skills/skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator) 的工程实践）。
2. **Skill 全生命周期管理**：在 UI 中对所有 Skill 做增/删/改/查，内置 Skill 二次确认保护。
3. **全链路可观测**：从任务开始到结束，用户在前端任意时刻都能回答「现在在做什么、进度多少、已经产出了什么」三个问题。
4. **政策双 Agent 改造**：`policy-scraper` 流式输出 + MD/CSV 双产物 + 智能识别站点/月份；`policy-to-post` 双输入并展示进度。
5. **多源信息筛选**：新增 `information-filter` Skill，理解公司业务画像，从政策/展会/新闻等多源信息中筛出有价值条目并保留原结构。
6. **组合任务自动编排**：平台理解「采集 → 筛选 → 转推文」类组合需求，自动选择 Skills 并生成多 Agent DAG，端到端跑通。
7. **视觉与交互重塑**：基于 Glassmorphism + 深色 SaaS 设计系统全面重构 UI，引入运行态动效、滚动特效、悬浮提亮、骨架屏等专业交互细节。

---

## 2. 名词定义

| 术语 | 含义 |
|------|------|
| **Skill** | 标准化能力单元，目录形式存在于 `skills/` 下，含 `SKILL.md` |
| **内置 Skill (builtin)** | 仓库初始 Skill；frontmatter 不带 `source` 或 `source: builtin` |
| **用户 Skill (user)** | 通过 Skill Builder 创建的 Skill；frontmatter `source: user` |
| **Skill Builder** | 多轮对话式 Skill 创建工具（参考 [anthropics/skills/skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator)） |
| **公司业务画像（Company Profile）** | 描述公司主营业务、关注领域、关键词等的结构化配置；多个 Skill（如 information-filter / policy-to-post）的共享上下文 |
| **多源信息（Multi-source Input）** | 政策清单 / 展会信息 / 行业新闻 / 单篇文章等异构内容，可来自 MD、CSV、URL、纯文本 |
| **组合任务（Composite Task）** | 由多个 Skill 协作完成的端到端任务，平台自动规划 DAG（如 采集 → 筛选 → 转推文） |
| **参数提取（Param Extraction）** | 规划引擎从自然语言中识别 Skill 输入参数（如年/月/站点 ID/关键词）的能力 |
| **Skill Builder Session** | 一次创建会话，包含完整对话上下文 + 草稿 manifest |
| **进度事件 (skill.progress)** | Skill 内部下发的细粒度进度信号（带 percent / step / message） |
| **日志事件 (skill.log)** | Skill 运行期间的文本日志输出（用于实时控制台显示） |
| **CORAL_PROGRESS 协议** | 脚本类 Skill 通过 stderr 推送结构化进度行的约定（详见设计文档 §4） |

---

## 3. 用户角色与场景

| 角色 | 关注点 |
|------|--------|
| **业务用户**（不会写代码） | 把日常工作沉淀成 Skill；用自然语言下任务；看到清晰的进度 |
| **平台运维**（半技术） | 管理 Skill 列表，禁用问题 Skill，查看任务运行情况 |
| **二次开发者** | 通过 SKILL.md 手写复杂 Skill；在 Skill Builder 输出基础上微调 |

### 3.1 关键用户故事（User Stories）

#### US-1：自助创建一个采集小红书帖子的 Skill

> 作为业务用户，我打开 Chat 页面，点「创建技能」，对它说：「我要一个能根据关键词从小红书采集前 50 条笔记并导出 Excel 的技能」。AI 反问我「关键词从哪里来？要登录吗？输出文件放哪？」我一一回答，AI 给我看一份生成好的 SKILL.md 草稿，我点确认，3 秒后这个 Skill 就出现在技能列表里可以直接调用。

#### US-2：修改一个已有 Skill 的 prompt

> 作为业务用户，我发现 `summarize-document` 总是把摘要写得太长，我去技能列表点编辑，把 prompt 里「200 字」改成「100 字」，保存。下次任务用的就是新版本，无需重启服务。

#### US-3：放心地让政策采集跑

> 作为业务用户，我让平台采集 2026 年 3 月的政策，提交后页面上立刻看到：「第 1/8 站：佛山政数局…」每隔几秒进度条向前推进，旁边的日志窗口滚动着新条目；中途我去倒了杯水回来，已经在第 5 站，找到 23 条。结束时我同时拿到 MD 报告和 CSV 文件。

#### US-4：把政策正文直接变推文

> 作为业务用户，我刚收到一份 Word 政策文件，我把里面的正文复制进 `policy-to-post` 的输入框，点开始，看到「正在抓取附件 1/2 → AI 解读 → 生成推文」实时进度，30 秒后拿到一份格式完美的 MD 推文。

#### US-5：删除一个不再用的内置 Skill

> 作为运维，我想下线 `data-transform`。我点删除，系统弹窗：「这是内置 Skill，删除后将从注册表移除（文件不删除，可手动恢复）。请输入 `data-transform` 确认」。我输入并确认，Skill 从列表消失。

#### US-6：一句话跑组合任务

> 作为业务用户，我在 Chat 输入：「采集 2026 年 3 月广东工信厅和佛山住建局的政策，筛出和我们中试平台、产业创新、数字化转型相关的，最后做成推文」。提交后看到一个 3 节点的 DAG：`policy-scraper`（已自动识别 year=2026 / month=3 / urls=[gdii, fszj]）→ `information-filter`（已挂上公司画像）→ `policy-to-post`。三个节点串行跑通，过程中能看到每个节点进度。最终拿到一份按公司业务过滤后的推文。

#### US-7：视觉与动效让我相信这是个"智能"平台

> 作为业务用户，第一次打开 CORAL 时立即被深色 + 毛玻璃的科技感打动；任务运行时进度条带渐变流光；卡片悬停时轻微上浮、边缘提亮；DAG 节点运行中带脉冲；切换页面时有平滑过渡。整套体验让我感到这是"专业的多智能体平台"，而不是"开源工具拼凑"。

---

## 4. 功能需求（FR）

### 4.1 Skill 自助生产（FR-A）

| 编号 | 需求 | 优先级 |
|------|------|--------|
| FR-A1 | 提供「Skill Builder」入口（独立页面 `/skill-builder` 或 ChatPage 模式切换） | P0 |
| FR-A2 | 用户可输入文字描述需求；前端集成浏览器 Web Speech API 语音转文字按钮 | P0 |
| FR-A3 | AI 进行**多轮反问**澄清：技能名、能力描述、输入参数、输出参数、执行模式（LLM/脚本/混合）、超时、tags | P0 |
| FR-A4 | 在对话过程中**实时**右侧渲染 SKILL.md 草稿（YAML frontmatter + Markdown 正文） | P0 |
| FR-A5 | 用户可点「预览」查看完整 SKILL.md，可手动微调任意字段 | P0 |
| FR-A6 | 用户点「提交」后，系统在 `skills/<name>/` 下落盘 SKILL.md（必要时还有 `scripts/`、`reference.md`） | P0 |
| FR-A7 | 提交后注册表自动热加载（≤2 秒），新 Skill 出现在列表 | P0 |
| FR-A8 | 用户 Skill 落盘时 frontmatter 自动写入 `source: user`、`createdBy`、`creatorSessionId` | P0 |
| FR-A9 | 重名时给出明确提示，并提供「覆盖 / 改名」选项 | P1 |
| FR-A10 | 支持「从已有 Skill 派生」入口（拷贝模板再编辑） | P2 |

### 4.2 Skill 全生命周期管理（FR-B）

| 编号 | 需求 | 优先级 |
|------|------|--------|
| FR-B1 | Skill 列表页对每个 Skill 提供「编辑 / 删除」按钮 | P0 |
| FR-B2 | 编辑界面以 form + Monaco/CodeMirror 形式展示 frontmatter（结构化）+ prompt（代码编辑器） | P0 |
| FR-B3 | 保存后写回 SKILL.md，触发热重载 | P0 |
| FR-B4 | 删除会移除对应目录（默认仅取消注册保留文件，可选物理删除） | P0 |
| FR-B5 | 当目标 Skill `source === 'builtin'`，编辑/删除前弹出二次确认 modal，必须输入 Skill 名验证 | P0 |
| FR-B6 | 历史版本：每次编辑保留前一版到 `.history/` 子目录（可选回滚） | P2 |
| FR-B7 | 列表页支持按「来源」（builtin/user）筛选 | P1 |

### 4.3 进度可观测增强（FR-C）

| 编号 | 需求 | 优先级 |
|------|------|--------|
| FR-C1 | 新增事件类型：`skill.progress`（带 percent/step/total/message）、`skill.log`、`skill.artifact` | P0 |
| FR-C2 | SkillExecutor 在 LLM 路径中以 streaming 方式调用 LLM API，每个 chunk 推 `skill.log` 事件 | P0 |
| FR-C3 | SkillExecutor 在 Script 路径中**实时**读取子进程 stderr，按 CORAL_PROGRESS 协议解析 → 推 `skill.progress` | P0 |
| FR-C4 | 子进程的 stdout/stderr 普通行（非协议）作为 `skill.log` 事件下发 | P0 |
| FR-C5 | 同时通过 WebSocket（已有）+ 新增 SSE `/api/tasks/:taskId/stream` 推送事件 | P0 |
| FR-C6 | TaskDetailPage 改造：每个 Agent 卡片显示进度条（0-100%）+ 当前阶段文字 | P0 |
| FR-C7 | TaskDetailPage 新增可折叠「实时日志」面板，自动滚动 | P0 |
| FR-C8 | 任务完成后展示「产物列表」（artifacts），可点击下载 MD/CSV/JSON | P0 |
| FR-C9 | ChatPage 提交任务后默认跳转到 TaskDetailPage（而非停留聊天） | P1 |

### 4.4 政策采集 Skill 改造（FR-D）

| 编号 | 需求 | 优先级 |
|------|------|--------|
| FR-D1 | `scrape.py` 在每个网站开始/翻页/抓取条目/完成时输出 `[CORAL_PROGRESS]` 行（协议见设计文档） | P0 |
| FR-D2 | 输出文件由 1 份 CSV 改为 **MD + CSV 同时输出**（同名不同后缀） | P0 |
| FR-D3 | MD 格式：按发布机构分组，每条带标题、日期、URL；含汇总章节 | P0 |
| FR-D4 | output_schema 增加 `md_path` 字段（同时保留 `csv_path`） | P0 |
| FR-D5 | 进度粒度：站点级（n/8）+ 站点内页码级（第 k 页）+ 整体百分比 | P0 |
| FR-D6 | 单站超时不影响其他站点，整体进度依然准确 | P0 |
| FR-D7 | input_schema 新增 `sites` 字段（站点 ID 或简称数组），缺省=全部 8 个 | P0 |
| FR-D8 | 规划引擎能从自然语言中提取 `year` / `month` / `sites`（如「广东工信厅 3 月」→ year 取当前年、month=3、sites=["gdii"]） | P0 |
| FR-D9 | 当用户描述模糊时（如「最近的政策」），规划引擎以默认值跑（最近月、全站点）并在 reasoning 中说明 | P1 |
| FR-D10 | 站点别名表（如「广东工信厅 / gdii / 工信」都映射到同一站点）由 SKILL 的 reference.md 维护 | P0 |

### 4.5 政策转推文 Skill 改造（FR-E）

| 编号 | 需求 | 优先级 |
|------|------|--------|
| FR-E1 | input_schema 同时支持：`md_content`（粘贴 MD 文本）/ `md_path`（MD 文件）/ `csv_path`（CSV 文件，向后兼容） | P0 |
| FR-E2 | 三种输入互斥但只需提供一种；都未提供时返回明确错误 | P0 |
| FR-E3 | 当输入是 `md_content` 时，脚本解析 MD 中的政策列表（基于 policy-scraper 输出格式） | P0 |
| FR-E4 | 处理每条政策时输出 CORAL_PROGRESS（current/total/title） | P0 |
| FR-E5 | LLM 调用使用 streaming，每个 chunk 通过约定渠道下发到前端 | P1 |
| FR-E6 | 处理失败的单条政策跳过并标注，不中断整体流程 | P0 |
| FR-E7 | 前端为该 Skill 提供专属测试面板（多 tab：粘贴文本/选择文件/输入路径） | P1 |

### 4.6 平台横向感知增强（FR-F）

| 编号 | 需求 | 优先级 |
|------|------|--------|
| FR-F1 | Dashboard 新增「正在运行的任务」卡片（实时数量 + 列表） | P1 |
| FR-F2 | 全局顶栏新增「连接状态」指示灯（WS/SSE 状态、降级模式提示） | P1 |
| FR-F3 | 任务卡片在列表页显示当前进度百分比（来自最新 progress 事件） | P1 |
| FR-F4 | 长任务（>30 秒）页面标题加角标 `(进度% - CORAL)`，方便用户切窗口 | P2 |

### 4.7 公司业务画像（FR-G）

| 编号 | 需求 | 优先级 |
|------|------|--------|
| FR-G1 | 设置页新增「公司画像」表单：公司名、主营业务、关注领域（多选 + 自定义）、关键词列表、排除关键词 | P0 |
| FR-G2 | 公司画像持久化到 `data/company_profile.json`，热加载 | P0 |
| FR-G3 | 提供 GET/PUT `/api/company-profile` 端点 | P0 |
| FR-G4 | 创建任务/聊天时可在 constraints 中临时覆盖（任务级 > 平台级） | P0 |
| FR-G5 | LLM 规划引擎能在 prompt 中拿到公司画像；`information-filter` 等需要业务上下文的 Skill 自动注入 | P0 |
| FR-G6 | 提供「画像版本号」字段，每次 commit 递增，便于审计 | P1 |

### 4.8 多源信息筛选 Skill（FR-H）

新增 Skill：**`information-filter`**（域：information-processing；execution_mode：llm_only）

| 编号 | 需求 | 优先级 |
|------|------|--------|
| FR-H1 | input_schema 同时支持以下输入（任选一种或组合）：`md_content` / `md_path` / `csv_path` / `urls`（数组） / `text`（单条文章） | P0 |
| FR-H2 | 自动从输入中识别条目（标题/日期/链接/部门），保留原结构 | P0 |
| FR-H3 | 调用 LLM 基于公司画像逐条判断保留 / 剔除，并给出筛选理由（≤30 字） | P0 |
| FR-H4 | 输出 MD 格式：保留原分组与字段 + 新增「筛选理由」列 + 顶部「筛选汇总」（保留 N / 剔除 M / 关键关注领域） | P0 |
| FR-H5 | output_schema 含：`md_path`、`csv_path`（可选）、`kept_count`、`excluded_count`、`summary_by_topic` | P0 |
| FR-H6 | 流式进度：每处理一条 emit `skill.progress`（current / total） | P0 |
| FR-H7 | 大量输入分批调用 LLM（每批 ≤ 20 条），失败批次重试 ≤ 3 次 | P0 |
| FR-H8 | 当所有条目都被剔除时，输出 MD 仍生成且明确说明「无符合条件的内容」 | P0 |
| FR-H9 | 支持「试运行」模式（仅评估前 5 条），便于用户快速验证画像配置 | P1 |
| FR-H10 | 兼容历史 prompt（参考用户提供的政策筛选 prompt 模板）作为基础参考 | P0 |

### 4.9 组合任务理解（FR-I）

| 编号 | 需求 | 优先级 |
|------|------|--------|
| FR-I1 | PlanningEngine 能从一句话中识别**多个意图**（采集、筛选、转推文等）并自动串成 DAG | P0 |
| FR-I2 | 自动从描述中提取每个 Skill 的关键参数（年/月/站点/关键词/输出格式等） | P0 |
| FR-I3 | DAG 边的 `dataMapping` 自动推断（如 scraper.md_path → filter.md_path → to_post.md_path） | P0 |
| FR-I4 | 在 TaskDetailPage 中以 React-Flow 风格可视化 DAG，显示节点状态（pending/running/completed/failed） + 数据流箭头 | P0 |
| FR-I5 | 当某个上游 Skill 输出无符合条件结果时，下游不报错失败，而是优雅短路（在 DAG 中标记 `skipped`） | P0 |
| FR-I6 | 规划完成后展示「执行预览」：用户可在执行前看到 DAG 与每个节点的输入参数，可取消 | P1 |
| FR-I7 | 任意中间节点产物（MD / CSV）都可在 UI 上单独下载、复用为下次任务输入 | P1 |
| FR-I8 | 至少完整跑通 3 条参考工作流：①采集→筛选→转推文 ②采集→转推文（不筛选） ③仅筛选已有 MD | P0 |

### 4.10 视觉与交互重塑（FR-J）

> 设计依据：[ui-ux-pro-max 输出](../docs/DESIGN.md#16-视觉设计系统) — Glassmorphism 风格 + 深色 SaaS 调色板（`#020617` / `#0F172A` / `#22C55E` / `#F8FAFC`）+ Poppins / Open Sans。

| 编号 | 需求 | 优先级 |
|------|------|--------|
| FR-J1 | 全站切换为深色主题（默认 dark），保留 light 模式以备后续 | P0 |
| FR-J2 | 卡片、抽屉、Modal 全部采用毛玻璃质感（`backdrop-filter: blur(12-20px)` + 半透明描边） | P0 |
| FR-J3 | 所有可点击元素：`cursor-pointer` + 悬停时轻微上浮 1-2px + 边缘提亮 + 200ms 过渡 | P0 |
| FR-J4 | 运行中的卡片/节点带「脉冲呼吸」动效（柔和阴影周期变化），不超过 2s 一周期 | P0 |
| FR-J5 | 进度条带渐变流光（光斑从左到右循环移动） | P0 |
| FR-J6 | 长列表（事件、日志）滚动时使用平滑滚动 + 滚动方向感知（阴影提示有未读） | P1 |
| FR-J7 | 页面切换、抽屉打开、Modal 出现使用 fade-in + 轻微 translateY 过渡（≤ 300ms） | P0 |
| FR-J8 | 加载态全部使用骨架屏（skeleton），不再用全屏 spinner | P0 |
| FR-J9 | 关键按钮（提交、运行）使用主色 `#22C55E`，hover 提亮 + 轻微 scale（≤1.02），active 反向凹陷 | P0 |
| FR-J10 | 字体全站统一为 Poppins（标题）/ Open Sans（正文），中文回退到「PingFang SC」「Microsoft YaHei」 | P0 |
| FR-J11 | 全部图标改用 SVG（Heroicons 或 Lucide），不使用 emoji 当 UI 图标 | P0 |
| FR-J12 | 尊重 `prefers-reduced-motion`，开启时禁用脉冲与流光特效 | P0 |
| FR-J13 | 响应式断点：375 / 768 / 1024 / 1440，移动端侧边栏改为抽屉 | P1 |
| FR-J14 | 整体视觉与交付前对照「ui-ux-pro-max Pre-Delivery Checklist」逐项校验 | P0 |

---

## 5. 非功能需求（NFR）

| 类别 | 编号 | 要求 |
|------|------|------|
| **性能** | NFR-1 | Skill Builder 单轮回复（含 LLM 调用）p95 < 8 秒 |
| | NFR-2 | 进度事件从脚本 emit 到前端渲染端到端延迟 p95 < 500ms |
| | NFR-3 | 单 Skill 创建会话 LLM token 消耗 ≤ 6000 |
| **可靠性** | NFR-4 | WebSocket 断线 3 秒内自动重连（已具备）+ 新增 SSE 作为兜底通道 |
| | NFR-5 | 已生成的 SKILL.md 在写入失败时回滚，绝不留下半成品文件 |
| | NFR-6 | 进度事件丢失不影响最终结果正确性（事件是观测，不是控制流） |
| **可用性** | NFR-7 | 业务用户在不看任何文档的情况下，10 分钟内能创建出第一个 user Skill |
| | NFR-8 | 所有 destructive 操作（删除、覆盖）必须有二次确认 |
| **兼容性** | NFR-9 | 现有 4 个内置 Skill 的对外 input/output schema 保持兼容（policy-to-post 仅新增字段） |
| | NFR-10 | 改造后旧版本的 SKILL.md（无 source 字段）依然可加载，自动视为 builtin |
| **安全** | NFR-11 | Skill Builder 生成的脚本入口必须落在 `skills/<name>/scripts/` 之下，禁止路径穿越 |
| | NFR-12 | 内置 Skill 删除/重大改动需后端二次校验 `confirmBuiltin: true` 头才执行 |
| **可维护性** | NFR-13 | 进度协议（CORAL_PROGRESS）有独立文档章节，新 Skill 作者一看就会用 |
| **可观测性** | NFR-14 | 所有新增事件类型纳入 audit_logs，可回溯查询 |
| **性能** | NFR-15 | DAG 可视化在 ≤ 20 节点时帧率 ≥ 60fps，悬停响应 < 16ms |
| **性能** | NFR-16 | information-filter 每条 LLM 评估 p95 < 3 秒；100 条总耗时 ≤ 5 分钟 |
| **可访问性** | NFR-17 | 所有动效满足 WCAG 2.1 AA（不闪烁、不眩晕、可禁用） |
| **可访问性** | NFR-18 | 颜色对比度 ≥ 4.5:1（深色背景下白字、绿按钮均需校验） |

---

## 6. 范围与边界

### 6.1 本期范围（IN）

- Skill Builder 多轮对话与落盘（参考 anthropics/skill-creator 工程模式）
- Skill CRUD（含 builtin 二次确认）
- 进度事件三件套（progress / log / artifact）+ WS + SSE 双通道
- policy-scraper 流式 + MD/CSV 双输出 + 智能站点/月份提取
- policy-to-post 双输入 + 流式
- **新增 information-filter Skill** 多源 + 公司画像驱动
- **公司画像**（平台配置 + 任务覆盖）
- **组合任务自动编排**（PlanningEngine 多 Skill 串接 + DAG 可视化）
- **视觉系统重构**（Glassmorphism + 动效 + 字体 + 图标体系）
- TaskDetailPage 进度可视化 + DAG 节点视图
- ChatPage 集成「创建技能 / 跑组合任务」模式入口

### 6.2 本期不做（OUT）

- ❌ 真正的服务端 ASR（仅做浏览器端 Web Speech API 语音转文字）
- ❌ Skill 版本号自动递增和 Git 化版本管理（保留为后续迭代）
- ❌ 多用户隔离 / RBAC 权限模型（当前 userId 仍为占位）
- ❌ Skill 市场 / 共享导入导出（保留为后续迭代）
- ❌ Docker 沙箱真正隔离（仍走 process 模式）

### 6.3 假设与约束

- 用户一次只跑 1–3 个并发任务（不做大规模压测）
- LLM 上下文窗口 ≥ 32K（当前 SiliconFlow 模型满足）
- 用户的浏览器支持 WebSocket、SSE、Web Speech API（Chrome/Edge ≥ 90）
- Python 3.9+ 运行环境，已安装 selenium、webdriver_manager、pandas

---

## 7. 验收门槛（高层）

> 详细测试用例见 [设计文档 §11](./DESIGN.md#11-测试用例与验收标准)。

本期升级**整体验收**通过的硬性条件：

1. ✅ 不写一行代码，业务用户可在 UI 上完成「描述需求 → 生成 Skill → 调用新 Skill 完成任务」全链路
2. ✅ 用户在技能列表对任意 Skill 进行编辑/删除（含 builtin 二次确认）
3. ✅ 政策采集任务运行期间，前端进度条持续推进，停留时间 ≤ 5 秒一次刷新
4. ✅ 同一份政策原文，既可用粘贴 MD 文本运行 policy-to-post，也可用 CSV/MD 文件路径运行
5. ✅ WebSocket 主动断开时，SSE 仍能持续接收进度事件（手动测试）
6. ✅ 现有 4 个内置 Skill 在升级后均能正常运行（回归测试）
7. ✅ 公司画像在设置页编辑后，立即被 `information-filter` 引用（无需重启）
8. ✅ 一句话「采集广东工信厅 3 月政策，筛出与中试平台相关的，做成推文」可端到端跑通（DAG 自动生成 3 节点）
9. ✅ DAG 可视化能正确显示节点状态、数据流向；运行中节点带脉冲；失败节点高亮红色
10. ✅ ui-ux-pro-max Pre-Delivery Checklist 全项通过（无 emoji 图标、cursor-pointer 全覆盖、对比度 ≥ 4.5、动效 ≤ 300ms）

---

## 8. 风险与开放问题

| 编号 | 风险 | 缓解 |
|------|------|------|
| R-1 | LLM 多轮对话偶发偏题，生成不可执行的 SKILL.md | 服务端做 schema 严格校验 + 用户可手动编辑兜底 |
| R-2 | 流式 LLM API 在 Mock 模式下不可用 | 降级为「分阶段假进度」（按预估时长定时推送） |
| R-3 | Selenium 启动慢导致首条进度事件延迟 5–10 秒 | 在浏览器启动前先 emit `phase: initializing` 进度 |
| R-4 | SSE 与 WS 重复推送可能导致前端事件重复渲染 | 事件 ID 去重（前端按 eventId 维护 Set） |
| R-5 | 用户写出的 Skill prompt 注入恶意指令 | 现阶段仅做语法校验，不做内容审查（在 Roadmap 标注） |
| R-6 | LLM 对组合任务参数提取失败（如把"3 月"识别成站点名） | 规划引擎二次校验 + 失败时弹「请补充参数」对话框 |
| R-7 | information-filter 对大批量条目（>100）token 占用过高 | 自动分批 + 截断长描述（保留标题与摘要） |
| R-8 | DAG 可视化引入 react-flow 增加打包体积 ~150KB | 按需加载（dynamic import），仅 TaskDetailPage 引入 |
| R-9 | 视觉重构破坏现有页面，回归引入 bug | 视觉层与逻辑层解耦：先在新建页面验证，再逐页推 |
| R-10 | 动效在低端设备上卡顿 | `prefers-reduced-motion` + 关键动效用 transform/opacity |

---

## 9. 文档约定

- 所有需求条目使用 `FR-X#` / `NFR-#` 编号，便于设计/任务文档反向引用
- 优先级：**P0**（必须） / **P1**（应当） / **P2**（可选）
- 本期 P0 全部交付即可发布 v1.1.0；P1 视进度交付；P2 进入下一迭代
