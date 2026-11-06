---
name: blocked-page-recovery
version: "1.0.0"
description: "抓取被封页面的恢复阶梯：403/429、付费墙、WAF 人机校验、反爬拦截时的逐级降级策略——先查存档副本，再找同站 API，最后换源，绝不重复硬撞同一 URL"
domain: web
capabilities: [web_recovery, archive_fallback]
input_schema:
  type: object
  required: [url]
  properties:
    url: { type: string, description: "被封锁的页面 URL" }
    reason: { type: string, description: "失败现象（403 / 429 / 人机校验 / 付费墙）" }
output_schema:
  type: object
  properties:
    content: { type: string }
    source: { type: string, description: "实际取回内容的来源（存档/API/镜像）" }
execution_mode: llm_only
status: stable
tags: [检索, 容错]
source: builtin
---

# 被封页面恢复

当 http_fetch 或 skill_web-reader 对某 URL 失败（403/429、Cloudflare 类人机校验、付费墙、反爬空白页）时，不要放弃，更不要对同一 URL 反复硬撞。按下述阶梯逐级降级，从最便宜的开始：

## 恢复阶梯

```
1. 存档副本   — Wayback Machine availability API（archive.org/wayback/available?url=…）
               命中则取最近快照；记录快照时间以提示信息可能滞后
2. archive.today — 域名轮换尝试：archive.ph → archive.md → archive.li → archive.is
3. API 优先拐点 — 同站寻找 /api/、/graphql、.json、RSS/Atom 端点：
               正文页被封时，结构化端点常常开放；用 http_fetch 直接取数据
4. 换源       — 用 skill_web-search 搜页面标题/关键句，找转载或镜像；
               学术内容优先出版社预印本页，新闻优先通讯社原始稿
5. 缓存兜底   — 搜索引擎缓存快照（cache: 前缀已不可用时跳过此级）
```

## 纪律

- 每级失败后立即下一级，同一级最多尝试 2 个变体；全阶梯走完仍失败才如实报告"不可达"
- 从存档/镜像取回的内容必须在结果里注明来源与快照时间——它是副本不是原文
- 403 与 429 语义不同：429 是限速，等待 30-60 秒重试一次原 URL 是合理的（仅一次）
- 阶梯是策略指引：若失败响应里直接给出了可用的 API 端点，可跳级
