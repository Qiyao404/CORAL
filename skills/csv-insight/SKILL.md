---
name: csv-insight
version: "1.0.0"
description: "CSV 数据画像：行列/类型推断/数值范围/缺失值统计，生成 Markdown 报告"
domain: tools
capabilities: []
input_schema:
  type: object
  required: ["path"]
  properties: {"path": {"type": "string", "description": "CSV 文件路径（相对工作区或绝对）"}}
output_schema: {"type": "object", "properties": {"md_path": {"type": "string"}, "rows": {"type": "number"}, "columns": {"type": "number"}}}
execution_mode: script
script_entry: scripts/main.mjs
script_runtime: node
script_timeout_ms: 120000
status: stable
tags: ["csv", "数据"]
source: builtin
---

# csv-insight

CSV 数据画像：行列/类型推断/数值范围/缺失值统计，生成 Markdown 报告。Node 零依赖脚本，进度协议（[CORAL_PROGRESS]）实时上报。

## 使用
- 对话模式：直接让 agent 调用 skill_csv-insight
- Graph 模式：节点引用 skill: csv-insight，输入按 schema 传
- 产物落 CORAL_OUTPUT_DIR（绑工作区时即工作区目录）

（M4-2 内置示范技能 — 展示 @coral/progress 协议与零依赖 Node 脚本范式）
