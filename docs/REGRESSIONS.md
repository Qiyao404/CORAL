# 错题集（Regression Ledger）

> **目的**：同样的 bug 不犯第二次。每条记录 = bug → 根因 → 教训 → 防回归检查。
>
> **使用规则（修 bug 必读）**：
> 1. 修任何 bug 前，先搜本文件确认是否已有同类教训（根因模式匹配）
> 2. 修完 bug **必须**在本文件登记一条（含回归测试位置），并在提交信息引用编号 `REG-xx`
> 3. "防回归检查"列是每次改对应模块时的自查清单
>
> **登记标准**：满足任一即登记——① 修了超过 30 分钟的 bug；② 根因涉及协议契约/状态机/异步时序；
> ③ 用户实测发现（非测试发现）；④ 同类问题第二次出现。

---

## 索引

| 编号 | 一句话 | 层 | 根因类别 |
|---|---|---|---|
| [REG-01](#reg-01) | stream() 丢失 tools，DSML 退化一直在兜底 | provider | 参数构造不对称 |
| [REG-02](#reg-02) | 流式重试不重置累积缓冲，内容/工具分片拼接 | provider | 重试边界状态残留 |
| [REG-03](#reg-03) | 上下文压缩把工具调用组从中间切开 | kernel | 切片边界不感知配对结构 |
| [REG-04](#reg-04) | 取消时 checkpoint 毒化会话续接 | kernel | 非法中间状态落库 |
| [REG-05](#reg-05) | 公文技能没解 stdin 包装，文档内容为空 | skill | 协议契约单侧遵守 |
| [REG-06](#reg-06) | emit_progress/emit_log 按旧签名调用，进度全是垃圾 | skill | API 签名漂移无对账 |
| [REG-07](#reg-07) | AI 编排把 JSON Schema 写进 input 默认值 | graph | LLM 输出零信任缺失 |
| [REG-08](#reg-08) | webhook 路由双层包装 body，变量不替换 | api | 单测直调绕过真实调用层 |
| [REG-09](#reg-09) | 事件 seq 计数器重启归零，新旧事件撞号 | service | 内存状态 vs 持久化状态 |
| [REG-10](#reg-10) | 上传文件永不清理，每轮对话都带 | web | 状态生命周期未设计 |
| [REG-11](#reg-11) | 绑工作区后模型声称无法联网 | prompt | 上下文偏置压过能力清单 |
| [REG-12](#reg-12) | 断线重连事件空洞 / REST 与 SSE 乱序 | web | 双通道合并无序 |
| [REG-13](#reg-13) | patch 脚本断言失败未写盘，tsc 通过误判已修复 | 工作流 | 验证的是过程不是行为 |
| [REG-14](#reg-14) | cron OR 语义误判（!has(0) 恒真），每周一变每天 | service | 值域假设未验证 |
| [REG-15](#reg-15) | 多工具块中途取消的部分应答组漏网（REG-04 只堵了单工具情形） | kernel | 修复只覆盖最简场景 |
| [REG-16](#reg-16) | 上轮补丁"成功"实际未生效（fire 推进/别名判定），终审才暴露 | 工作流 | 补丁验证不闭环 |

---

<a name="reg-01"></a>
## REG-01 · stream() 丢失 tools（P0，审查发现）

**现象**：Free 模式 agent 的工具调用一直"正常"，但 DeepSeek 频繁产生 `llm_degraded`（DSML 文本式工具调用）。
**根因**：`openai-compat.ts` 的 `complete()` 有 tools 映射、`stream()` 漏了 —— agent loop 主路径走 `chatStream` → `provider.stream`，**模型从未收到过 function 定义**，靠训练记忆以 DSML 文本形式打印工具调用，被归一化解析器"侥幸"转正。两层 bug 互相掩盖。
**教训**：同功能的多路径实现（complete/stream）必须共享参数构造；静默降级（DSML 归一化）会掩盖上游缺失——**当容错机制频繁触发时，它在替某个真 bug 挡枪**。
**防回归检查**：
- [ ] 改 provider 参数构造时，complete 与 stream 逐字段对照
- [ ] 若 DSML 退化率突然下降→警惕（可能不是变好，而是 tools 根本没传）
- 回归测试：`providers/__tests__` 的「stream 透传 tools」断言（拦截桩捕获实际参数）

<a name="reg-02"></a>
## REG-02 · 流式重试不重置累积缓冲（P1）

**根因**：`withRetry` 闭包内 `full`/`toolAcc`（anthropic: `text`/`toolBlocks`）跨尝试累积。重试仅在 `!delivered` 时发生，但"内容被 DSML 扣留"或"工具分片已到达"都不算 delivered → 第二次结果 = 半截①+全文②。
**教训**：重试闭包要重置**全部**跨尝试状态，不止是显示缓冲。写重试时列出所有 `let` 声明逐一对照。
**防回归检查**：[ ] 新增流式 provider 时，重试闭包第一行重置所有累积变量
- 回归测试：providers 测试「重试后 full/toolAcc 无拼接」

<a name="reg-03"></a>
## REG-03 · 压缩切开工具调用组（P1）

**根因**：`compressIfNeeded` 按 `keepRecent` 条数切片，边界落在 assistant(toolCalls) 与 tool 结果之间 → 孤儿 tool 消息 → 两家 API 都 400 → run 从此每轮失败。
**教训**：消息数组是**配对结构**（assistant.toolCalls ↔ tool.toolCallId），任何切片/裁剪/过滤必须按"组"为单位。
**防回归检查**：[ ] 改消息历史的任何裁剪逻辑时，确认 recent 首条不是 role:'tool'
- 回归测试：context-window 测试「边界落在工具组内时向前扩展」

<a name="reg-04"></a>
## REG-04 · 取消时 checkpoint 毒化续接（P1）

**根因**：取消发生在工具执行中，messages 末尾是"assistant 带 toolCalls 但无 tool 结果"，原样落 checkpoint；`continueSession` 把它种进下一次请求 → API 400 → 该会话永久续接失败。
**教训**：**落库的中间状态必须对"下次读取"合法**，不只是"当前写操作合法"。写 checkpoint 前问一句：这个状态再次加载后能直接用吗？
**防回归检查**：[ ] 取消/失败路径落库前，修剪悬空的 toolCalls / tool 消息（`sanitizeSessionHistory`）
- 回归测试：run-engine 测试「取消后 checkpoint 不含悬空 toolCalls」

<a name="reg-05"></a>
## REG-05 · 公文技能没解 stdin 包装（P1，用户发现：文档只有日期）

**根因**：执行器契约是 stdin = `{input, context}` 包装（AUTHORING_PROGRESS.md 有文档），official-document-generator / official-doc-expander 直接把 stdin 当输入解析 → 所有字段为空。scrape.py 是正确范例。
**教训**：**协议契约靠"照抄现有实现"传播必然漏** —— 新技能脚手架要从模板生成，而不是从记忆手写。
**防回归检查**：
- [ ] 新技能脚本第一行 stdin 解析：`payload.get('input', payload)`
- [ ] 写完技能必须带真实子进程冒烟（走 SkillExecutor，不是手动 echo）
- 回归测试：技能端到端测试（最小 SKILL.md + 脚本子进程）

<a name="reg-06"></a>
## REG-06 · emit_progress/emit_log 签名漂移（P1，审查发现）

**根因**：SDK 签名 `(phase, message, step, percent)`，脚本按旧想象 `(10, 100, '消息')` 调用 → 解析器丢弃非法字段，进度事件全是垃圾；`emit_log('error', msg)` 反转 → 真实错误信息丢失。
**教训**：双语言 SDK × 多脚本 = 高漂移面。**给 SDK 补冒烟测试（Python 侧）**，脚本 PR 必须带进度协议输出样例。
**防回归检查**：[ ] 脚本里的 emit_progress 首参必须是字符串 phase（grep `emit_progress\(\d` 应为 0 命中）
- 回归测试：`grep` 型约定测试（CI 可跑：正则扫描技能目录）

<a name="reg-07"></a>
## REG-07 · AI 编排输出零信任（P1，用户发现：无效 URL [object Object]）

**根因**：编译器把 JSON Schema 写进 input 默认值、引用编造的输出键（markdown vs content）。LLM 输出直接进执行链。
**教训**：LLM 产出 = 不可信输入。**每一层都校验，失败给可操作的错误信息**（不是 [object Object]）。
**防回归检查**：[ ] 编译器提示词规则 / DSL 校验器启发式 / 运行时类型守卫三层都在（缺一即回归）
- 回归测试：dsl「schema 形状默认值拦截」、graph-run-service「类型守卫快失败」、compiler「引用不存在技能/输出键」

<a name="reg-08"></a>
## REG-08 · 路由双层包装 body（P1，真机 DoD 才暴露）

**根因**：路由调 `fireWebhook(id, { body })`，服务签名第二参就是 body 本体 → 变量永远替换不上。单测直调服务层所以测不出。
**教训**：**单测直调会绕过调用层**（路由/适配器/middleware）——关键 API 必须有一条走完整 HTTP 栈的测试（fastify inject）。
**防回归检查**：[ ] 新路由 = fastify.inject 端到端测试，而非直调服务
- 回归测试：trigger.routes 的 fastify inject 用例（覆盖变量注入）

<a name="reg-09"></a>
## REG-09 · seq 计数器重启归零（P1，DoD 实测发现）

**根因**：进程重启后内存 `seqCounters` 从 0 起，新事件覆盖已持久化事件（seq 是 (run_id, seq) 主键）。
**教训**：**任何"内存计数器 + 持久化唯一键"组合，启动时必须从库里播种**（惰性 seed 首触生效最稳，覆盖所有发射路径）。
**防回归检查**：[ ] 新增事件/序列类计数器时，nextSeq 首触从持久层 max() 续接
- 回归测试：graph-run-service「重启后 resume 事件 seq 严格递增」

<a name="reg-10"></a>
## REG-10 · 上传文件状态永不清理（P2，用户发现）

**根因**：修"上传后消失"时把状态改成永不清理（矫枉过正），每轮对话重新注入全部历史文件。
**教训**：**任何"保留状态"的修复都要同时回答"何时清除"** —— 状态生命周期三问：谁创建？谁消费？谁销毁？答不出第三个就是 bug。
**防回归检查**：[ ] UI 暂存态（chips/草稿/选中项）必须有明确的清除时机（发送后/新建/切换）

<a name="reg-11"></a>
## REG-11 · 上下文偏置压过能力清单（P2，用户发现：绑工作区后"无法联网"）

**根因**：绑工作区后系统提示充满文件规则、工具列表 17→24，模型从上下文推断"这是本地文件任务"而拒绝联网——工具明明在列表里。
**教训**：**给模型的规则要显式对抗上下文偏置**（"即使绑定了工作区，web 工具始终可用"），不能假设模型会平权看待工具列表。
**防回归检查**：[ ] 新增工具类目时，检查系统提示是否有对应的存在性声明

<a name="reg-12"></a>
## REG-12 · Web 双通道事件合并无序（P2，审查发现）

**根因**：REST 回放与 SSE 实时事件按到达序合并，旧事件后到会把 UI 状态回退（清单变旧/工具卡复活转圈）。
**教训**：事件驱动 UI 的合并必须**按业务序号（seq）定序**，不按到达序。
**防回归检查**：[ ] 改 useRunStream/useTaskStream 合并逻辑时，确认 seq 排序仍然成立
- 回归测试：web 端 deriveRunView 纯函数测试（乱序事件输入 → 正确终态）

---

## 历史教训速查（V2 之前的重磅记录）

| 教训 | 出处 |
|---|---|
| heredoc 大 patch 会被 EOF 截断；Python 批量替换 `\n` 会变真实换行 | 环境坑（长期记忆） |
| `.js` 按 CommonJS 解析导致 ESM import 报错 — Node 技能入口必须 `.mjs` | M1-7 |
| Windows `shell:true` spawn 超时只杀 shell 不杀子进程（A11） | M0 |
| `writeSkillAtomic` 的备份写进 targetDir 后随目录删除——备份从未生效 | M0 测试发现 |
| 提交后必须 `git show --stat` 核验（曾发生提交空心事故） | 工作流程 |
| 预算耗尽提交只含一个文件（7f0db9a）| 工作流程 |
| `js-yaml` 无 default 导出，ESM 必须命名导入 | M2-2 |
| 模板字符串里的 `${{` 是插值起点，必须转义 `\${{` | M2-3 |
| 002 迁移惯例：超出 status CHECK 词表的状态用 end_reason 表达，不重建表 | M3 |
| SQLite 迁移只追加不改已发布版本 | M0-1 |

<a name="reg-13"></a>
## REG-13 · 批量 patch 脚本断言失败 = 未写盘，但后续 tsc 通过造成误判（工作流，2026-10-04 审查时发生）

**现象**：P0 修复脚本里 `assert old in s` 在第二段失败抛异常，第一段的修复**从未写盘**；随后跑 tsc 通过（因为什么都没改当然通过），误以为修复成功。直到写回归测试才发现 stream() 仍然丢 tools。
**教训**：**验证修复必须验证"行为变化"而非"过程没报错"** —— tsc 通过只说明代码合法，不说明修复存在。修 P0 这类关键问题必须立刻配一条会失败的测试（先红后绿）。
**防回归检查**：
- [ ] 用脚本批量改代码后，`grep` 确认目标改动真的在文件里（而不是只看脚本没抛错）
- [ ] 关键修复必须带回归测试，且先在未修复代码上确认测试失败（红→绿）
- [ ] Python 批量 patch 里每个 replace 都要 `assert changed`，脚本末尾打印每处修改计数

---


| 构建产物（server/public）两次混入提交 — .gitignore 模式 `server/public` 在 add -A 后才生效且首次 amend 移除后又被重新构建 + add -A 带回 | M4-3 实录：**构建产物入库要用精确路径模式（`packages/server/public/`），且添加 ignore 必须发生在 git add 之前**；amend 后要 `git ls-files \| grep` 验证真的不在索引里 |


<a name="reg-14"></a>
## REG-14 · cron OR 语义误判（终审发现）

**根因**：`domRestricted = !has(0) || !has(31) || size<31` —— DOM 取值域是 1-31，`0` 永不在集合里，`!has(0)` 恒真 → domRestricted 恒真 → `0 9 * * 1`（每周一）走 OR 分支 → 每天触发。反向用例（`0 9 1 * *` 每月1号）恰好走 AND 分支是对的，掩盖了 bug。
**教训**：**边界假设要用取值域验证** —— 写"恒真/恒假"判断前把字段的合法取值域列出来。测试要覆盖最常见的正向用例（每周一），不只反向。
**防回归检查**：[ ] cron 表达式改动必须带"每周一"正向用例。回归测试：trigger-service「REG-14 回归」。

<a name="reg-15"></a>
## REG-15 · 部分应答组漏网（终审发现，REG-04 修复不完整）

**根因**：REG-04 只处理了"取消在第 1 个工具调用前"的情形（末条是 assistant）。多工具块 [A,B,C] 中 B 执行时取消 → messages 末尾是 tool(A)，两侧 sanitize 都放行 → 落下 `assistant([A,B,C]) + tool(A)` 的部分应答组 → 续接 400。
**教训**：**修复配对结构类 bug 时，枚举所有"中断点"** —— 配对组的中断点不止一个（组前/组中/组后），每个都要有测试。回归测试 REG-15 用真实取消路径驱动 B 后取消。
**防回归检查**：[ ] 改 sanitize 逻辑时，REG-15b 的 echoAbort 测试（第一个工具里 abort）必须仍绿。回归测试：run-engine「REG-15：多工具块」。

<a name="reg-16"></a>
## REG-16 · 补丁验证不闭环（终审发现两例）

**现象**：上一轮修的"trigger fire 失败推进 next_fire_at"和"todoWritten 别名判定"，本轮终审发现实际未生效（前者补丁被后续脚本覆盖回旧文本，后者的修复逻辑本身不完整——toolMap 只含实名，别名调用时 tool 为 undefined）。
**教训**：**补丁的验证要在"最终文件状态"上做，不是在"patch 脚本输出"上做** —— 每轮修复合入后，用 grep 重新确认关键修复点仍在；修复别名类问题必须沿着"调用→查找表→纠正"完整链路推演。
**防回归检查**：[ ] 每轮修复 PR 合入后跑一遍 `grep` 清单（REG-01 stream tools / REG-05 stdin 解包 / fire 推进 / todoWritten 判定）
- 工具化：可写一个 `scripts/check-regressions.mjs` 做 grep 式哨兵（CI 可跑）

## 模块 → 高频雷区地图

| 改这里时 | 必查 |
|---|---|
| `providers/openai-compat.ts` / `anthropic.ts` | REG-01 参数对称、REG-02 重试重置、DSML 扣留边界 |
| `kernel/context-window.ts`、任何消息裁剪 | REG-03 工具组完整性 |
| `kernel/run-engine.ts` / `agent-loop.ts` 取消路径 | REG-04 checkpoint 合法性 |
| 新技能脚本 | REG-05 stdin 包装、REG-06 SDK 签名、真实子进程冒烟 |
| `kernel/graph/graph-compiler.ts` 提示词 | REG-07 三层校验 |
| 新 API 路由 | REG-08 fastify.inject 测试 |
| 任何事件/序列计数器 | REG-09 持久化播种 |
| `useRunStream` 等事件合并 | REG-12 seq 定序 |
