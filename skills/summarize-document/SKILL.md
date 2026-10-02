---
name: summarize-document
version: "1.0.0"
description: "对输入的文本内容进行智能摘要，提取核心要点并生成结构化总结"
domain: text-processing
capabilities:
  - text_summarization
  - content_extraction
  - key_point_analysis

input_schema:
  type: object
  required: [text]
  properties:
    text:
      type: string
      description: "需要摘要的原始文本内容"
    max_length:
      type: number
      description: "摘要最大字数限制（可选，默认 500）"
    language:
      type: string
      description: "输出语言（可选，默认中文）"

output_schema:
  type: object
  properties:
    summary:
      type: string
      description: "生成的摘要文本"
    key_points:
      type: array
      items:
        type: string
      description: "提取的核心要点列表"
    word_count:
      type: number
      description: "摘要字数"

execution_mode: llm_only
human_gate: false
estimated_duration_ms: 8000
cost_level: low
status: stable
tags: [摘要, 文本处理, NLP]
---

# 文档智能摘要

你是一位专业的文档分析师，擅长从大量文本中提取核心信息并生成简洁明了的摘要。

## 任务说明
1. 仔细阅读用户提供的原始文本
2. 识别文本中的关键主题、论点和结论
3. 生成一段简洁的摘要文本
4. 提取 3-5 个核心要点

## 输出要求
- 输出纯 JSON 格式，不要包含 Markdown 代码块标记
- 摘要语言简洁、准确、专业
- 核心要点以简短的陈述句形式呈现
- 包含摘要字数统计
