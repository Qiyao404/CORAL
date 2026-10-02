# CORAL 平台升级 — 任务文档

> 版本：**v1.1.0**（rev 2 + impl 2026-04-25）  日期：2026-04-25  状态：**已实现**
> 关联文档：[需求文档 REQUIREMENTS.md](./REQUIREMENTS.md) ｜ [设计文档 DESIGN.md](./DESIGN.md) ｜ [快速使用 USE.md](../USE.md)
>
> **rev 2 新增 / 调整任务**（已全部完成）：
> - ✅ M2: T-210（PlanningEngine 智能参数提取与组合任务规划）
> - ✅ M3a: T-307~T-310（公司画像 + information-filter Skill + 端到端组合任务）
> - ✅ M4 视觉子里程碑: T-410 / T-411 / T-412 全部落地
> - ✅ M2: T-211（Skill Builder 与 skill-creator 对齐 prompt 模板）
>
> **impl 实现进度**：v1.1.0 全部 P0 任务已交付（见每个里程碑下的 ✅ 标记）。
> P1/P2 任务部分留待 v1.2.0（如 .history/ 编辑历史 UI、A/B 测试不同画像）。

---

## 0. 阅读说明

| 字段 | 含义 |
|------|------|
| **ID** | 任务唯一编号，可在 PR、Issue 中引用 |
| **优先级** | P0 必须 / P1 应当 / P2 可选 |
| **依赖** | 必须在哪些任务完成后才能开始 |
| **预估** | 人日（按 1 人独立完成） |
| **验收** | 完成判据（指向 DESIGN §11 测试用例编号） |
| **交付物** | 代码文件、文档、API 等具体产出 |

---

## 1. 里程碑划分

```
M1:  基础设施（事件 + 协议 + 类型扩展）                       → 第 1 周
M2:  后端核心能力（CRUD + Builder + 流式 + Planning 升级）    → 第 2 周
M3:  政策双 Skill 改造（采集 / 转推文 流式 + 双 IO）          → 第 3 周
M3a: 公司画像 + 信息筛选 Skill + 组合任务联调                 → 第 4 周
M4:  前端视觉系统 + UI（SkillBuilder / DAG / 进度 / CRUD）   → 第 5 周
M5:  联调、测试、验收（含视觉走查）                           → 第 6 周
```

> 总预估：**约 6 周（1 人）** / **3 周（2 人并行）** / **2.5 周（3 人并行：后端 + 前端 + Skill/Python）**。

---

## 2. M1 — 基础设施（第 1 周）

### T-101  扩展类型定义与事件枚举
- **优先级**：P0  · **依赖**：无 · **预估**：0.5d
- **范围**：
  - 在 `packages/server/src/types/index.ts` 新增 `source/createdBy/creatorSessionId` 字段（扩展 `ParsedSkillManifest`）
  - 新增 3 类事件枚举（`skill.progress` / `skill.log` / `skill.artifact`）
  - 新增 5 类 `skill_builder.*` 事件
  - 新增 `SkillProgressPayload` / `SkillLogPayload` / `SkillArtifactPayload` / `SkillBuilderSession` 接口
- **验收**：类型编译通过；现有代码 0 改动可继续编译
- **关联**：DESIGN §3.1

### T-102  Skill Manifest 解析器升级
- **优先级**：P0 · **依赖**：T-101 · **预估**：0.5d
- **范围**：
  - 修改 `skill-resolver.ts`，从 frontmatter 读取 `source` 字段，缺省 `'builtin'`
  - 同时读取 `created_by`、`creator_session_id`
- **验收**：TC-N4（旧 SKILL.md 加载） + 单测：4 个内置 Skill 都被识别为 `source: 'builtin'`
- **交付物**：`packages/server/src/skill-runtime/skill-resolver.ts`

### T-103  EventBus 通配符订阅与持久化策略
- **优先级**：P0 · **依赖**：T-101 · **预估**：0.5d
- **范围**：
  - EventBus 新增 `'*'` 通配符订阅能力（已有部分支持，确保新事件类型能命中）
  - 调整 auditStore：默认仅持久化 `task.*` / `agent.*` / `skill_builder.*`；`skill.log` / `skill.progress` 不进 audit（量太大），仅在内存 ring buffer
- **验收**：100 万次 log 注入后 audit_logs.json 文件大小 < 1MB
- **交付物**：`packages/server/src/event/event-bus.ts`

### T-104  CORAL_PROGRESS 协议解析器（独立模块）
- **优先级**：P0 · **依赖**：T-101 · **预估**：0.5d
- **范围**：新建 `packages/server/src/skill-runtime/progress-parser.ts`，输入 stderr buffer，输出 `{ progressEvents, logLines }`
- **验收**：TC-C1（单元测试 5 个用例：纯协议行 / 纯日志 / 混合 / 跨 chunk 截断 / 非法 JSON 被忽略）
- **交付物**：`progress-parser.ts` + `progress-parser.test.ts`

### T-105  emit_progress Python helper 模板
- **优先级**：P0 · **依赖**：T-104 · **预估**：0.25d
- **范围**：
  - 在 `skills/_lib/coral_progress.py` 提供统一 helper（可被多个 Skill import 或拷贝）
  - 文档：`docs/AUTHORING_PROGRESS.md`（也可放 README 章节）
- **验收**：示例脚本调用 → 服务端解析得到合法事件
- **交付物**：`skills/_lib/coral_progress.py`

### T-106  SSE 端点骨架
- **优先级**：P0 · **依赖**：T-103 · **预估**：0.5d
- **范围**：在 `packages/server/src/api/event.routes.ts` 增加 `GET /api/tasks/:taskId/stream`
- **验收**：TC-C4（curl 收到 SSE 流）
- **交付物**：`event.routes.ts`

---

## 3. M2 — 后端核心（第 2 周）

### T-201  Skill Executor LLM 流式改造
- **优先级**：P0 · **依赖**：T-103 · **预估**：1d
- **范围**：
  - `llm-client.ts` 新增 `completeStream()` 方法
  - `SkillExecutor.executeLlmOnly()` 改用 stream，每个 chunk emit `skill.log`（source=`llm_stream`）
  - Mock 模式下：分阶段假进度 emit
- **验收**：TC-C3、TC-C8
- **交付物**：`llm-client.ts`、`skill-executor.ts`

### T-202  Skill Executor Script 流式改造
- **优先级**：P0 · **依赖**：T-104 · **预估**：1d
- **范围**：
  - `executeScript()` 中改造 `child.stderr` 监听：增量解析协议行 → emit progress；其余行 → emit log
  - 增加 stdout/stderr 跨 chunk 缓冲（防止 JSON 行被切断）
- **验收**：TC-C2、TC-C7
- **交付物**：`skill-executor.ts`

### T-203  Skill CRUD API：PUT
- **优先级**：P0 · **依赖**：T-102 · **预估**：1d
- **范围**：
  - `PUT /api/skills/:name`：接收 `{frontmatter, promptContent, referenceContent?, scriptContent?}`
  - 校验 → 写盘（原子 rename）→ 触发 `registry.reloadSkill(name)`
  - Builtin 守卫：校验 `X-Confirm-Builtin` header
  - （P2）写入前快照到 `.history/`
- **验收**：TC-B1 / TC-B2 / TC-B3 / TC-B8 / TC-N7
- **交付物**：`skill.routes.ts` + 新建 `skill-writer.ts`

### T-204  Skill CRUD API：DELETE
- **优先级**：P0 · **依赖**：T-102 · **预估**：0.5d
- **范围**：
  - `DELETE /api/skills/:name?physical=true`
  - Builtin 守卫
  - 默认仅取消注册，physical 移到 `skills/.trash/<name>-<ts>/`
- **验收**：TC-B4 / TC-B5 / TC-B6
- **交付物**：`skill.routes.ts`

### T-205  Skill 列表筛选扩展
- **优先级**：P1 · **依赖**：T-102 · **预估**：0.25d
- **范围**：`GET /api/skills?source=user|builtin` 支持新 query
- **验收**：TC-B9
- **交付物**：`skill.routes.ts`

### T-206  Skill Builder Service（核心状态机）
- **优先级**：P0 · **依赖**：T-201 · **预估**：1.5d
- **范围**：
  - 新建 `packages/server/src/services/skill-builder-service.ts`
  - 实现 createSession / appendMessage / getDraft / commitSession / cancelSession
  - 核心 LLM 反问 prompt（DESIGN §5.2）+ JSON 解析容错
  - 持久化到 `data/skill_builder_sessions.json`
- **验收**：TC-A1 / TC-A2 / TC-A3 / TC-A9
- **交付物**：`skill-builder-service.ts` + 单测

### T-207  Skill Builder API 路由
- **优先级**：P0 · **依赖**：T-206 · **预估**：0.75d
- **范围**：在 `packages/server/src/api/skill-builder.routes.ts` 实现 7 个端点（POST/GET/PATCH/DELETE 见 DESIGN §5.3）
- **验收**：TC-A4
- **交付物**：`skill-builder.routes.ts`

### T-208  Skill Builder commit 落盘
- **优先级**：P0 · **依赖**：T-207 · **预估**：1d
- **范围**：
  - 拼装 SKILL.md（YAML stringify + 正文）
  - 临时目录 → `fs.rename` 原子搬迁
  - 重名检测 + `?overwrite` 支持
  - 路径穿越守卫
  - 调用 `registry.reloadSkill()`
- **验收**：TC-A5 / TC-A6 / TC-A7 / TC-A8 / TC-N6
- **交付物**：`skill-builder-service.ts` 中 commit 方法

### T-209  注册 Skill Builder 路由 + 平台启动联通
- **优先级**：P0 · **依赖**：T-207 · **预估**：0.25d
- **范围**：在 `packages/server/src/index.ts` 注册新路由
- **验收**：服务启动健康；新接口可访问

### T-210  PlanningEngine 智能参数提取 + 组合任务规划
- **优先级**：P0 · **依赖**：T-101、T-102 · **预估**：1.5d
- **范围**：
  - `packages/server/src/planning/planning-engine.ts` 升级 prompt：注入 `input_keys` / `site_aliases` / `default` / `company_profile`
  - 新增「站点别名表」加载逻辑：从 `skills/policy-scraper/reference.md` 解析 `site_aliases`
  - 输出 `agents[*].skillInputTemplates[*]` 必须含从自然语言提取的具体参数（year/month/sites/keywords/...）
  - 缺参兜底：缺必填字段时任务 `failed`，error.reason 列出缺哪些参数（DESIGN §19.4）
  - 「优雅短路」：在 `dag-scheduler.ts` 加上 `empty_when` 判定，下游 cancelled 而非 failed
- **验收**：TC-I1 / TC-I2 / TC-I3 / TC-I4 / TC-I5 / TC-I6 / TC-I7 / TC-I8
- **交付物**：`planning-engine.ts`、`dag-scheduler.ts`、`reference-loader.ts`（新建）

### T-211  Skill Builder 与 anthropics/skill-creator 对齐
- **优先级**：P1 · **依赖**：T-208 · **预估**：0.75d
- **范围**：
  - 抽取 prompt 段为 `system_prompt` + `field_specs[]` + `examples[]`（DESIGN §5b.2）
  - 提交后自动跑一次 dry-run 测试（默认输入），结果写入 SkillBuilderSession.testResult
  - SKILL.md frontmatter 自动写入 `creator_session_id`
  - 反问失败兜底：退回表单填写模式（前端配合在 T-405）
- **验收**：TC-A2（多轮反问）+ TC-A4（API 返回结构）+ 新增 TC-A10（提交后 testResult 非空）
- **交付物**：`skill-builder-service.ts` 重构 + 单测

---

## 4. M3 — 政策 Skill 改造（第 3 周）

### T-301  policy-scraper 进度埋点
- **优先级**：P0 · **依赖**：T-105 · **预估**：1d
- **范围**：
  - `scrape.py` import `coral_progress.emit_progress`
  - 在 init / 浏览器启动 / 每个站点开始 / 每页 / 站点结束 / 写文件 / 完成 共 ≥ 6 处埋点
  - 整体百分比按已处理站点数计算
- **验收**：TC-D1 / TC-D5
- **交付物**：`skills/policy-scraper/scripts/scrape.py`

### T-301a  policy-scraper 站点参数支持 + 别名表
- **优先级**：P0 · **依赖**：T-301 · **预估**：0.75d
- **范围**：
  - `scrape.py` 新增 `--sites` 参数（逗号分隔的 ID 列表，缺省 = 全部）
  - SKILL.md frontmatter input_schema 增加 `sites: { type: array, items: { type: string } }`
  - `reference.md` 中维护 `site_aliases` 全表（DESIGN §19.3）
  - 站点 ID 不存在时：抛 `ValueError`，进度事件 phase=`error`，列出可用 ID
- **验收**：FR-D7 / FR-D10；新增 TC-D9（仅跑 sites=["gdii"]）/ TC-D10（无效 site ID 报错）
- **交付物**：`scrape.py`、`reference.md`、`SKILL.md`

### T-302  policy-scraper MD 输出
- **优先级**：P0 · **依赖**：无 · **预估**：1d
- **范围**：
  - 新增 `write_md(items, path)`：按机构分组、含汇总表、按日期降序
  - 同时写出 MD 与 CSV
  - 更新 `output_schema`（SKILL.md frontmatter）
- **验收**：TC-D2 / TC-D6 / TC-D8
- **交付物**：`scrape.py` + `SKILL.md`

### T-303  policy-scraper 失败容忍与汇总
- **优先级**：P1 · **依赖**：T-301、T-302 · **预估**：0.5d
- **范围**：单站超时/异常时记入 `summary.failed_sites`，MD 输出有「失败站点」章节
- **验收**：TC-D3 / TC-D7
- **交付物**：`scrape.py`

### T-304  policy-to-post 输入扩展（双输入）
- **优先级**：P0 · **依赖**：无 · **预估**：1d
- **范围**：
  - `convert.py` 新增 `parse_md_content()`、`load_input(args)` 路由 3 种输入
  - 更新 `input_schema`（SKILL.md frontmatter）oneOf 三选一
  - 兼容老 `input_file` 字段（自动识别 .md / .csv）
- **验收**：TC-E1 / TC-E2 / TC-E3 / TC-E4 / TC-E5 / TC-E6
- **交付物**：`convert.py` + `SKILL.md`

### T-305  policy-to-post 进度埋点
- **优先级**：P0 · **依赖**：T-105、T-304 · **预估**：0.5d
- **范围**：每条政策处理前后 emit_progress；fetching、llm_call、writing 各 phase
- **验收**：TC-E7 / TC-E8
- **交付物**：`convert.py`

### T-306  端到端串接验证
- **优先级**：P0 · **依赖**：T-301~T-305 · **预估**：0.5d
- **范围**：
  - 跑 `policy-scraper` 拿到 `md_path`
  - 把该 path 作为 `policy-to-post` 的 `md_path` 输入跑通
  - 编写脚本 `scripts/test-policy-pipeline.sh`
- **验收**：TC-E9
- **交付物**：`scripts/test-policy-pipeline.sh`

---

## 4a. M3a — 公司画像 + 信息筛选 Skill + 组合任务（第 4 周）

### T-307  公司画像后端服务
- **优先级**：P0 · **依赖**：T-101 · **预估**：1d
- **范围**：
  - 新增 `data/company_profile.json` + 默认种子（DESIGN §17.2）
  - 新增 `services/company-profile-service.ts`（getProfile / putProfile 自增 version）
  - 新增 `api/company-profile.routes.ts`（GET / PUT）
  - 在 SkillExecutor 注入 profile：检查 manifest 的 `consumes_company_profile` 字段
  - 任务级覆盖：`POST /api/tasks` 的 `constraints.companyProfileOverride` 深合并
- **验收**：TC-G1 / TC-G2 / TC-G3 / TC-G4
- **交付物**：`company-profile-service.ts` / `company-profile.routes.ts` / 类型扩展

### T-308  information-filter Skill 实现
- **优先级**：P0 · **依赖**：T-307、T-201 · **预估**：1.5d
- **范围**：
  - 新建 `skills/information-filter/SKILL.md`（含 frontmatter `consumes_company_profile: true`）
  - 新建 `skills/information-filter/reference.md`（含历史 prompt 模板与变量说明）
  - 因为是 `execution_mode: llm_only`，主体逻辑由 SkillExecutor 跑；但归一化（normalizer）需要前置脚本
  - 选项 A：把它做成 hybrid，scripts/normalize.py 完成多源 → FilterableItem，再交给 LLM
  - 选项 B：纯 llm_only，由系统提示明确要求 LLM 自行处理多源（更简单但少了结构性保障）
  - **采用 A**：normalize.py（处理 md/csv/url/text）+ 系统 prompt（DESIGN §18.3）
  - 输出：MD（DESIGN §18.5）+ CSV
  - 进度事件：每完成一批 emit `skill.progress`
- **验收**：TC-H1~TC-H10 + TC-H12
- **交付物**：`skills/information-filter/`（SKILL.md / reference.md / scripts/normalize.py / scripts/filter.py）

### T-309  设置页公司画像表单（前端）
- **优先级**：P0 · **依赖**：T-307、T-410 · **预估**：1d
- **范围**：
  - `SettingsPage.tsx` 新增「公司业务画像」分区（DESIGN §17.5）
  - 关键词输入：tag input（粘贴换行/逗号自动拆分）
  - 保存调用 `PUT /api/company-profile`，带乐观更新与失败回滚
  - 提供「恢复默认」「试运行筛选」两个动作
- **验收**：TC-G5
- **交付物**：`SettingsPage.tsx`（含子组件 `CompanyProfileForm.tsx`）

### T-310  组合任务端到端联调
- **优先级**：P0 · **依赖**：T-210、T-301a、T-308 · **预估**：1d
- **范围**：
  - 一句话「采集广东工信厅和佛山住建局 2026 年 3 月政策，筛出与公司相关的，做成推文」
  - 后端 PlanningEngine 必须输出 3 节点 DAG（scraper → filter → toPost）
  - 数据流：scraper.md_path → filter.md_path → toPost.md_path
  - 每个节点都能看到流式进度
  - 中间产物可单独下载（artifact 事件）
  - 编写 `scripts/e2e/composite-pipeline.sh`
- **验收**：TC-I9 / TC-I10
- **交付物**：脚本 + 演示报告

---

## 5. M4 — 前端视觉系统 + UI（第 5 周）

### T-401  useTaskStream Hook（WS + SSE 双通道 + 去重）
- **优先级**：P0 · **依赖**：T-106 · **预估**：1d
- **范围**：
  - 新建 `packages/web/src/hooks/useTaskStream.ts`
  - 同时建 WS 连接和 SSE 连接，按 eventId 去重
  - 派生 `progressByAgent: Record<agentId, ProgressState>`
  - 暴露 `transport: 'ws' | 'sse' | 'both' | 'none'`
- **验收**：TC-C5 / TC-C6 / TC-C7
- **交付物**：`useTaskStream.ts`

### T-402  TaskDetailPage 进度可视化
- **优先级**：P0 · **依赖**：T-401 · **预估**：1d
- **范围**：
  - 替换原 `useWebSocket` 为 `useTaskStream`
  - 每个 Agent 卡片增加进度条 + 当前阶段文字 + 已耗时
  - 新增可折叠「实时日志」面板（虚拟滚动，最多 500 条）
  - 新增「产物列表」面板（artifact 事件聚合）
- **验收**：TC-C9 / TC-C10
- **交付物**：`TaskDetailPage.tsx`

### T-403  SkillsPage 重构（编辑/删除 + 二确认）
- **优先级**：P0 · **依赖**：T-203、T-204 · **预估**：1.5d
- **范围**：
  - 列表项右侧「···」菜单：编辑 / 测试 / 删除
  - 编辑抽屉：左 form（frontmatter）+ 右 Monaco（promptContent）
  - 删除二确认 modal（builtin 必输入名字）
  - tab：全部 / 内置 / 用户
  - 新增「+ 新建技能」按钮跳转 `/skill-builder`
- **验收**：TC-B7 / TC-Z2 / TC-Z5
- **交付物**：`SkillsPage.tsx` + 子组件

### T-404  api/client.ts 接口扩展
- **优先级**：P0 · **依赖**：T-203 / T-204 / T-207 · **预估**：0.5d
- **范围**：新增方法
  - `updateSkill(name, payload, confirmBuiltin?)`
  - `deleteSkill(name, opts: {physical?, confirmBuiltin?})`
  - `createBuilderSession() / sendBuilderMessage() / getBuilderPreview() / commitBuilder()` 等
- **交付物**：`packages/web/src/api/client.ts`

### T-405  SkillBuilderPage（多轮对话 + 实时预览）
- **优先级**：P0 · **依赖**：T-404、T-401 · **预估**：2d
- **范围**：
  - 路由 `/skill-builder` 与 `/skill-builder/:sessionId`
  - 左侧：Chat 风格对话区 + 文字 + 🎤Web Speech 按钮 + 「字段进度」横条
  - 右侧：Monaco 实时渲染 SKILL.md 草稿，可手动编辑
  - 底部：取消 / 预览 / 提交 按钮
  - 提交成功后跳转 `/skills`
- **验收**：TC-Z1
- **交付物**：`SkillBuilderPage.tsx` + 子组件

### T-406  ChatPage 增强（模式切换 + 跳转任务详情）
- **优先级**：P1 · **依赖**：T-405 · **预估**：0.5d
- **范围**：
  - 顶部加 tab：「执行任务 / 创建技能」（创建技能跳转到 SkillBuilder）
  - 添加 🎤 语音输入按钮（执行任务模式也可用）
  - 提交任务后默认跳转 `/tasks/:taskId`（FR-C9）
- **交付物**：`ChatPage.tsx`

### T-407  Dashboard 增强
- **优先级**：P1 · **依赖**：T-401 · **预估**：0.5d
- **范围**：
  - 顶栏「连接状态」指示灯（绿/黄/红）
  - 新增「正在运行的任务」卡片（基于全局 WS 订阅当前 executing 数）
  - mockMode 警告条（已有，保留）
- **交付物**：`DashboardPage.tsx`、新增全局 hook 或 context

### T-408  TasksPage 行内进度
- **优先级**：P1 · **依赖**：T-401 · **预估**：0.5d
- **范围**：每行任务在状态徽章旁显示进度% （来自最新 progress 事件，executing 状态才显示）
- **交付物**：`TasksPage.tsx`

### T-409  路由与导航更新
- **优先级**：P0 · **依赖**：T-405 · **预估**：0.25d
- **范围**：`App.tsx` 注册 `/skill-builder` 路由；侧边栏增加入口
- **交付物**：`App.tsx`

### T-410  设计 Tokens + Tailwind 配置 + 全局样式
- **优先级**：P0 · **依赖**：无 · **预估**：1d
- **范围**：
  - `packages/web/tailwind.config.ts` 注入完整 colors/fonts tokens（DESIGN §16.2/16.3）
  - `packages/web/src/styles/globals.css`：Google Fonts import、`.glass` 基类、滚动条样式、`prefers-reduced-motion` 全局规则、关键 keyframes（progress-flow / node-pulse / skeleton-shimmer）
  - 替换 `index.html` body 默认字体
  - 新增 `packages/web/src/components/ui/`：Button / Card / Drawer / Modal / Tag / Skeleton / ProgressBar / StatusIcon / EmptyState 9 个统一组件
  - 文档：`docs/DESIGN_SYSTEM_USAGE.md`（前端开发者参考）
- **验收**：TC-J1 / TC-J2 / TC-J3 / TC-J7 / TC-J11
- **交付物**：tailwind.config.ts / globals.css / `components/ui/*` / DESIGN_SYSTEM_USAGE.md

### T-411  React-Flow DAG 可视化组件
- **优先级**：P0 · **依赖**：T-410、T-401 · **预估**：1.5d
- **范围**：
  - 安装依赖：`reactflow` + `dagre`
  - 新建 `packages/web/src/components/dag/AgentDag.tsx`（自定义节点 AgentNode、自动布局、状态动画）
  - 与 `useTaskStream` 联动：节点 data 由 `progressByAgent` 派生
  - 节点状态色映射（DESIGN §20.2）+ 边样式 + 数据流标签
  - 节点点击 → 展开右侧详情抽屉（复用 T-402 的事件流面板）
  - 性能：≥ 60fps（NFR-15）
- **验收**：TC-I9 / TC-J4 / NFR-15
- **交付物**：`AgentDag.tsx`、`AgentNode.tsx`、`dag-layout.ts`

### T-412  动效与交互细节包（视觉走查）
- **优先级**：P0 · **依赖**：T-410、T-411、M4 主体完成 · **预估**：1d
- **范围**：
  - 按 DESIGN §16.5 给以下场景加动效：卡片悬停 / 按钮 hover&active / 页面切换 / Modal&Drawer 进出 / 列表项入场 / 进度条流光 / 节点脉冲
  - 替换全站全屏 spinner 为骨架屏
  - 全站滚动条统一样式
  - 全站图标审计：grep 排查并替换 emoji 为 Lucide SVG（FR-J11）
  - 对照 ui-ux-pro-max Pre-Delivery Checklist 逐项打勾
- **验收**：TC-J3~TC-J11；ui-ux-pro-max Pre-Delivery Checklist 全项 ✅
- **交付物**：动效相关 PR + 视觉走查报告 `docs/VISUAL_WALKTHROUGH_v1.1.0.md`

---

## 6. M5 — 联调、测试与验收（第 6 周）

### T-501  单元测试与集成测试补齐
- **优先级**：P0 · **依赖**：M2/M3/M3a 完成 · **预估**：1.5d
- **范围**：覆盖 §11.1–§11.11 所有 U/I 级用例
  - 关键：TC-A8（路径穿越）、TC-B6（删 builtin 守卫）、TC-C1（协议解析）、TC-E1/E2（MD parse）
  - **新增**：TC-G1~G4（公司画像）、TC-H1~H10（信息筛选）、TC-I1~I8（组合任务）、TC-J7~J11（视觉自动化检测）
  - 视觉自动检测：用 axe-core 跑可访问性 + 颜色对比度
- **验收**：测试覆盖率 ≥ 70%（核心服务模块）
- **交付物**：`*.test.ts` / `pytest` 文件 / `axe-results.json`

### T-502  端到端冒烟脚本
- **优先级**：P0 · **依赖**：M4 完成 · **预估**：1.5d
- **范围**：
  - `scripts/e2e/skill-builder-flow.spec.ts`（基于 Playwright 或简单 fetch + DOM 抓取）
  - `scripts/e2e/policy-pipeline.sh`
  - `scripts/e2e/skill-crud.sh`
  - **新增**：`scripts/e2e/composite-pipeline.spec.ts`（一句话三段链 → DAG → 产物，对应 US-6）
  - **新增**：`scripts/e2e/information-filter.sh`（三种输入形态各跑一次）
- **验收**：5+2 个核心 E2E（TC-Z1~Z5、TC-I10、TC-H11）全绿
- **交付物**：`scripts/e2e/`

### T-503  非功能性能验证
- **优先级**：P1 · **依赖**：M4 完成 · **预估**：0.5d
- **范围**：
  - 跑 50 次 Skill Builder 单轮，统计 p95（应 < 8s）
  - 用注入脚本验证 progress 端到端延迟（< 500ms）
  - 手动断 WS 验证 SSE 兜底
- **验收**：TC-N1 / TC-N2 / TC-N3
- **交付物**：性能报告 `docs/PERF_REPORT_v1.1.0.md`

### T-504  回归测试 — 现有 4 个内置 Skill
- **优先级**：P0 · **依赖**：T-202 · **预估**：0.5d
- **范围**：
  - 跑 summarize-document 测试
  - 跑 data-transform 测试
  - 跑 policy-scraper（小范围）
  - 跑 policy-to-post（小范围）
- **验收**：4 个 Skill 全部正常返回，输出格式不退化
- **交付物**：测试日志

### T-504a  视觉走查 + ui-ux-pro-max Checklist 对照
- **优先级**：P0 · **依赖**：T-412 · **预估**：0.5d
- **范围**：
  - 在 375 / 768 / 1024 / 1440 四档分辨率人工走查全部页面
  - 对照 ui-ux-pro-max Pre-Delivery Checklist 18 项逐项验证
  - 录制 30 秒整站演示视频（用于产品对外演示）
  - 整理「视觉走查报告」清单：通过项 / 待修复项 / 已知限制
- **验收**：FR-J14；checklist 全项 ✅，无可访问性致命问题（axe critical=0）
- **交付物**：`docs/VISUAL_WALKTHROUGH_v1.1.0.md` + 演示视频

### T-505  README 与文档更新
- **优先级**：P0 · **依赖**：M4 完成 · **预估**：0.5d
- **范围**：
  - 根 `README.md` 加 v1.1.0 改动说明、Skill Builder 使用指引、CORAL_PROGRESS 协议章节
  - 新增 `docs/AUTHORING_PROGRESS.md` 给 Skill 作者
  - 更新 `docs/REQUIREMENTS.md` / `DESIGN.md` 状态为「已发布」
- **交付物**：3 份文档

### T-506  发布与回滚演练
- **优先级**：P0 · **依赖**：T-501~T-505 · **预估**：0.25d
- **范围**：
  - 在 dev 环境部署 v1.1.0
  - 演练回滚到 v1.0.0：data 目录是否能继续启动
- **验收**：回滚后 v1.0.0 启动正常，所有 user Skill 仍可加载（无 frontmatter `source` 字段也兼容）
- **交付物**：发布 checklist

---

## 7. 任务依赖图（关键路径）

```
T-101 ──┬─▶ T-102 ──┬─▶ T-203 ─┬─▶ T-403
        │            │           │
        │            └─▶ T-204 ─┘
        │            │
        │            └─▶ T-210 ─────────────────────┐  (PlanningEngine 升级)
        │                                            │
        ├─▶ T-103 ─▶ T-201 ─▶ T-206 ─▶ T-207 ─▶ T-208┼▶ T-209
        │              │                              │   │
        │              ├─▶ T-202                      │   ▼
        │              │                              │  T-211（与 skill-creator 对齐）
        │              │
        │              └─▶ T-307 ──▶ T-308 ─▶ T-310
        │                              ▲
        ├─▶ T-104 ─▶ T-105 ─┬─▶ T-301 ─▶ T-301a ──┐  │
        │                   ├─▶ T-302 ─────────┐  │  │
        │                   ├─▶ T-303          │  │  │
        │                   ├─▶ T-304 ─▶ T-305─┴──┤  │
        │                   │                     │  │
        │                   └────────────────▶ T-306 │
        │                                            │
        └─▶ T-106 ─▶ T-401 ─┬─▶ T-402               │
                            ├─▶ T-407               │
                            └─▶ T-408               │
                                                    │
        T-410 ─▶ T-411 (依赖 T-401) ─┐              │
        T-410 ─▶ T-309 (依赖 T-307) │              │
                                     │              │
                       T-404 ──▶ T-405 ─▶ T-406 ─▶ T-409
                                          │
                                          ▼
                            T-412（依赖 T-410/411 + M4 主体）
                                          │
                                          ▼
                                T-501 / T-502 / T-503 / T-504 / T-504a / T-505 / T-506
```

**关键路径**：T-101 → T-102 → T-210 → T-308 → T-310 → T-411 → T-412 → T-502 → T-506

> 视觉路径（可与功能路径并行）：T-410 → T-411/T-412 → T-504a

---

## 8. 风险跟踪表

| 风险 | 关联任务 | 早期信号 | 缓解动作 |
|------|---------|---------|---------|
| LLM 流式 SDK 兼容性问题 | T-201 | 跑通 demo 失败 | 回退非流式 + 假进度（DESIGN §12.2） |
| Selenium 启动慢导致首条进度延迟 | T-301 | E2E 中 init phase 持续 > 10s 无更新 | 进入 init 立刻 emit_progress(percent=0) |
| Monaco / CodeMirror 引入包体积 | T-403、T-405 | 构建产物 > 5MB | 改用 textarea + 简易高亮（一期妥协） |
| Web Speech API 浏览器兼容 | T-405 | Firefox/Safari 不支持 | feature detect 后隐藏麦克风按钮 |
| 进度事件量大 → 浏览器卡顿 | T-402 | 滚动掉帧 | 虚拟滚动 + 仅保留最近 500 条 |
| commit 落盘部分失败导致半成品 | T-208 | 测试中观察 | 强制走 tmp + rename 原子操作 |
| PlanningEngine 错把"3月"识别成站点名 | T-210 | E2E TC-I1 失败 | prompt 显式列出参数 schema + 失败时弹缺参对话框 |
| information-filter 大批量 token 超限 | T-308 | 单批 > 8K tokens | 自动分批 ≤ 20 条 + excerpt 截断 200 字 |
| 视觉重构破坏现有页面 | T-410~T-412 | 回归测试发现样式错位 | 三步走（tokens → 核心 3 页 → 全量），每步独立 PR |
| React-Flow 包体积过大 | T-411 | 主包构建 > 6MB | 改用 dynamic import，仅 TaskDetailPage 引入 |
| 公司画像被多 Skill 误用 | T-307 | 与画像无关的 Skill 也注入 | 严格按 `consumes_company_profile` 字段判定 |
| 动效在低端设备卡顿 | T-412 | 移动端测试掉帧 | `prefers-reduced-motion` + 纯 transform/opacity |

---

## 9. 排期建议

### 9.1 单人串行 6 周

按 §1 里程碑顺序：M1 → M2 → M3 → M3a → M4 → M5。

### 9.2 2 人并行 ≈ 3 周

| 周 | 工程师 A（后端 + Skills） | 工程师 B（前端 + 视觉） |
|----|--------------------------|-----------------------|
| W1 | T-101/102/103/104/105/106 + 协议样例 | T-410（设计 Tokens / 全局样式 / UI 组件库） |
| W2 | T-201/202/203/204/205/210/211 + T-301~T-306 | T-401（mock 数据先行）+ T-404 + T-411 |
| W3 | T-206/207/208/209 + T-307/308/309/310 | T-402/403/405/406/407/408/409 + T-412 |
| 收尾 | T-501/T-504 | T-502/503/504a/505/506 |

### 9.3 3 人并行 ≈ 2.5 周（推荐）

| 角色 | W1 | W2 | W3 |
|------|----|----|----|
| 后端架构 | T-101~T-106 | T-201/202/210 + 配合 T-307 | T-206~T-209/T-211 + 联调 |
| Skill / Python | T-301/302（先行）+ T-304 | T-303/305/306/307/308 | T-310（端到端组合任务）+ T-501 |
| 前端 / 视觉 | T-410（必须先行 1 天）+ T-401/404 | T-411 + T-402/403 | T-405/406/407/408/409/412 + T-504a |

> **关键约束**：T-410 必须在 W1 第 1-2 天完成，否则后续所有前端任务的视觉一致性无法保障。

---

## 10. 完成定义（DoD）

每个任务都需满足以下 DoD：

- [ ] 代码已合并到主分支（PR 已 review）
- [ ] 单元测试 / 集成测试已通过（CI 绿）
- [ ] 关联的 DESIGN §11 测试用例编号已勾选验收
- [ ] 不破坏 §12.1 兼容矩阵（回归测试通过）
- [ ] 涉及到的 README / 文档已同步
- [ ] 不留 TODO 注释（必要的 P2 事项要登记到 Open Items）

---

## 11. 后续迭代候选（v1.2.0+，非本期）

- Skill 版本号自动递增 + Git 化版本管理
- Skill 市场（导入/导出）
- 真正的服务端 ASR
- 多用户 RBAC 权限
- Docker 沙箱真正隔离
- 编辑历史 `.history/` 与回滚 UI
- LLM 多模型路由（不同 Skill 用不同 model）
- **DAG 工作流编辑器**（拖拽节点、连线、保存为模板，即用户问题中的 `composite_task_ui = workflow_editor` 选项）
- **公司画像多版本对比**（A/B 测试不同画像的筛选效果）
- **information-filter 历史决策回流**（用户在前端勾选「保留/剔除」覆盖结果，下次 prompt 中作为 few-shot 示例）
- **多公司多租户**（公司画像按 workspace 隔离）
- **Skill 评测面板**（参考 anthropics/skill-creator/eval-viewer 实现）
