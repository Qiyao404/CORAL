---
name: arxiv-daily
version: "1.0.0"
description: "拉取 arXiv 指定分类最新论文，生成每日速览 Markdown（标题/作者/摘要）"
domain: tools
capabilities: []
input_schema:
  type: object

  properties: {"category": {"type": "string", "description": "arXiv 分类（默认 cs.AI）"}, "max": {"type": "number", "description": "篇数 1-50（默认 10）"}}
output_schema: {"type": "object", "properties": {"md_path": {"type": "string"}, "count": {"type": "number"}}}
execution_mode: script
script_entry: scripts/main.mjs
script_runtime: node
script_timeout_ms: 120000
status: stable
tags: ["arxiv", "论文"]
source: builtin
---

# arxiv-daily

拉取 arXiv 指定分类最新论文，生成每日速览 Markdown（标题/作者/摘要）。Node 零依赖脚本，进度协议（[CORAL_PROGRESS]）实时上报。

## 使用
- 对话模式：直接让 agent 调用 skill_arxiv-daily
- Graph 模式：节点引用 skill: arxiv-daily，输入按 schema 传
- 产物落 CORAL_OUTPUT_DIR（绑工作区时即工作区目录）

（M4-2 内置示范技能 — 展示 @coral/progress 协议与零依赖 Node 脚本范式）
