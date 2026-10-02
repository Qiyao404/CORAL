---
name: official-document-generator
version: 1.0.0
description: 根据用户提供的要点，AI 辅助扩写生成符合党政机关公文格式（GB/T 9704-2012）的正式文稿，并输出为 Word 文档
domain: text-processing
capabilities:
  - document-generation
  - format-conversion
  - text-expansion
input_schema:
  type: object
  properties:
    title:
      type: string
      description: 公文标题
    document_type:
      type: string
      description: 公文种类：通知、报告、请示、批复、函、纪要等
      enum:
        - 通知
        - 报告
        - 请示
        - 批复
        - 函
        - 纪要
        - 决定
        - 意见
    main_body:
      type: string
      description: 正文要点或草稿内容，AI 将据此扩写优化为正式公文语言
    addressee:
      type: string
      description: 主送机关（可选）
    issuer:
      type: string
      description: 发文机关署名
    date:
      type: string
      description: 成文日期，格式YYYY-MM-DD，默认今日
    attachment_list:
      type: array
      description: 附件说明列表（可选）
      items:
        type: string
    copy_to:
      type: array
      description: 抄送机关列表（可选）
      items:
        type: string
    urgency_level:
      type: string
      description: 紧急程度：特急、加急（可选）
      enum:
        - 特急
        - 加急
        - ''
  required:
    - title
    - document_type
    - main_body
    - issuer
output_schema:
  type: object
  properties:
    document_url:
      type: string
      description: 生成的Word文档下载链接
    preview_text:
      type: string
      description: 公文预览文本（前500字）
    format_check:
      type: object
      description: 格式校验结果
      properties:
        page_setup:
          type: boolean
        font_standard:
          type: boolean
        structure_complete:
          type: boolean
execution_mode: hybrid
human_gate: false
estimated_duration_ms: 20000
cost_level: low
status: experimental
tags:
  - 公文
  - 党政机关
  - Word
  - 文档生成
  - GB/T-9704
source: user
created_by: anonymous
creator_session_id: sess_zVd5EoXk7o
script_entry: scripts/main.py
script_runtime: py
script_timeout_ms: 60000
---
# 党政机关公文扩写助手

## 任务
根据用户提供的要点，扩写优化为符合 GB/T 9704-2012 标准的正式公文正文。

## 执行步骤
1. 分析 document_type，确定公文语气和结构
2. 将 main_body 的要点扩展为完整、规范的公文段落
3. 使用规范的公文用语（"现将有关事宜通知如下"、"特此请示"等）
4. 保持段落层次清晰，逻辑严密

## 输出要求
- 仅输出扩写后的正文内容
- 使用标准公文格式语言
- 适当分段，用换行符分隔

## 参数说明
- title: 公文标题
- document_type: 决定公文结构和用语风格
- main_body: 用户提供的要点或草稿
- addressee: 如有则用于确定行文方向
