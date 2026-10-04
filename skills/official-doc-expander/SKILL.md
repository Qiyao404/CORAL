---
name: official-doc-expander
version: 1.0.0
description: 根据要点扩写生成符合 GB/T 9704-2012 标准的党政机关公文并导出 Word 文档
domain: text-processing
capabilities:
  - 公文扩写
  - 格式标准化
  - Word 文档生成
input_schema:
  type: object
  properties:
    key_points:
      type: string
      description: 用户提供的公文核心要点，可包含背景、目的、措施、要求等内容
    doc_type:
      type: string
      enum:
        - 通知
        - 报告
        - 请示
        - 函
        - 纪要
        - 决定
        - 意见
      description: 公文种类，决定格式模板和用语风格
      default: 通知
    title:
      type: string
      description: 公文标题，如未提供则由 AI 根据要点自动生成
    org_name:
      type: string
      description: 发文机关全称或规范化简称
      default: ××单位
    date:
      type: string
      description: 发文日期，格式 YYYY-MM-DD，默认当前日期
      default: today
  required:
    - key_points
output_schema:
  type: object
  properties:
    ok:
      type: boolean
      description: 执行是否成功
    doc_url:
      type: string
      description: 生成的 Word 文档下载链接
    filename:
      type: string
      description: 建议的文件名
    expanded_text:
      type: string
      description: 扩写后的完整公文正文（预览用）
  required:
    - ok
execution_mode: script  # 审查 P2 诚实化：脚本直接生成文档；要点扩写由上游 LLM 节点完成
human_gate: false
estimated_duration_ms: 45000
cost_level: low
status: experimental
tags:
  - 公文
  - GB/T 9704-2012
  - Word
  - 扩写
  - 党政机关
source: user
created_by: anonymous
creator_session_id: sess_ulWrKEtshq
script_entry: scripts/main.py
script_runtime: py
script_timeout_ms: 60000
---
# 公文扩写与生成技能

## 用途
根据用户提供的要点，扩写生成符合《党政机关公文格式》国家标准（GB/T 9704-2012）的正式文稿。

## 执行步骤
1. 解析用户输入的 key_points，识别核心要素（背景、目的、主体内容、执行要求等）
2. 根据 doc_type 选择对应的公文模板和用语规范
3. 使用规范公文语言扩写要点，保持政治性、准确性、简洁性
4. 按 GB/T 9704-2012 格式组织：份号、密级、紧急程度、发文机关标志、发文字号、签发人、标题、主送机关、正文、附件说明、发文机关署名、成文日期、印章、附注、附件
5. 生成 Word 文档并返回下载链接

## 参数说明
- key_points: 核心内容要点，支持多行文本
- doc_type: 公文种类决定格式（通知用于下行文，请示用于上行文等）
- title/org_name/date: 格式要素，支持自动推断

## 格式规范要点
- 标题：2号小标宋体字，红色分隔线
- 正文：3号仿宋体字，每面22行，每行28字
- 结构层次：一、（一）1.（1）依次使用
- 页边距：上37mm、下35mm、左28mm、右26mm
