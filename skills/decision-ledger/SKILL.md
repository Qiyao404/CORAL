---
name: decision-ledger
version: "1.0.0"
description: "决策账本：多次尝试/反复比较/方案搜索类任务用追加式账本记录每一轮的候选、标记与一致性检查，防止'多跑几轮就自信'——递归置信不等于验证通过，晋升到实际行动需要明确的门槛。适合选型对比、参数搜索、多轮打分任务。"
domain: decision
capabilities:
  - append_only_ledger
  - coherence_check
  - promotion_gate

input_schema:
  type: object
  required: [task]
  properties:
    task:
      type: string
      description: "反复尝试的任务描述（在比较什么、评优标准是什么）"
    ledger_path:
      type: string
      description: "账本路径（默认 decisions/ledger-<主题slug>.jsonl）"

output_schema:
  type: object
  properties:
    ledger_path:
      type: string
      description: "账本文件路径"
    status:
      type: string
      description: "本轮账本状态摘要（现任最优/观察名单/晋升判定）"

execution_mode: llm_only
cost_level: low
status: stable
tags: [决策, 账本, 防自信漂移]
---

# 决策账本（Decision Ledger）

你是持账人。适用场景：用户要求"多试几轮/反复比较/迭代搜索最优"。这类任务最大的坑不是找不到好答案，而是**跑的轮数多了之后把"重复出现"当成"已被验证"**——账本就是防这个的。

## 账本契约（JSONL，一行一轮）

```json
{ "round": 3, "at": "时间",
  "fresh_input": "本轮新纳入的信息（没有就写 none）",
  "candidates": [
    { "name": "方案A", "mark": "accept | watch | reject | decay | replay",
      "metric": "本轮得分/表现", "note": "一句话依据" }
  ],
  "prior_winner": "上轮 accept 的方案",
  "coherence": { "matches_prior": true, "reason": "…" },
  "promotion": "not_ready | ready(门槛名) | promoted" }
```

## 每轮流程

1. fs_read 账本（无则初始化）；没有上轮账本就没有"现任最优"
2. 记录本轮新鲜输入（fresh_input 为 none 的轮次不得晋升任何候选——没有新信息的"再确认"不产生新置信）
3. 跑本轮比较/测试，逐候选打标记：
   - `accept` 本轮最优；`watch` 有潜力但证据不足；`reject` 本轮出局（写明依据）；`decay` 曾在 watch 但连续无进展；`replay` 结果可疑需复验
4. **一致性检查**：本轮 accept 与上轮 accept 是否一致？
   - 一致 → 置信累积（在 note 里记录"连续第 N 轮"）
   - 不一致 → 降级处理：新赢家先进 watch，连续两轮胜出才可接任（防单轮噪声换王）
5. append 本轮账本行（**只追加，不改历史行**）
6. 输出摘要：**先结论后过程**（"第 5 轮：现任最优仍是 A，但领先幅度缩窄 17%；状态 watch；下一道门槛是 X"）

## 晋升门槛（默认，可按任务定制但必须显式写出）

候选从账本走向"实际执行/采纳"需同时满足：
1. 连续 ≥3 轮 accept 且跨过至少一次"输入变化"（换了数据/条件后仍胜出）
2. 通过一次 replay（同条件重跑结果可复现）
3. 风险约束明确（失败时损失什么、怎么退）
4. 涉及不可逆动作（花钱/删除/对外发布）→ 无论账本多自信，必须单独获用户确认

**递归置信 ≠ 验证通过**：账本只记录证据，不授予行动权。

## 纪律
- 摘要里禁止戏剧化（"惊艳的提升！"）——只报数字与状态
- 每轮成本意识：>10 轮时提醒用户当前投入与边际收益
- 账本与结论不一致时以账本为准，发现此前记错就在新行里勘误（历史行不删改）
