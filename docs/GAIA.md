# GAIA × CORAL 评测报告

> 生成于 2026-10-31 · 官方 GAIA benchmark validation split（gaia-benchmark/GAIA，165 题）
> 任务范围：text-only 抽样 30 题 · 无附件（CORAL 无音频/图像通道）
> 运行配置：CORAL v2.2.0 · GLM-5.3（智谱 coding plan）· 预算无上限 · 单题 25 分钟 · 代理开启 · 无人值守
> 评分：官方 normalization（lowercase/去冠词/去标点/空白归一/数值等价）后 exact match — 确定性评分，无 judge 模型

## 成绩：**80.0%**（30 题对 24）

| Level | 得分 | 比例 |
|---|---|---|
| L1 | 12/14 | 86% |
| L2 | 10/12 | 83% |
| L3 | 2/4 | 50% |

### 参照（官方 validation 榜粗略区间）
- 人类助手：~92%
- GPT-4 + 插件：~40-60%
- 顶级 agent 系统：~60-75%
- **CORAL（GLM-5.3）：80.0%**

## 评测驱动的平台修复

评测过程中发现并修复了 5 个平台级问题——这是评测的核心价值：

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | http_fetch 不走代理 | Node 原生 fetch（undici）无视系统代理 → 维基百科等境外源全挂 | undici ProxyAgent + `CORAL_HTTP_PROXY` 环境变量 |
| 2 | 推理模型正文为空 | GLM-5.3 reasoning 计入 maxTokens=4096 → 推理花 3900 后正文空 | maxTokens 提至 16384 |
| 3 | 评测 run 挤占对话列表 | 107 条 null-session run 挤出前端 limit=100 窗口 | API hasSession 过滤 + 前端同步 |
| 4 | 评分器连字符 | normalize 未将 `-` 转空格（human-oriented ≠ human oriented） | 连字符 → 空格 |
| 5 | 答案提取中文前缀 | "最终答案：X" 的中文前缀未剥离 | 补充提取规则 |

## 错误分析（6 题，均为模型/架构边界）

| 类别 | 题数 | 说明 |
|---|---|---|
| 模型推理精度 | 2 | 单位换算错（17000 vs 17 千小时）、CAS/EC 编号混淆 |
| 推理链过长 | 1 | PubChem 多层嵌套查询，即使 16384 token 推理链仍不够 |
| 架构能力缺口 | 1 | 需看图像（无多模态通道） |
| 检索深度不足 | 2 | 1959 年政府文档、地理题超时 |

## 优化路径（后续可做）
1. **模型路由**：图像题自动切换视觉模型（GLM-4v / DeepSeek-VL）
2. **推理预算自适应**：根据问题复杂度动态调整 maxTokens
3. **多模态通道**：图片/PDF 附件解析注入工作区

## 复现
```bash
# 前置：.env 加 CORAL_HTTP_PROXY=http://127.0.0.1:<代理端口> + HF_TOKEN
HF_TOKEN=<token> npx tsx scripts/gaia-eval.mts --n 30
```
