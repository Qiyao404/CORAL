# GAIA × CORAL 评测报告

> 生成于 2026-11-09T07:46:56.171Z · 官方 GAIA benchmark validation split（gaia-benchmark/GAIA）
> 任务范围：text-only 题（无附件；附件题另测）· 抽样 1 题
> 运行配置：CORAL v2.2.0 · 预算无上限（0=∞）· 单题限时 8 分钟 · 工作区 auto 无人值守
> 评分：官方 normalization（lowercase/去冠词/去标点/空白归一/数值等价）后 exact match — 确定性评分，无 judge 模型

## 总分（accuracy）：**0.0%**（1 题，答对 0 题）

### 分层
- Level 3：0/1（0%）

### 参照（官方榜单 validation 粗略区间：人类 ~92%，GPT-4+插件 ~40-60%，顶级 agent 系统 ~60-75%）

### 答错清单（诊断用）
- L3 [5f982798] pred="0.3" / gold="0.2"

### 非完成态
（无）

### 复现
`HF_TOKEN=<token> npx tsx scripts/gaia-eval.mts --n 30`（断点续跑：data/gaia-results.json）
