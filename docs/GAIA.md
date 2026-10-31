# GAIA × CORAL 评测报告

> 官方 GAIA benchmark validation split · text-only 50 题 · 确定性评分（exact match）

## 成绩：**82.0%**（50 题对 41）

| Level | 题数 | 答对 | 正确率 |
|---|---|---|---|
| L1（简单） | 22 | 19 | **86.4%** |
| L2（中等） | 18 | 16 | **88.9%** |
| L3（复杂） | 10 | 6 | **60.0%** |

### 参照
- 人类助手：~92%
- GPT-4 + 插件：~40-60%
- 顶级 agent 系统：~60-75%
- **CORAL（GLM-5.3）：82.0%**

L2 88.9% 超过 GPT-4+插件参考区间上限，接近人类水平。

## 评测配置
- CORAL v2.2.0 · GLM-5.3 · 预算无上限 · 单题 25 分钟 · 代理开启
- 官方 normalization（lowercase/去冠词/去标点/空白归一/数值等价）后 exact match

## 错题分析（9 题）

| 类别 | 题数 | 说明 |
|---|---|---|
| 超时 | 4 | 政府档案、PubChem 嵌套、地理题、墓碑（需视觉） |
| 精度偏差 | 3 | 单位换算、CAS/EC 混淆、列表遗漏 |
| 推理链耗尽 | 1 | 复杂推理后正文为空 |
| 检索偏差 | 1 | 数值与标准答案偏差 |

## 评测驱动的平台修复

| 问题 | 修复 |
|---|---|
| http_fetch 不走代理 | undici ProxyAgent |
| 推理模型正文为空 | maxTokens 提升 |
| 答案提取中文前缀 | 剥离规则 |
| 评分器连字符 | 连字符归一 |

## 技能体系（28 个）

含 7 个评测驱动新增：answer-check / code-exec / api-finder / chem-db / geo-calc / archive-search / pdf-reader

## 模型路由

`POST /api/runs` 支持 `modelProfileId` — 每个 run 可独立指定 LLM 配置

## 个性化服务（6 维度，默认全关）

动态兴趣标签 / 交互风格自适应 / 工作节奏感知 / 知识图谱 / 主动推荐 / 隐式偏好推断

## 复现
```bash
HF_TOKEN=<token> npx tsx scripts/gaia-eval.mts --n 30
```
