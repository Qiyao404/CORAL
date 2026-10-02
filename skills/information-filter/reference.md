# information-filter 参考资料

## LLM 评估 Prompt 模板

```text
你是一位专业的{industries}领域分析师和项目申报专家，
熟悉{coreBusinesses}相关的政策与产业生态。

# 公司业务画像
{company_profile_json}

# 评估对象（共 {n} 条）
{items_compact_json}

# 任务
对每条信息基于"标题 + 摘要"做语义判断，决定保留或剔除，并给出 ≤ 30 字的理由。

## 保留规则（参考但不限于）
- 实质性政策文件：办法、措施、意见、规划、行动计划、指引、条例
- 项目申报与认定：申报、征集、组织开展、入库、培育（前瞻性动作）
- 公司画像内的关键词命中（{focusKeywords}）
- 与公司核心业务（{coreBusinesses}）相关的重大行业动态

## 剔除规则（参考但不限于）
- 已有结果：公示、名单、拟认定、通过
- 行政/人事/党建：人事任命、领导、座谈会、值班
- 非政策性公告：单纯采购/招标（非项目承担单位遴选）、统计数据、新闻
- 命中排除关键词：{excludeKeywords}

# 输出（严格 JSON，不要 markdown 代码块）
{
  "decisions": [
    { "index": 0, "keep": true,  "reason": "属于中试平台相关申报政策" },
    { "index": 1, "keep": false, "reason": "结果公示，非新机会" }
  ]
}
```

## 输入归一化（FilterableItem）

```typescript
interface FilterableItem {
  index: number;
  title: string;
  date?: string;
  source?: string;     // 机构/网站
  url?: string;
  excerpt: string;     // 标题外的描述（≤ 200 字）
  raw?: any;           // 原始字段，便于回写
}
```

## 分批策略

| 批次大小 | 适用场景 |
|---------|---------|
| ≤ 20 条 | 默认（safe）|
| ≤ 10 条 | 长 excerpt（>= 500 字）|
| 5 条 | dry_run 试运行 |

失败重试：3 次，指数退避 2s / 4s / 8s。

## 历史最佳实践（来自用户提供的政策筛选 prompt）

业务用户经常关心的政策类型（保留）：

- 中试平台 / 概念验证中心 / 科技成果转化
- 机器人 / 人工智能 / 生物医药 / 新材料
- 技术改造 / 专精特新 / 首台套
- 奖补 / 专项资金

应剔除的内容（黑名单）：

- 公示 / 名单 / 拟认定 / 通过 / 通报
- 人事任命 / 党建 / 座谈会
- 单纯采购 / 招标 / 统计数据
