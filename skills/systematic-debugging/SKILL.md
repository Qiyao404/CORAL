---
name: systematic-debugging
version: "1.0.0"
description: "四阶段根因调试：复现与理解 → 假设定位 → 最小验证 → 修复与回归。禁止在未理解故障机理前动手改代码"
domain: development
capabilities: [debugging, root_cause]
input_schema:
  type: object
  required: [problem]
  properties:
    problem: { type: string, description: "故障描述（现象/报错/期望与实际的差异）" }
    context: { type: string, description: "相关代码位置、环境、最近变更（可选）" }
output_schema:
  type: object
  properties:
    rootCause: { type: string }
    fix: { type: string }
    regressionCheck: { type: string }
execution_mode: llm_only
status: stable
tags: [开发, 质量]
source: builtin
---

# 系统化根因调试

四阶段流程。铁律：**理解先于修改**——没走到阶段三不允许改任何代码。

## 阶段一：复现与理解

- 把"期望行为 vs 实际行为"写成一句话；不可复现的故障先构造最小复现条件
- 收集证据：报错全文、日志上下文、环境差异；用 skill_code-exec 复现数值/逻辑类问题
- 检查最近变更（git log / 新依赖 / 配置改动）——大多数故障来自变更
- 完成标志：能稳定复现，或能精确描述不可复现的条件分布

## 阶段二：假设定位

- 列出 ≥2 个候选根因假设，按"能解释全部现象的程度"排序（解释力弱的先淘汰）
- 二分法缩小范围：日志插桩、输入裁剪、环境变量开关——每次只改一个变量
- 找到"分界线"：改动什么条件时故障出现/消失——这条线就是根因所在层
- 完成标志：有一个假设能解释**所有**观察到的现象，且没有反例

## 阶段三：最小验证

- 设计一个能直接证实/证伪该假设的最小实验（往往是一行断言或一次定向日志）
- 实验结果与假设矛盾 → 回到阶段二，不是修补假设硬凑

## 阶段四：修复与回归

- 修复改动保持最小（只动根因层，不顺手重构）；修复后原复现用例必须转绿
- 回归检查：同类的其他调用点/相似模式是否也有此问题，列出来
- 记录：根因一句话 + 为什么最初没防住 + 如何避免再犯（可写入 memory 供未来会话使用）

## 反模式（禁止）

- 猎枪式修改：连续尝试多种改动"看哪个好使"——这是把阶段二三混在一起且都无法完成
- 只在表面加 try/catch 或兜底逻辑掩盖症状
- 修复后不重跑复现用例就宣布完成
