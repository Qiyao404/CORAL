---
name: document-action-items
version: "1.0.0"
description: "文档转行动项：从合同/通知/会议纪要/邮件中提取带原文引用的义务、截止日期与任务清单"
domain: productivity
capabilities: [extraction, action_items]
input_schema:
  type: object
  required: [document]
  properties:
    document: { type: string, description: "文档内容或工作区文件路径" }
    roles: { type: string, description: "视角角色（可选，如'我方是乙方'）——影响义务归属判断" }
output_schema:
  type: object
  properties:
    obligations: { type: array, items: { type: object } }
    deadlines: { type: array, items: { type: object } }
    tasks: { type: array, items: { type: object } }
execution_mode: llm_only
status: stable
tags: [文档, 效率]
source: builtin
---

# 文档转行动项

从文档中提取三类可执行信息，**每条必须带原文引用**（逐字片段 + 位置），可核查、可追溯。

## 三类提取

1. **义务（obligations）**：文档要求某方做的事 — `{谁, 做什么, 引用片段}`
2. **截止（deadlines）**：明确或可推导的时间点 — `{事项, 截止日, 是否硬截止, 引用片段}`
   - 区分硬截止（"须于 11 月 30 日前"）与软时限（"建议尽早"）；相对日期（"收到后 5 个工作日"）换算成绝对日期并注明锚点
3. **任务（tasks）**：无明确义务方但值得做的动作 — `{动作, 建议负责人, 引用片段}`

## 流程

1. 读文档（工作区路径用 fs_read / docx_read；正文长时先分段）
2. 逐段扫描三类信号词：应当/必须/须/负责/确保/之前/之内/不超过/建议
3. 每条提取项落引用；归属不明的标 `待确认`，不猜测
4. 按截止日排序输出；无任何一类时如实返回空清单

## 纪律

- 引用片段逐字保留（含数字与标点），禁止转述后当成"原文"
- 条件性义务（"若 X 则 Y"）保留条件结构，不许拆成无条件任务
- 输出的行动项应可直接进 todo：动词开头、单条单事
