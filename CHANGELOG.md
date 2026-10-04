# Changelog

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
