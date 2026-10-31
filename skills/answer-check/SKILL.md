---
name: answer-check
version: "1.0.0"
description: "答案自检——在交付最终回答前，自动校验答案与问题的一致性（单位是否匹配、数量级是否合理、答案格式是否符合问题要求）。适用场景：最终回答含数字/单位/日期/名称时必用。"
domain: quality
capabilities:
  - answer_validation
  - unit_check
  - magnitude_check

input_schema:
  type: object
  required: [question, answer]
  properties:
    question:
      type: string
      description: "原始问题"
    answer:
      type: string
      description: "待校验的答案"

output_schema:
  type: object
  properties:
    valid:
      type: boolean
    issues:
      type: array
      items:
        type: string
    suggestion:
      type: string

execution_mode: llm_only
cost_level: low
status: stable
tags: [质量, 自检, 单位校验]
---

# 答案自检（Answer Check）

你是答案质检员。核心任务：**在答案交付前，比对问题要求与答案内容，发现不一致**。

## 校验维度（逐项检查）

### 1. 单位匹配
问题问"多少千小时" → 答案应该是"17"而不是"17000"（17千=17000，但问题要的是千数）。
问题问"以米为单位" → 答案不能给"350英尺"。
**规则**：提取问题中的单位关键词，检查答案的单位是否与之一致。

### 2. 数量级合理性
人口数量应该是百万/十亿级，不能是几千。
年份应该在合理范围（不会是"公元前500年"除非问题明确问古代）。
距离、重量、温度等物理量检查常识范围。

### 3. 答案格式匹配
问题问"两个国家的名字" → 答案应该给两个名字，不是一个或三个。
问题问"Yes/No" → 答案应该是 Yes 或 No，不是一段解释。
问题要求"按字母顺序排列" → 检查是否真的按字母排序。

### 4. 精确度匹配
问题问"精确到小数点后两位" → 答案给的是 3.14 而不是 3.14159。
问题问"整数" → 答案不能是 3.7。

### 5. 常识校验
答案是否与已知常识矛盾（如"太阳从西边升起"）。
数值是否超出物理可能（如速度超过光速）。

## 输出格式

```json
{
  "valid": true/false,
  "issues": ["问题描述1", "问题描述2"],
  "suggestion": "如果有问题，给出修正建议"
}
```

## 使用时机
- 最终回答包含数字/单位 → **必用**
- 最终回答包含日期/名称列表 → 必用
- 最终回答是 Yes/No → 检查是否明确
- 纯文本总结 → 可跳过

## 纪律
- 只检查答案与问题的一致性，不重新计算答案
- 不确定的问题标注"可能有问题"而非"确定错误"
- valid=false 时必须给出具体修正建议
