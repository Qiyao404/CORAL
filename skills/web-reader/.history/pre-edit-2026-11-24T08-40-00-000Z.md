---
name: web-reader
version: "1.1.0"
description: >-
  Fetch a web page and extract its main readable content (title, body text, links) as Markdown.
  Use when the user gives a URL to read, summarize, or analyze — this filters out navigation,
  ads and scripts, unlike raw http_fetch output. Network failures return a structured,
  classified error (network_error / timeout / blocked / http_4xx / http_5xx / dns_error)
  with a retryable flag and caller guidance, so callers stop blind-retrying blocked URLs.
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
    timeout_ms:
      type: integer
      description: "Per-request timeout in ms (default 10000, max 35000; must stay below script_timeout_ms)"
    retries:
      type: integer
      description: "Internal retries with exponential backoff, applied ONLY to retryable errors (network_error/timeout/http_5xx). Default 2, max 3. 4xx is never retried."
    max_chars:
      type: integer
      description: "Truncate extracted content to this many characters (default 20000). Sets truncated=true and total_chars when cut."
    user_agent:
      type: string
      description: "Override User-Agent header (default: desktop-browser UA — an empty/default UA is a common cause of HTTP 403)"
output_schema:
  type: object
  properties:
    title:
      type: string
      description: "Page title"
    content:
      type: string
      description: "Main readable content as Markdown (truncated to max_chars)"
    links:
      type: array
      description: "Outbound links (when include_links=true)"
    truncated:
      type: boolean
      description: "true if content was cut at max_chars"
    total_chars:
      type: integer
      description: "Full extracted length before truncation"
    extraction:
      type: string
      description: "'readable' (default) or 'raw' (degraded: fetch OK but readability failed, tag-stripped text returned instead of erroring)"
    error:
      type: object
      description: "On failure only: {type, message, retryable, suggestion}. type is one of network_error | timeout | blocked | http_4xx | http_5xx | dns_error"
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

## 输入 / 输出

- 输入：`{"url": "https://...", "include_links": false, "timeout_ms": 10000, "retries": 2, "max_chars": 20000}`
- 成功：`{"title", "content", "links", "truncated", "total_chars", "extraction"}`
- 失败：`{"error": {"type", "message", "retryable", "suggestion"}}`

## 网络行为（脚本内必须实现）

1. **快速失败**：每个 HTTP 请求自带超时（默认 10s，上限 35s），必须小于脚本总超时 45s。禁止让裸请求拖到整个脚本被杀——那会产生含混的 timeout 并被误标为不可重试的脚本错误。
2. **请求头**：默认发送桌面浏览器 User-Agent、`Accept: text/html`、`Accept-Language`；可用 `user_agent` 覆盖。禁止空 UA / 默认 node UA（403 的常见诱因）。
3. **仅对可重试错误做内部重试**：`network_error` / `timeout` / `http_5xx` 按指数退避重试（默认 2 次）；**403 及其他 4xx 绝不重试**——同参数重打反爬站点只会更糟。
4. **截断**：正文按 `max_chars`（默认 20000）截断，置 `truncated: true` 并返回 `total_chars`。不要把数万字符原文直接灌给调用方（实测曾产生 86862 字符的结果，调用方被迫走证据分页）。需要全文时调用方可调大 `max_chars` 或改用 http_fetch 分页。
5. **降级而非报错**：抓取成功但正文抽取失败时，返回去标签纯文本（同样截断）并置 `extraction: "raw"`；只有连抓取都失败才返回 `error`。

## 错误分类与调用方动作

| error.type | 典型消息 | retryable | 调用方应做 |
|---|---|---|---|
| network_error | fetch failed / ECONNRESET | true | 脚本内已带退避重试；调用方最多再调 1 次，仍失败换源 |
| timeout | aborted due to timeout | true | 再调 1 次并把 `timeout_ms` 提到 20000–30000；仍失败即放弃该源 |
| blocked | HTTP 403 / 反爬验证页 | **false** | **不要重打同一 URL**；改用替代来源或 archive.org 快照 |
| http_4xx | 404 / 410 等 | false | URL 失效，换源，勿重试 |
| http_5xx | 502 / 503 | true | 隔一拍再试 1 次，仍失败换源 |
| dns_error | getaddrinfo ENOTFOUND | false | 域名不可达，换源 |

> 教训（来自实际故障）：过去所有网络错误都被统一标成「不可重试的脚本错误」，但调用方仍对同一 URL 连续 3–4 次以完全相同的参数重打 `fetch failed` / `timeout` / `403`，全部浪费。新契约：**`error.retryable` 决定调用方是否重试；`false` 一律换源，不得原样重调。**

## 调用方须知

- 同一 URL 的调用方级重试 ≤ 1 次，且必须改变参数（提高 `timeout_ms` 或换 `user_agent`）。
- 收到 `blocked` 即视为该站点不可抓：研究类任务应转向多源交叉验证（其他评测页 / 官方页），而不是死磕单页。
- 需要完整 HTML 或分页读取时请直接用 http_fetch；本技能定位是「干净的正文」。