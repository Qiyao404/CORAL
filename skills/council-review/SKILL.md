---
name: council-review
version: "1.0.0"
description: "多方议事：为一个存在多条可行路径的模糊决策召集四个独立视角（架构师/怀疑者/实干家/风险家），外部视角用 agent_spawn 开独立上下文（反锚定），分歧交 dual_review 仲裁，输出决议+异议存档。适合'要不要上线/方案 A 还是 B/砍不砍范围'类取舍。"
domain: decision
capabilities:
  - multi_perspective_decision
  - dissent_recording
  - anti_anchoring

input_schema:
  type: object
  required: [question]
  properties:
    question:
      type: string
      description: "要裁决的问题（一句话，含关键约束）"
    context:
      type: string
      description: "决策相关的必要背景（数据/文件路径/前情），保持精简"
    options:
      type: array
      items:
        type: string
      description: "候选选项（可选——没有就由议事过程生成）"

output_schema:
  type: object
  properties:
    decision:
      type: string
      description: "建议决议与理由"
    dissent:
      type: string
      description: "保留异议（哪个视角、反对什么、什么条件下应翻案）"

execution_mode: llm_only
cost_level: medium
status: stable
tags: [决策, 多视角, 会审]
---

# 多方议事（Council Review）

你是议事主持人。本技能用于**模糊决策**——多条路径都 credible、没有明显赢家时才启用；事实性问题直接回答，验证对错用 dual_review，不用议事。

## 四个视角

| 视角 | 透镜 |
|---|---|
| 架构师 | 正确性、可维护性、长期影响 |
| 怀疑者 | 挑战前提：这个问题本身成立吗？有没有更简单的做法？ |
| 实干家 | 交付速度、用户影响、运营现实 |
| 风险家 | 边界情况、下行风险、失败模式与不可逆性 |

## 工作流

### 1. 提炼真问题
把决策压缩成一个明确的问题：在决定什么、约束是什么、什么算好结果。问题本身模糊时先向用户要一句澄清。

### 2. 备料（够用就好）
只收集与该决策直接相关的材料（数据、文件片段、指标）。背景过多会稀释观点差异。

### 3. 独立评审（反锚定关键）
**三个外部视角（怀疑者/实干家/风险家）各自通过 agent_spawn 派独立子代理**——每个只拿到"问题 + 精简背景 + 自己的视角指令"，**看不到主对话历史和其他视角的意见**。这是防止互相锚定、得到真实分歧的机制。视角指令模板：
```
goal: 你是"<视角名>"，用以下透镜分析这个决策：<透镜描述>。
问题：<question>
背景：<context>
输出：立场（支持哪个选项或提出新选项）+ 三条最强理由 + 一条你最担心的点。
```
架构师视角由主循环自己担任（它有最全的上下文）。

### 4. 汇总裁决
四份意见齐后：
- 一致 → 直接出决议
- 分歧 → 找出分歧的**事实根源**（是前提不同还是权衡不同）：前提不同就去验证前提（该查数据的查数据）；权衡不同 → 用 dual_review 仲裁，focus 写清楚两方论点
- 仲裁仍无共识 → 不强行裁决，输出"建议 + 保留异议 + 触发翻案的条件"

### 5. 存档（fs_write）
决议写入工作区 `decisions/<日期>-<主题slug>.md`：问题、选项、四视角立场摘要、决议、异议、翻案条件。**异议是资产**——翻案条件写清楚，未来条件满足时该翻就翻。

## 纪律
- 每个视角限 3 条理由：逼观点提纯，防止话多者胜
- 主持人不预设立场：裁决前不得在子代理指令里透露倾向
- 不可逆操作（删除数据/对外发布/花钱）无论议事结果如何都要单独向用户确认
