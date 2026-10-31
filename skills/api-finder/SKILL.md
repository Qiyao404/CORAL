---
name: api-finder
version: "1.0.0"
description: "API 优先策略——在爬网页之前，先检查目标数据源是否有公开 API。教模型：PubChem 有 PUG REST API、Wikipedia 有 API、政府数据有 data.gov。比爬网页快 10 倍且结果精确。当需要从特定网站/数据库获取结构化数据时使用。"
domain: tools
capabilities:
  - api_discovery
  - structured_data_access

input_schema:
  type: object
  required: [source, query]
  properties:
    source:
      type: string
      description: "目标数据源名称或网址（如 PubChem, Wikipedia, GitHub）"
    query:
      type: string
      description: "要查询什么数据"

output_schema:
  type: object
  properties:
    api_url:
      type: string
    method:
      type: string

execution_mode: llm_only
cost_level: low
status: stable
tags: [API, 数据获取, 效率]
---

# API 优先策略（API Finder）

你是数据获取策略师。核心原则：**在开始爬网页之前，先检查有没有更好的 API**。

## 常用 API 速查表

### 化学/生物
| 数据源 | API 入口 | 示例 |
|---|---|---|
| PubChem | `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/{name}/property/MolecularFormula, MolecularWeight/JSON` | 按名称查分子量 |
| PubChem 搜索 | `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/fastformula/{formula}/cids/JSON` | 按分子式搜 CID |
| ChEMBL | `https://www.ebi.ac.uk/chembl/api/data/activity.json?compound_pref_name={name}` | 药物活性数据 |

### 百科/知识
| 数据源 | API 入口 | 示例 |
|---|---|---|
| Wikipedia | `https://en.wikipedia.org/api/rest_v1/page/summary/{title}` | 页面摘要 |
| Wikidata | `https://www.wikidata.org/w/api.php?action=wbsearchentities&search={q}&format=json` | 实体查询 |
| DBpedia | `https://dbpedia.org/data/{entity}.json` | 结构化百科 |

### 政府/公开数据
| 数据源 | API 入口 | 示例 |
|---|---|---|
| data.gov | `https://api.data.gov/REGISTRY_OF_APIs` | 美国政府数据 |
| World Bank | `https://api.worldbank.org/v2/country/{code}/indicator/{ind}?format=json` | 经济指标 |
| Eurostat | `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{dataset}` | 欧洲统计 |

### 代码/技术
| 数据源 | API 入口 | 示例 |
|---|---|---|
| GitHub | `https://api.github.com/repos/{owner}/{repo}` | 仓库信息 |
| npm | `https://registry.npmjs.org/{package}` | 包信息 |
| arXiv | `http://export.arxiv.org/api/query?search_query=all:{q}&max_results=5` | 论文搜索 |

## 使用流程
1. 识别目标数据源
2. 查上方速查表或用 http_fetch 测试 API 端点
3. 如果 API 可用 → 用 http_fetch 调 API（返回结构化 JSON）
4. 如果无 API → 降级到 web-search / web-reader

## 关键提醒
- **结构化数据库（PubChem、Wikidata、GitHub）几乎都有 API**——先试 API 再爬网页
- API 返回 JSON 比网页 HTML 更精确、更快、不会超时
- 很多 GAIA 级别的错题就是因为模型在爬网页而不是调 API
