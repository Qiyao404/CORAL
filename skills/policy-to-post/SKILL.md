---
name: policy-to-post
version: "1.1.0"
description: >-
  将政策信息（CSV/MD 文件 / 直接粘贴的 MD 文本 / 已筛选的政策清单）通过 LLM 解读后，
  生成标准格式的 Markdown 政策快讯推文。支持流式进度反馈与三种输入互斥。
domain: text-processing
capabilities:
  - text_generation
  - content_formatting
  - policy_analysis
input_schema:
  type: object
  oneOf:
    - required: [md_content]
    - required: [md_path]
    - required: [csv_path]
  properties:
    md_content:
      type: string
      description: "直接粘贴的 MD 文本（policy-scraper 输出格式或自定义）"
    md_path:
      type: string
      description: "MD 文件路径（policy-scraper 输出 / information-filter 输出 / 用户自定义）"
    csv_path:
      type: string
      description: "CSV 文件路径（向后兼容 v1.0.0）"
    output_path:
      type: string
      description: "输出 Markdown 文件路径，缺省按 output 目录 + 时间戳"
    period_title:
      type: string
      description: "期刊标题，默认：各局办相关最新政策及科技企业动态快讯"
output_schema:
  type: object
  properties:
    md_path:
      type: string
      description: "输出 Markdown 文件路径"
    item_count:
      type: integer
      description: "处理成功的政策条数"
    failed_count:
      type: integer
      description: "处理失败被跳过的政策条数"
input_keys: [md_content, md_path, csv_path, period_title]
empty_when:
  - field: item_count
    op: eq
    value: 0
execution_mode: script
script_entry: scripts/convert.py
script_runtime: py
script_timeout_ms: 1800000
human_gate: false
estimated_duration_ms: 600000
cost_level: high
status: stable
tags: [推文生成, 政策解读, Markdown, 内容转换, 流式进度]
---

# 政策信息转推文

将政策信息逐条调用 LLM 解读，生成标准格式的 Markdown 政策快讯推文。

## 三种输入（互斥，任选一种）

| 输入字段 | 说明 | 适用场景 |
|----------|------|----------|
| `md_content` | 直接粘贴的 Markdown 文本 | 用户从 Word / 内部 wiki 复制粘贴 |
| `md_path` | Markdown 文件路径 | 上游 `policy-scraper` 或 `information-filter` 的输出 |
| `csv_path` | CSV/Excel 文件路径 | 向后兼容 v1.0.0；老用户存量数据 |

## 处理流程

1. **输入归一化** — 三种输入统一映射到 (发布日期 / 标题 / 发布部门 / URL) 四列
2. **抓取正文** — 请求每条政策 URL 提取网页正文
3. **附件处理** — 识别页面中的 PDF/DOC 附件并提取文本
4. **AI 解读** — 调用 LLM 生成 150-300 字核心内容摘要
5. **自动分类** — 根据发布部门归类（佛山要闻 / 全国要闻 / 企业锋向）
6. **生成推文** — 按模板输出带目录锚点的 Markdown 文件

## 流式进度（CORAL_PROGRESS）

| 阶段 phase | 含义 |
|-----------|------|
| `init` | 解析输入、读取文件 |
| `processing` | 处理第 N 条政策（含 step/total/percent） |
| `writing` | 生成 MD 文件 |
| `done` | 完成（含 success / failed 统计） |

## 执行步骤

### 1. 环境准备（首次使用）

```bash
pip install pandas openpyxl requests beautifulsoup4 openai readability-lxml PyMuPDF httpx
```

### 2. CLI 用法

```bash
# 用 CSV 输入
python skills/policy-to-post/scripts/convert.py "skills/policy-scraper/output/政策信息_2026年3月_*.csv" -o "skills/policy-to-post/output/推文_2026年3月.md"

# 用 MD 文件输入
python skills/policy-to-post/scripts/convert.py "skills/policy-scraper/output/政策信息_2026年3月_*.md" -o "output.md"

# 用粘贴的 MD 文本
python skills/policy-to-post/scripts/convert.py --md-text "$(Get-Content xxx.md -Raw)" -o output.md
```

### 3. 平台调用

平台规划引擎会自动从描述中识别意图：

```text
用户：「把这段政策正文转推文：xxxxx」
→ policy-to-post(md_content=xxxxx)

用户：「用刚才采集的 MD 做成推文」
→ policy-to-post(md_path=<上游 md_path>)（dataMapping 自动推断）
```

### 4. API 配置

脚本读取 `.env` / 环境变量中的 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`。
v1.1.0 默认使用：

- 平台：`https://coding.dashscope.aliyuncs.com/v1`
- 模型：`kimi-k2.5`

也兼容旧变量名：`SILICONFLOW_BASE_URL` / `SILICONFLOW_API_KEY` / `SILICONFLOW_MODEL`。

### 5. 输出格式

生成的 Markdown 包含：
- 标题与期数
- 分类目录（佛山要闻、全国要闻、企业锋向）及锚点
- 每条政策的发布部门、发布时间、核心内容、阅读原文链接

## 分类规则

| 分类 | 触发条件 |
|------|---------|
| 佛山要闻 | 发布部门含「佛山」或「foshan」 |
| 企业锋向 | 发布部门含「科技」「公司」「集团」「企业」等 |
| 全国要闻 | 以上均不匹配时的默认分类 |

## 输入文件格式

### MD 格式（policy-scraper 输出）

```markdown
## 佛山政数局（12 条）

### 关于印发《XXX》的通知
- **发布日期**：2026-03-15
- **来源**：佛山政数局
- **链接**：<https://www.foshan.gov.cn/...>
```

### CSV 格式（兼容旧版）

至少包含以下列（列名可有别名）：

| 标准列名 | 可接受别名 | 必填 |
|----------|-----------|:----:|
| 发布日期 | 日期、发布日、时间 | ❌ |
| 标题 | 题目、名称、政策名称 | ✅ |
| 发布部门 | 部门、来源、发布机构、发布网站 | ❌ |
| URL | 链接、网址、原文链接、URL链接 | ✅ |

## 附加资源

- 输出格式模板与详细说明见 [reference.md](reference.md)
