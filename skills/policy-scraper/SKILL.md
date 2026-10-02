---
name: policy-scraper
version: "1.1.0"
description: >-
  从 gkmlpt 类政府网站批量抓取指定年月的政策信息，输出 MD（按机构分组）+ CSV 双产物。
  支持自然语言指定具体站点（如「广东工信厅 3 月」），单站失败不影响其他站点。
domain: data-processing
capabilities:
  - web_scraping
  - data_collection
  - policy_monitoring
input_schema:
  type: object
  required: [year, month]
  properties:
    year:
      type: integer
      description: "目标年份（2000-2100）"
    month:
      type: integer
      description: "目标月份（1-12）"
    sites:
      type: array
      items:
        type: string
      description: "站点 ID 子集（如 gdii,fszj），缺省=全部 8 个站点"
output_schema:
  type: object
  properties:
    csv_path:
      type: string
      description: "CSV 文件路径（向后兼容 v1.0.0）"
    md_path:
      type: string
      description: "Markdown 汇总报告路径（按机构分组、含汇总章节）"
    count:
      type: integer
      description: "采集到的政策条数（去重后）"
    summary:
      type: object
      description: "汇总信息"
      properties:
        by_site:
          type: object
          additionalProperties: { type: integer }
        failed_sites:
          type: array
          items: { type: object }
input_keys: [year, month, sites]
default:
  sites: all
empty_when:
  - field: count
    op: eq
    value: 0
execution_mode: script
script_entry: scripts/scrape.py
script_runtime: py
script_timeout_ms: 900000
human_gate: false
estimated_duration_ms: 300000
cost_level: medium
status: stable
tags: [政策采集, 网页抓取, 政府信息, gkmlpt, 流式进度]
---

# 政策信息采集

从多个 gkmlpt 类政府网站批量抓取指定年月的政策信息，输出 **MD + CSV** 双产物。
通过 `[CORAL_PROGRESS]` 协议向平台流式上报进度（站点级 / 页码级 / 整体百分比）。

## 适用范围

当前已适配的网站均使用 **gkmlpt（公开目录平台）** 统一架构，包括：

| ID | 网站名称 | URL |
|------|---------|-----|
| `fszsj` | 佛山政数局 | `www.foshan.gov.cn/fszsj/gkmlpt/index` |
| `fszj` | 佛山住建局 | `fszj.foshan.gov.cn/gkmlpt/index` |
| `fsjtys` | 佛山交通局 | `jtys.foshan.gov.cn/gkmlpt/index` |
| `fsdr` | 佛山发改局 | `fsdr.foshan.gov.cn/gkmlpt/index` |
| `fskjj` | 佛山科技局 | `fskjj.foshan.gov.cn/gkmlpt/index` |
| `gdii` | 广东工信厅 | `gdii.gd.gov.cn/gkmlpt/index` |
| `zfsg` | 广东政数局 | `zfsg.gd.gov.cn/gkmlpt/index` |
| `zfcxjst` | 广东住建厅 | `zfcxjst.gd.gov.cn/gkmlpt/index` |

> 新增站点必须使用相同的 gkmlpt 架构。请同时更新 `reference.md` 中的 `site_aliases` 表。

## 代理友好

为避免本地 HTTP/HTTPS 代理污染政府站点，脚本默认对 `*.gov.cn` 强制直连：
- `POLICY_FORCE_DIRECT=true`（默认开启）
- `POLICY_NO_PROXY_DOMAINS=gov.cn,foshan.gov.cn,gd.gov.cn`（可在 `.env` 调整）

> 当系统打开 Clash / Surge / VPN 时，**仍然可以正常采集政府站点**。LLM API 调用走代理不受影响。

## 执行步骤

### 1. 环境准备（首次使用）

```bash
pip install requests beautifulsoup4 selenium webdriver-manager pandas openpyxl
```

同时确保已安装 **Chrome 浏览器**（Selenium 依赖）。

### 2. CLI 用法

```bash
# 采集 2026 年 3 月（全部 8 个站点）
python skills/policy-scraper/scripts/scrape.py --year 2026 --month 3

# 仅广东工信厅 + 佛山住建局
python skills/policy-scraper/scripts/scrape.py --year 2026 --month 3 --sites gdii,fszj
```

### 3. CORAL 平台调用（自然语言）

平台规划引擎（PlanningEngine）会自动从描述中提取参数：

| 用户描述 | 提取参数 |
|---------|---------|
| 「广东工信厅 3 月」 | `year=当前年, month=3, sites=["gdii"]` |
| 「广东工信厅和佛山住建局 2026 年 2 月」 | `year=2026, month=2, sites=["gdii", "fszj"]` |
| 「最近的政策」 | 默认值（最近月、全部站点）|

### 4. 输出

| 文件 | 说明 |
|------|------|
| `政策信息_<年>年<月>月_<时间戳>.csv` | 与 v1.0.0 兼容 |
| `政策信息_<年>年<月>月_<时间戳>.md` | 按机构分组 + 汇总表 + 失败站点章节 |

### 5. 进度事件（CORAL_PROGRESS 协议）

| 阶段 phase | step/total | message 示例 |
|-----------|-----------|--------------|
| `init` | — | 「开始采集 2026年3月，共 8 个站点」 |
| `scraping` | 当前/8 | 「[3/8] 佛山政数局 · 第 1 页」 |
| `scraping` | 当前/8 | 「[3/8] 佛山政数局 完成，找到 12 条」 |
| `done` | — | 「采集完成: 共 87 条」 |

## 故障排除

| 现象 | 原因 | 处理 |
|------|------|------|
| Selenium 未安装 | 缺少依赖 | `pip install selenium webdriver-manager` |
| Chrome 启动失败 | 未安装浏览器 | 安装 Chrome 浏览器 |
| 某站点 0 条数据 | 网站响应慢/结构变化 | 脚本自动跳过，并在 MD 末尾「失败站点」章节标注 |
| 全部 0 条 | 目标月份确实无数据 | 手动访问网站确认 |
| 无法访问政府网页 | 代理污染 | 检查 `.env` 中 `POLICY_FORCE_DIRECT=true` 是否开启 |

## 附加资源

- 站点别名表（自然语言 → ID 映射）见 [reference.md](reference.md)
