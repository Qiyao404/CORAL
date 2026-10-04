---
name: github-repo-report
version: "1.0.0"
description: "生成 GitHub 仓库报告（stars/语言/license/最近提交与发版）Markdown"
domain: tools
capabilities: []
input_schema:
  type: object
  required: ["repo"]
  properties: {"repo": {"type": "string", "description": "owner/name 或完整 GitHub URL"}}
output_schema: {"type": "object", "properties": {"md_path": {"type": "string"}, "stars": {"type": "number"}}}
execution_mode: script
script_entry: scripts/main.mjs
script_runtime: node
script_timeout_ms: 120000
status: stable
tags: ["github", "报告"]
source: builtin
---

# github-repo-report

生成 GitHub 仓库报告（stars/语言/license/最近提交与发版）Markdown。Node 零依赖脚本，进度协议（[CORAL_PROGRESS]）实时上报。

## 使用
- 对话模式：直接让 agent 调用 skill_github-repo-report
- Graph 模式：节点引用 skill: github-repo-report，输入按 schema 传
- 产物落 CORAL_OUTPUT_DIR（绑工作区时即工作区目录）

（M4-2 内置示范技能 — 展示 @coral/progress 协议与零依赖 Node 脚本范式）
