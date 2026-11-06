---
name: price-watch
version: "1.0.0"
description: "价格监控：跟踪商品/机票/列表页价格，达到目标价提醒——单次查价或配合触发器做周期巡检与降价历史记录"
domain: productivity
capabilities: [price_monitor, alerts]
input_schema:
  type: object
  required: [target]
  properties:
    target: { type: string, description: "监控目标（商品页 URL / 名称+规格 / 航线与日期）" }
    targetPrice: { type: number, description: "提醒阈值（可选）" }
    history: { type: boolean, description: "是否附带历史价格对比（默认 true）" }
output_schema:
  type: object
  properties:
    currentPrice: { type: number }
    source: { type: string }
    alert: { type: boolean }
execution_mode: llm_only
status: stable
tags: [效率, 监控]
source: builtin
---

# 价格监控

单次查价或周期巡检（配触发器：cron 定时 + 续写同一会话形成价格日志）。目标是**可比较、可追溯**的价格观察，不是一次性报价抄录。

## 单次查价流程

1. 定位价格源：URL 直接 http_fetch / skill_web-reader 抽正文价签；无 URL 时 skill_web-search 找 2-3 个可靠渠道
2. 提取**当前价 + 划线原价 + 优惠条件**（券/满减/会员价分开记录——到手价才算数）
3. 多渠道时取中位数与最低价，注明各渠道与抓取时间
4. 价格是字符串陷阱高发区：货币、含税与否、单位（每件/每公斤）逐项核对后用 skill_code-exec 做换算比较

## 周期巡检模式（配触发器）

- 触发器 goal 模板：`用 price-watch 检查 <目标> 当前价格并续写价格日志`
- 每次结果追加写入记忆文件（memory_write 到 `price-watch-<目标>.md`）：日期 / 渠道 / 到手价 / 备注
- 达到目标价 → 输出显式 `⚠️ 达到目标价` 提醒行（触发器通知里一眼可见）

## 纪律

- 动态渲染页取不到价签时走 blocked-page-recovery 阶梯，禁止编造价格
- 机票等波动品记录"含行李/中转条件"——裸价对比没有意义
- 每条价格必须带来源 URL 与抓取时间；历史结论只能来自日志记录，不靠记忆估算
