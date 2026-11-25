---
name: web-reader
version: "1.2.0"
description: >-
  Fetch a web page with a desktop-browser client and extract its main readable content as Markdown
  (title, body with headings/lists, optional links). http_fetch already returns readable text + links
  for most pages — use web-reader when a site rejects the default client (http_fetch got 403) or when
  you specifically need Markdown with inline formatting. Failures come back as one classified line
  ([network_error] / [timeout] / [blocked] / [http_4xx] / [http_5xx] / [dns_error] …), so callers stop
  blind-retrying blocked URLs.
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
      description: "Extracted content as Markdown (truncated to max_chars)"
    truncated:
      type: boolean
      description: "true if content was cut at max_chars"
    total_chars:
      type: integer
      description: "Full extracted length before truncation"
    extraction:
      type: string
      description: "'readable' (a main-content container was identified) or 'raw' (degraded: fetch OK but no container matched — tag-stripped text returned instead of erroring)"
    links:
      type: array
      description: "Outbound links (when include_links=true)"
    error:
      type: string
      description: "On failure the WHOLE result is just {error}: one line '[type] message — what to do next'. type is one of network_error | timeout | blocked | http_4xx | http_5xx | dns_error | bad_url | bad_input | extract_error"
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

## 什么时候用

`http_fetch` 默认已经把网页转成可读正文（`text` + `links` + `meta`），多数页面直接用它即可，不必再走本技能。本技能用于两种情况：

1. **站点拒绝了默认客户端**：`http_fetch` 拿到 403，换桌面浏览器 UA 可能就能过；
2. **需要 Markdown**：保留标题层级、粗体 / 斜体的版式（`http_fetch` 给的是纯文本）。

## 输入 / 输出

- 输入：`{"url": "https://...", "include_links": false, "timeout_ms": 10000, "retries": 2, "max_chars": 20000, "user_agent": "..."}`
- 成功：`{"title", "content", "truncated", "total_chars", "extraction", "links"?}`
- 失败：`{"error": "[type] message — suggestion"}` —— 整个返回值只有 `error` 一个键（技能执行器据此判定为逻辑失败，界面显示为失败的工具卡）

## 网络行为（脚本实现）

1. **快速失败**：每个 HTTP 请求自带超时（默认 10s，上限 35s），必须小于脚本总超时 45s。不让裸请求拖到整个脚本被杀——那会产生含混的 timeout 并被误标为不可重试的脚本错误。
2. **请求头**：默认发送桌面浏览器 User-Agent、`Accept: text/html`、`Accept-Language`；可用 `user_agent` 覆盖。不用空 UA / 默认 node UA（403 的常见诱因）。
3. **仅对可重试错误做内部重试**：`network_error` / `timeout` / `http_5xx` 按指数退避重试（默认 2 次；装不进 45s 总超时就提前停止）；**403 及其他 4xx 绝不重试**——同参数重打反爬站点只会更糟。
4. **截断**：正文按 `max_chars`（默认 20000）截断，置 `truncated: true` 并返回 `total_chars`。不要把数万字符原文直接灌给调用方（实测曾产生 86862 字符的结果，调用方被迫走证据分页）。需要全文时调用方可调大 `max_chars`，或改用 `http_fetch` + `evidence_read`。
5. **降级而非报错**：抓取成功但没识别出正文容器时，返回去标签纯文本（同样截断）并置 `extraction: "raw"`；只有连抓取都失败才返回 `error`。

## 失败说明与调用方动作

`error` 是一行字符串：`[类型] 发生了什么 — 接下来怎么办`。

| 类型 | retryable | 调用方应做 |
|---|---|---|
| `network_error` | true | 脚本内已带退避重试；调用方最多再调 1 次，仍失败换源 |
| `timeout` | true | 再调 1 次并把 `timeout_ms` 提到 20000–30000；仍失败即放弃该源 |
| `blocked` | **false** | **不要重打同一 URL**；改用替代来源或 archive.org 快照 |
| `http_4xx` | false | URL 失效 / 被限流，换源，勿重试 |
| `http_5xx` | true | 隔一拍再试 1 次，仍失败换源 |
| `dns_error` | false | 域名不可达，换源 |

> 教训（来自实际故障）：过去所有网络错误都被统一标成「不可重试的脚本错误」（就是一句 `fetch failed`），调用方仍对同一 URL 连续 3–4 次以完全相同的参数重打，全部浪费。
> 这一版之前，本说明书写着"分类错误 + 重试 + 超时 + 截断"，脚本却一直是最初的简版——说明与实现脱节，模型拿到的始终是裸错误字符串。

## 调用方须知

- 同一 URL 的调用方级重试 ≤ 1 次，且必须改变参数（提高 `timeout_ms` 或换 `user_agent`）。
- 收到 `blocked` 即视为该站点不可抓：研究类任务应转向多源交叉验证（其他评测页 / 官方页），而不是死磕单页。
- 需要完整 HTML 或分页读取时请直接用 `http_fetch`（必要时传 `raw: true`）；本技能定位是「干净的 Markdown 正文」。
