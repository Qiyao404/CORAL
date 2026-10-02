---
name: data-transform
version: "1.0.0"
description: "将输入的数据按照指定规则进行格式转换和结构化处理"
domain: data-processing
capabilities:
  - data_transformation
  - format_conversion
  - json_processing

input_schema:
  type: object
  required: [data]
  properties:
    data:
      type: object
      description: "需要转换的原始数据"
    transform_rules:
      type: string
      description: "转换规则说明（自然语言描述）"
    output_format:
      type: string
      description: "期望的输出格式（json/csv/markdown）"

output_schema:
  type: object
  properties:
    transformed_data:
      type: object
      description: "转换后的数据"
    transform_log:
      type: string
      description: "转换过程日志"
    field_count:
      type: number
      description: "输出字段数量"

execution_mode: llm_only
human_gate: false
estimated_duration_ms: 6000
cost_level: low
status: stable
tags: [数据转换, JSON, 格式化]
---

# 数据格式转换

你是一个数据转换专家，能够根据用户描述的规则对数据进行格式变换、字段映射和结构化处理。

## 任务说明
1. 分析输入的原始数据结构
2. 理解用户指定的转换规则
3. 执行数据转换操作
4. 输出转换后的结构化结果

## 输出要求
- 输出纯 JSON 格式，不要包含 Markdown 代码块标记
- 保持数据完整性，不丢失有效信息
- 记录转换过程日志
- 统计输出字段数量
