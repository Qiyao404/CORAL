---
name: grounded-citations
version: "1.0.0"
description: "引用落地：给答案与报告的每条关键论断配上可验证来源（URL + 原文引用片段 + 置信分级），与 deep-research 衔接使用"
domain: research
capabilities: [citations, grounding]
input_schema:
  type: object
  required: [topic]
  properties:
    topic: { type: string, description: "需要落地引用的主题或既有草稿" }
    draft: { type: string, description: "待补引用的草稿文本（可选）" }
output_schema:
  type: object
  properties:
    grounded: { type: string, description: "带引用标注的最终文本" }
    unverifiable: { type: string, description: "无法落地引用的论断清单" }
execution_mode: llm_only
status: stable
tags: [检索, 质量]
source: builtin
---

# 引用落地

答案里每一条**关键论断**（数字、日期、事实性陈述、引语）都必须落到可验证的来源上。这是产出可信报告的底线纪律。

## 落地格式

每个论断后附引用标记，文末列来源表：

```
……正文中含有 2023 年全球装机量 1.2 TW [1]。

[1] 来源标题 — URL（访问于 YYYY-MM-DD）
    引用片段："……原文中支撑该论断的逐字片段……"
```

## 置信分级（来源表每条标注）

- **A 直接来源**：原始发布方 / 官方数据 / 论文原文
- **B 权威二手**：知名媒体转述、行业数据库
- **C 弱来源**：论坛、博客、聚合站 — 仅在无 A/B 时使用且必须标注
- **未落地**：找不到来源的论断单独列入 unverifiable 清单，绝不伪装成已验证

## 工作流

1. 有草稿：逐句拆出关键论断 → 每条用 skill_web-search / http_fetch 定位来源 → 逐字摘取支撑片段
2. 无草稿：先按 deep-research 流程检索，边写边落地
3. 冲突处理：两个来源矛盾时都列出，说明各自时效与权威性，不擅自裁决
4. 引用片段必须是**逐字**的（保留原文拼写与大小写），不是转述

## 红线

- 不给整段话挂一个笼统引用——引用落到论断级
- 不引用自己无法再次访问验证的 URL（死链即失败，走 blocked-page-recovery 或换源）
- 数字类论断必须给到与来源相同的精度，禁止四舍五入后引用
