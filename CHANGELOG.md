# Changelog

## 2.2.0（2026-10-28）— 扩展面 + 产物预览

在 v2.1 纪律层之上，把内部机制变成用户可插拔的开放接口：

- **外部命令守卫（hooks）**：data/hooks.json 在 8 个生命周期点调用外部命令，可否决工具调用/改写工具入参/升级人工审批/打回最终回答；pre 路径 fail-closed；mtime 失效检查热加载
- **斜杠命令**（data/commands，输入 / 弹窗补全）与**具名子代理**（data/agents，描述+触发例示注入主提示，agent_spawn 按名委派）
- **产物预览**：回复底部自动列出本轮生成/修改的文件，点击右侧面板预览（文本直读 / docx 提取全文 / PDF·图片浏览器原生渲染）
- **@ 引用工作区文件**（弹窗选择 + 上下文注入）与 **✨ 提示词优化**（理解意图→改写）
- **压缩失败冷却阶梯**（60/300/900s）+ 确定性摘要兜底；**ESTOP 急停哨兵**（coral pause/resume）；**审批选择记忆**（scope=session）
- **运行预算用户可调**（设置页，上限 1000 万 token）+ 会话页实时 token 消耗指示器
- **技能创建质量门**（占位名/空话描述/近重复查重）+ skill-authoring 元技能
- **假终答三连守卫**：空回答守卫 / 未竟任务守卫（清单未完成+承诺式收尾打回）/ 话术收工门
- web-search 免 key 降级链（Bing RSS 按语言选主机 → DDG Lite）
- 修复：hooks 后建配置不加载（watchFile 缺陷）、双 data 目录（pause 曾拉闸无效）、CI 三平台全红（跨平台路径 hack / 反斜杠穿越归一 / Python 代码页）
- 测试 326 → 403；技能库 21 个；CI 三平台绿

## 2.1.0（2026-10-27）— 运行时纪律层

把「模型能干什么」升级为「运行时怎么保证模型干得对」——18 项确定性机制：

- **工具效果契约**：效果位（写盘/进程/联网/幂等）推导审批档位，注册期 fail-closed 封缄；MCP 标准注解映射
- **证据记录层**：超预算工具结果落盘为不可变记录（summary-first + evidence_read 分页取回 + 工具间引用）
- **三层上下文压缩**：裁剪 → 收纳旧结果 → 全量摘要，4 档用量预警 + 熔断器（后升级为冷却阶梯）
- **事实门**：改/覆盖已有文件前必须读过（盲改确定性拒绝）；**收工门**：最终回答合理化话术审计打回
- **记忆升级**：信任分级（unreviewed/reviewed）、防覆盖守卫、决策（what+why）与接力记录
- **习惯学习管线**：观察 → 蒸馏 → 置信度（0.3→0.9）→ 晋升技能（≥0.8 且跨 ≥2 会话）
- **双盲会审**（dual_review）+ **五轴自评**（低分必须给证据）+ **配置自清理** + **coral doctor** 8 通道自检
- **子代理防御前言** + 主循环不可信数据纪律；技能库扩容 9 个原创工作流技能（深度调研/蓝图规划/多方议事/站点哨兵 等）


## 2.0.0（2026-10-04）

v2 全里程碑（M0–M4）完成的第一个正式版本。v1（`backup/v1-history` 标签）→ v2 重写全记录见 git log；本文件从 v2.0.0 起维护。

### 里程碑

- **M0 地基**：SQLite（WAL/版本化迁移）、真取消（AbortSignal 全链路）、真超时（进程树强杀）、重试分类学（瞬时/永久/取消）、安全默认（127.0.0.1/CORS 白名单/env 白名单）、CI 三平台。
- **M1 Harness 内核**：Agent Loop（ReAct + sub-agents + 上下文压缩）、Agentic Workspace（三档权限 + diff 审批 + 路径三层守卫）、文件式长期记忆（自动提炼）、双 provider、技能导入（Anthropic Agent Skills）、Chat 会话（流式直播/多轮续接）。
- **M2 Graph 模式**：YAML DSL（校验器/模板展开）、事件驱动引擎（修复 v1 全部调度缺陷 A2/A4/A5/A6/A10）、goal→graph AI 编译（x-planning 扩展）、节点级审批（改参数续跑）、断点恢复（checkpoint resume）、Workflow 页。
- **M3 连接器**：MCP 双向桥（`coral mcp serve` 出 + 外部 server 入，失败隔离）、定时/cron/webhook 触发器、进度协议 v1.0（双语言 SDK 发布就绪）。
- **M4 旗舰**：Time-Travel（checkpoint 时间轴 + fork 重跑）、内置技能五件（web-digest/arxiv-daily/github-repo-report/csv-insight/web-search）、`coral` CLI 单命令（自检 + web 内嵌静态托管）、政策场景包迁入 examples。

### 真实模型工程（亮点）

DSML 退化归一化（DeepSeek 工具调用文本形态转正）、工具名幻觉纠正（别名+编辑距离）、todo 清单三重保障（开局强制/跳过提醒/终态收口）、事件溯源（全量事件可回放导出）、上下文管理（裁剪+压缩，工具组完整性保证）。

### 全面审查与错题集

v2.0.0 前做了三路并行全量审查（约 60 条发现，P0/P1/P2 全修），并建立 [docs/REGRESSIONS.md](./docs/REGRESSIONS.md) 错题集机制（bug→根因→教训→防回归检查→回归测试）。其中最重要的发现：流式路径丢失 tools 定义长达数月，由 DSML 容错机制长期掩盖（REG-01）。

### 测试

321 用例全绿（server 317 + progress 4）· GitHub Actions 三平台（ubuntu/windows/macos × Node 20/22）· TypeScript strict。
