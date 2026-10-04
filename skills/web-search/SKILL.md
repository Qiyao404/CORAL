---
name: web-search
version: "1.0.0"
description: "联网搜索（可选技能）：Tavily 或自建 SearXNG 双后端，返回标题/链接/摘要。需用户自有 key，未配置时返回配置指引"
domain: tools
capabilities: []
input_schema:
  type: object
  required: [query]
  properties:
    query: { type: string, description: 搜索词 }
    max: { type: number, description: 结果条数 1-10（默认 5） }
output_schema:
  type: object
  properties:
    results: { type: array }
    engine: { type: string }
execution_mode: script
script_entry: scripts/main.mjs
script_runtime: node
script_timeout_ms: 60000
status: stable
tags: [搜索, 联网]
source: builtin
x-planning:
  note: "需要用户配置才能用；引用本技能的 graph 应在 description 里提示先配置后端"
---

# web-search（可选技能）

**配置（二选一，写入项目根 `.env` 后重启）**：

```bash
# 方式一：Tavily（推荐 — tavily.com 免费注册，每月 1000 次额度）
CORAL_TAVILY_API_KEY=tvly-xxxxxxxx

# 方式二：自建 SearXNG（无限额，需要自己部署一个实例）
CORAL_SEARXNG_URL=http://127.0.0.1:8888
```

未配置时调用会返回明确的配置指引（绝不伪造搜索结果）。
D21 决策：搜索不进内核 — 作为可选技能，用户自有 key、自带配额。
