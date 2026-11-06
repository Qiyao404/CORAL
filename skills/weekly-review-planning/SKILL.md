---
name: weekly-review-planning
version: "1.0.0"
description: "周复盘与下周规划：回顾本周会话与任务、清理停滞事项、按容量排出下周重点——可配合触发器每周定时执行"
domain: productivity
capabilities: [weekly_review, planning]
input_schema:
  type: object
  properties:
    week: { type: string, description: "复盘区间（默认最近 7 天）" }
    focus: { type: string, description: "重点关注方向（可选）" }
output_schema:
  type: object
  properties:
    review: { type: string }
    nextWeekPlan: { type: string }
execution_mode: llm_only
status: stable
tags: [效率, 规划]
source: builtin
---

# 周复盘与规划

一个具体的周期任务（不是泛泛的方法论）：用平台自己的数据回顾本周、规划下周。配合触发器（cron 每周五/周一）可全自动执行并续写到同一会话。

## 数据来源（都在平台内）

- **本周做了什么**：session_search 检索本周关键词与主题；past_runs 拉取本周 run 清单与状态
- **承诺与待办**：todo_write 历史清单里未完成项；记忆中的决策与接力记录（memory_search）
- **工作区产物**：fs_list 最近修改的文件（本周交付痕迹）

## 流程

1. **回顾**：本周完成了什么（按主题聚类，不按 run 罗列）；哪些是交付、哪些是探索
2. **清 stagnation**：超过一周没有下一步动作的事项 → 逐项决定"推进 / 搁置（写明重启条件）/ 放弃"
3. **等待项**：等他人/外部的事 → 列出跟进方式与最后期限
4. **容量规划**：固定日程占掉多少 → 下周只选 2-4 个重点成果（outcome 而非任务堆），标注依赖与截止
5. **落盘**：复盘结论与下周重点写入 memory（可复查的周记录）；建议用户为周期项建触发器

## 输出形状

1. 本周成果与亮点（3-5 条）
2. 停滞与等待项处置（推进/搁置/放弃 + 理由）
3. 下周重点（≤4 个，每个带验收标准）
4. 明确不做的事（容量诚实）

## 纪律

- 建议与草案优先，未经确认不改动用户文件；容量排不满是正常的，不凑数
- 复盘基于证据（会话/文件/run 记录），不凭印象编造"本周做了 X"
