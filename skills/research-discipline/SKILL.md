---
name: research-discipline
version: "1.0.0"
description: "研究纪律：多源数据比较、计数验证、历史考据、内容恢复的方法学。在做深度调研、事实核查、数据比较、多源交叉验证时参考本技能。"
domain: research
capabilities: [research_methodology, verification]
input_schema:
  type: object
  properties:
    task_type: { type: string, description: "当前任务类型（如 counting / comparison / historical / recovery）" }
output_schema:
  type: object
  properties:
    guidance: { type: string }
execution_mode: llm_only
status: stable
tags: [研究, 质量]
source: builtin
---

# 研究纪律

在执行调研、事实核查或数据比较任务时，遵循以下纪律以确保结论可靠。

## 计数与数据提取

- **API 优先**：计数类任务（"how many X"）优先用平台的 API 接口，不手动解析 HTML
  - Wikipedia → MediaWiki API（`action=parse&prop=images`）
  - 任何有 REST API 的平台 → 直接调 API（查 skill_api-finder）
  - 手动逐页浏览在有 API 端点时是被禁止的
- **程序化计数**：所有计数用 skill_code-exec 脚本完成，不逐条手动数

## 多源比较纪律

- **先识别参数**：比较两个来源的数据前，从问题文本中精确识别要比较的参数（如"光谱硬化"≠"脉冲持续时间"）
- **同参数同单位**：确保两边数据使用同一参数和同一单位
- **交叉验证**：关键结论至少用两个独立来源确认；两个方法不一致时先调查再提交

## 历史考据

- **地理编码陷阱**：geocoding API（open-meteo / Google Maps）返回**现代地名**
- 历史事件（出生地、战役、条约签订地）必须用 Wikipedia 正文的**历史原名**
- 城市名可能因行政区划变更而改变（如殖民地时期的地名与现代地名不同）
- **验证方法**：获取人物/事件的 Wikipedia 传记页面，用其中陈述的原名

## 内容恢复

- **被封/超时页面** → 立即用 skill_blocked-page-recovery（恢复阶梯：Wayback → archive.today → 同站 API → 换源）
- **YouTube 视频** → 搜视频标题 + "transcript" / "description" / "summary"；或用 YouTube oEmbed API 获取元数据
- **付费墙** → 同上恢复阶梯

## 多语言搜索

- **日本数据** → 日文 Wikipedia（ja.wikipedia.org）搜索，用日文关键词
- **中文历史/法律** → 中文来源优先
- 通用原则：目标语言的内容通常比英文翻译更准确、更完整

## 精度与拼写

- **数值精度**：从来源提取数值时保留原始精度，不四舍五入
- **原始拼写**：引用/解码文本时保留原始拼写，不"纠正"为词典标准形式（如人名地名可能有非标准拼写）
- **答案格式**：提交前用 skill_answer-check 验证（单位 / 数量级 / 格式 / 常识）

## 学术论文比较

- 找到论文后，先读**图表标题和轴标签**确认显示的是什么参数
- 不要因为某个参数容易找到就用它替代问题实际问的参数
- 如果数据在图表中而非文本中，说明这一点并给出能从文本中确认的最接近结论
