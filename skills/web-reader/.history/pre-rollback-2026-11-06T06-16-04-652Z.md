---
name: web-reader
version: "1.0.0"
description: >-
  Fetch a web page and extract its main readable content (title, body text, links) as Markdown.
  Use when the user gives a URL to read, summarize, or analyze — this filters out navigation,
  ads and scripts, unlike raw http_fetch output.
domain: information-processing
capabilities:
  - web_scraping
  - content_extraction
  - readability
input_schema:
  type: object
  required: [url]
  properties:
    url:
      type: string
      description: "Absolute http(s) URL of the page to read"
    include_links:
      type: boolean
      description: "Include extracted outbound links in output (default false)"
output_schema:
  type: object
  properties:
    title:
      type: string
      description: "Page title"
    content:
      type: string
      description: "Main readable content as Markdown"
    links:
      type: array
      description: "Outbound links (when include_links=true)"
execution_mode: script
script_entry: scripts/main.mjs
script_runtime: node
script_timeout_ms: 45000
human_gate: false
estimated_duration_ms: 8000
cost_level: low
status: stable
tags: [web, reader, readability, extraction]
source: user
---

# web-reader — 网页正文阅读器

抓取指定网页并抽取「正文」——过滤导航/广告/脚本，输出 Markdown 格式的标题、正文与可选外链。
输入 `{"url": "https://...", "include_links": false}`，输出 `{"title", "content", "links", "length"}`。
失败时返回 `{"error": "..."}`。
