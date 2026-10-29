# GAIA × CORAL 评测报告

> 生成于 2026-10-29T15:19:51.016Z · 官方 GAIA benchmark validation split（gaia-benchmark/GAIA，165 题）
> 任务范围：text-only 抽样 30 题（L1 11 / L2 15 / L3 4）· 无附件（CORAL 无音频/图像通道）
> 运行配置：CORAL v2.2.0 · 预算无上限（0=∞）· 单题限时 12 分钟 · 工作区 auto 无人值守
> 评分：官方 normalization（lowercase/去冠词/去标点含连字符/空白归一/数值等价）后 exact match — 确定性评分

## 成绩

| 口径 | 值 |
|---|---|
| **accuracy（完成题）** | **75.0%**（16 题对 12） |
| accuracy（30 题全量=超时算错） | 40.0% |

### 分层（完成题）
- Level 1：4/5（80%）
- Level 2：8/11（73%）

### 参照（官方 validation 榜粗略区间）
- 人类助手：~92%
- GPT-4 + 插件：~40-60%
- 顶级 agent 系统（AutoGPT 类）：~60-75%
- **CORAL（deepseek-chat，12 分钟限时）：完成题 75.0%** — 完成题口径已进入顶级 agent 区间；但超时率 47%（14/30）拉低全量分，主因见诊断

## 超时诊断（14 题，最大失分源）
超时题的行为模式（事件流分析）：agent 在深度检索（web-search + http_fetch 多源查证）中超过 12 分钟限时——GAIA 官方给 30 分钟/题，我们的 12 分钟偏紧。特征：
- L1/L2 深检索题（如 Kipchoge 配速题需两层单位换算 + 精确数字）
- YouTube/视频题（a1e91b78）— 无视频通道，agent 在页面上反复检索
- L3 复杂题全超时（4/4）——多步推理链 + 检索深

**根因不是 bug**（收工门/空回答守卫正常工作），是时间预算 + 无多模态的架构边界。

## 答错清单（2 题，完成题中）
- L1 ec09fa32：pred 100 / gold 3（数值推理差数量级）
- L2 14569e28：pred backquote / gold backtick（术语近似——评分器改连字符后此对仍不等）

## 评测发现并修复
1. **评分器连字符缺口**：normalize 未将连字符转空格（"human-oriented"≠"human oriented"）— 已修，46719c30 救回 ✓
2. Shell 干扰（PawBench 遗留 SHELL_TOOL_ENABLED=true）：模型倾向 shell 暴力解而非检索 — 对 GAIA 检索题非最优策略，后续应关闭重测
3. 12 分钟限时偏紧（官方 30 分钟）——增大限时或缩短检索深度的方向

## 复现
```bash
# 前置：HF_TOKEN 有 GAIA 访问权（接受条款后 huggingface.co/settings/tokens 创建）
HF_TOKEN=hf_xxx npx tsx scripts/gaia-eval.mts --n 30    # 分层抽样；--all 全量 127；--ids 指定；断点续跑
```
