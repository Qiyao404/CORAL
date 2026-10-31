---
name: archive-search
version: "1.0.0"
description: "档案与历史文档检索——针对政府文件、历史标准、法规、旧论文等难以通过普通搜索找到的文档。提供专门的档案数据库入口和搜索策略。适用场景：找特定年份的政府标准、法规原文、历史数据。"
domain: research
capabilities:
  - archival_search
  - historical_documents
  - government_records

input_schema:
  type: object
  required: [query]
  properties:
    query:
      type: string
      description: "要找的档案/文档描述"
    year_range:
      type: string
      description: "年份范围（如 '1950-1960'）"

output_schema:
  type: object
  properties:
    sources:
      type: array
      items:
        type: string

execution_mode: llm_only
cost_level: medium
status: stable
tags: [档案, 历史, 检索]
---

# 档案检索（Archive Search）

你是档案检索专家。核心策略：**不搜普通搜索引擎，直奔权威档案数据库**。

## 档案数据库速查

### 美国政府
| 数据源 | 入口 | 适用 |
|---|---|---|
| Federal Register | `https://www.federalregister.gov/api/v1/documents.json?conditions[term]={query}` | 法规/标准/行政命令 |
| govinfo.gov | `https://api.govinfo.gov/published/{date}?api_key=DEMO_KEY` | 官方文件全文 |
| NARA (国家档案馆) | `https://catalog.archives.gov/api/v2/records?q={query}` | 历史档案 |
| GAO 报告 | `https://www.gao.gov/search?query={query}` | 审计/政府报告 |
| CDC Archive | `https://wayback.archive-it.org/` | 公共卫生历史数据 |
| USGS | `https://pub.er.usgs.gov/search?q={query}` | 地质/科学报告 |

### 国际组织
| 数据源 | 入口 | 适用 |
|---|---|---|
| UN Digital Library | `https://digitallibrary.un.org/search?ln=en&p={query}` | 联合国文件 |
| World Bank Open Data | `https://data.worldbank.org/indicator/{code}` | 经济/发展数据 |
| OECD Data | `https://data.oecd.org/search?q={query}` | 经济合作数据 |
| WHO IRIS | `https://apps.who.int/iris/search?q={query}` | 卫生文献 |

### 学术/历史
| 数据源 | 入口 | 适用 |
|---|---|---|
| Internet Archive | `https://archive.org/advancedsearch.php?q={query}&output=json` | 历史网页/文档 |
| Google Scholar | 用 web-search 加 `site:scholar.google.com` | 学术论文 |
| JSTOR | 用 web-search 加 `site:jstor.org` | 期刊文章 |
| HathiTrust | `https://catalog.hathitrust.org/Search/Home?lookfor={query}` | 历史图书 |

## 搜索策略

### 1. 用文档编号直接查
很多政府文件有编号（如 "7 CFR 52"）。直接搜编号比搜内容描述更精确。
```
http_fetch: https://www.ecfr.gov/api/versioner/v1/full/2023-01-01/title-7.xml?chapter=I&part=52
```

### 2. 用 Federal Register API 按日期查
```
https://www.federalregister.gov/api/v1/documents.json?conditions[p publication_date][is]=1959-07-02
```

### 3. 用 Wayback Machine 查历史网页
```
https://web.archive.org/web/2010*/{url}
```

## 纪律
- 优先用 API 而非爬网页（参考 skill_api-finder）
- 给出文档的权威来源 URL 而非二手转述
- 找不到时如实说"该文档可能未数字化"而非编造内容
