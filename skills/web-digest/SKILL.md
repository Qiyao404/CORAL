---
name: web-digest
version: "1.0.0"
description: "抓取一个或多个网页正文并合并生成 Markdown 摘要文件（适合批量阅读/存档）"
domain: tools
capabilities: []
input_schema:
  type: object
  required: ["urls"]
  properties: {"urls": {"type": "array", "description": "要抓取的 URL 列表（http/https）"}}
output_schema: {"type": "object", "properties": {"md_path": {"type": "string"}, "pages_ok": {"type": "number"}, "pages_failed": {"type": "number"}}}
execution_mode: script
script_entry: scripts/main.mjs
script_runtime: node
script_timeout_ms: 120000
status: stable
tags: ["网页", "摘要"]
source: builtin
---

# web-digest

抓取一个或多个网页正文并合并生成 Markdown 摘要文件（适合批量阅读/存档）。Node 零依赖脚本，进度协议（[CORAL_PROGRESS]）实时上报。

## 使用
- 对话模式：直接让 agent 调用 skill_web-digest
- Graph 模式：节点引用 skill: web-digest，输入按 schema 传
- 产物落 CORAL_OUTPUT_DIR（绑工作区时即工作区目录）

（M4-2 内置示范技能 — 展示 @coral/progress 协议与零依赖 Node 脚本范式）
