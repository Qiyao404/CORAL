---
name: information-filter
version: "1.0.0"
description: >-
  根据公司业务画像，从多源信息（政策清单/展会信息/行业新闻/单篇文章/URL 列表）中
  筛出与公司业务相关的条目，保留原结构并附筛选理由（≤30 字）。
domain: information-processing
capabilities:
  - content_filtering
  - relevance_scoring
  - structured_extraction
input_schema:
  type: object
  oneOf:
    - required: [md_content]
    - required: [md_path]
    - required: [csv_path]
    - required: [urls]
    - required: [text]
  properties:
    md_content: { type: string, description: "粘贴的 Markdown 文本" }
    md_path: { type: string, description: "Markdown 文件路径（上游 policy-scraper 产物）" }
    csv_path: { type: string, description: "CSV 文件路径" }
    urls:
      type: array
      items: { type: string }
      description: "URL 列表（脚本会抓取标题与首段，节约 token）"
    text: { type: string, description: "单篇文章正文" }
    dry_run:
      type: boolean
      default: false
      description: "试运行模式：仅评估前 5 条且不写文件"
    output_path: { type: string, description: "输出 MD 路径（可选）" }
output_schema:
  type: object
  properties:
    md_path: { type: string }
    csv_path: { type: string }
    kept_count: { type: integer }
    excluded_count: { type: integer }
    summary_by_topic: { type: object }
input_keys: [md_content, md_path, csv_path, urls, text, dry_run]
empty_when:
  - field: kept_count
    op: eq
    value: 0
consumes_company_profile: true
execution_mode: script
script_entry: scripts/normalize.py
script_runtime: py
script_timeout_ms: 600000
human_gate: false
estimated_duration_ms: 180000
cost_level: high
status: stable
tags: [信息筛选, 内容过滤, 公司画像驱动, 政策筛选]
---

# 多源信息筛选 Skill

根据 **公司业务画像**（在「设置 → 公司业务画像」配置），从多源异构信息中筛出与
公司核心业务相关的条目，保留原结构并附简短的筛选理由。

## 适用场景

| 场景 | 输入字段 |
|------|---------|
| 上游 `policy-scraper` 输出的 MD/CSV → 筛选业务相关 | `md_path` 或 `csv_path` |
| 用户从其他系统粘贴一段政策清单 | `md_content` |
| 用户提供一组新闻链接 | `urls` |
| 单篇文章的相关性评估 | `text` |

## 执行流程（script 模式，公司画像由平台自动注入到 stdin context）

```
scripts/normalize.py 一气呵成：
  1) 把多源输入归一化为 FilterableItem[]
     - md/csv → 解析标题/日期/部门/URL
     - urls → 抓取标题 + 首段（不抓全文，节约 token）
     - text → 单条文章包装
  2) 分批 ≤ 20 条调用 LLM（dashscope coding · kimi-k2.5）评估保留/剔除
     - 失败重试 ≤ 3 次（指数退避 2s/4s/8s）
     - 决策附 ≤30 字理由
  3) 把决策合并回原结构，写出 MD + CSV
```

## 输出 MD 模板

```markdown
# 信息筛选结果

> 输入 N 条 · 保留 K 条 · 剔除 N-K 条 · 公司画像 vX
> 处理时间：YYYY-MM-DD HH:MM:SS

## 筛选汇总
| 关键关注领域 | 命中条数 |
|-------------|---------|
| 中试平台 | 5 |
| ... | ... |

## 保留条目
### 机构 1（n 条）
#### 标题
- **发布日期**：YYYY-MM-DD
- **来源**：机构
- **链接**：<url>
- **筛选理由**：≤30 字

## 剔除条目（折叠展示）
<details><summary>共 M 条</summary>
| 标题 | 来源 | 剔除理由 |
| ... | ... | ... |
</details>
```

同时输出 CSV：原始字段 + `keep` (boolean) + `reason` (string)。

## 公司画像注入

平台会自动把当前公司画像 JSON 注入到 LLM prompt（v1.1.0）。
任务级也可在 `constraints.companyProfileOverride` 临时覆盖：

```json
{
  "goal": "筛出与机器人相关的政策",
  "constraints": {
    "companyProfileOverride": {
      "focusKeywords": ["机器人", "工业自动化"],
      "excludeKeywords": []
    }
  }
}
```

## 大量输入分批

- 每批 ≤ 20 条（实际由 normalize.py 控制）
- 失败重试 ≤ 3 次（指数退避：2s / 4s / 8s）
- `dry_run: true` 仅评估前 5 条且不写文件

## 优雅短路

当本 Skill 输出 `kept_count = 0`（即没有任何条目被保留），下游 Skill（如 policy-to-post）
将被平台自动 `cancelled`（不算失败）。

## 附加资源

- LLM 评估 prompt 模板与历史最佳实践见 [reference.md](reference.md)
