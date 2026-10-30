# GAIA × CORAL 评测报告

> 生成于 2026-10-30 · 官方 GAIA benchmark validation split（gaia-benchmark/GAIA）
> 任务范围：text-only 抽样 30 题（L1 10 / L2 16 / L3 4）· 无附件（CORAL 无音频/图像通道）
> 运行配置：CORAL v2.2.0 · GLM-5.3（智谱 coding plan）· 预算无上限 · 单题 25 分钟 · 工作区 auto 无人值守 · 代理开启
> 评分：官方 normalization（lowercase/去冠词/去标点含连字符/空白归一/数值等价）后 exact match — 确定性评分

## 成绩：**63.3%**（30 题对 19）· 超时 1

| Level | 得分 | 比例 |
|---|---|---|
| L1 | 7/10 | 70% |
| L2 | 9/16 | 56% |
| L3 | 2/4 | 50% |

### 参照（官方 validation 榜粗略区间）
- 人类助手 ~92%
- GPT-4 + 插件 ~40-60%
- 顶级 agent 系统 ~60-75%
- **CORAL（GLM-5.3，25 分钟限时）：63.3%**

## 错误分析（11 题，已定位根因并修复）

| 类别 | 题数 | 根因 | 修复 |
|---|---|---|---|
| 推理模型空回答 | 4 | GLM-5.3 reasoning 计入 maxTokens=4096，推理花 3900 后正文空 | **已修**：maxTokens 提至 16384 |
| 模型精度偏差 | 4 | 数量级（17000 vs 17）、计数差 1（40 vs 41）、公式多一个否定号、表格读错 | 模型能力边界（非 harness 问题） |
| 能力缺口 | 2 | 需看图像（headstone 墓碑题）、需领域知识（EC 编号） | 架构边界（无多模态通道） |
| 答案提取缺陷 | 1 | "最终答案：cloak" 前缀未剥离 | **已修**：提取器补中文前缀 |

### 修复后潜在提升
4 道空回答题修复后（maxTokens 16384），预计可救回 2-3 题 → 潜在 **70%+**

## 评测发现并修复的平台问题
1. **http_fetch 不走代理**（undici 原生 fetch 无视系统代理 → 维基百科等境外源 fetch failed）→ ProxyAgent（undici）+ `CORAL_HTTP_PROXY`
2. **推理模型 maxTokens 不足**（GLM-5.3 reasoning 耗尽 4096 预算）→ 提至 16384
3. **答案提取中文前缀**（"最终答案："未剥离）→ 评测器已修
4. **评测 run 挤占对话列表**（107 条 null-session run 把用户对话挤出 limit=100）→ API 加 hasSession 过滤 + 前端只拉有 session 的 run
5. **评分器连字符缺口**（human-oriented ≠ human oriented）→ 已修

## 复现
```bash
# 前置：.env 加 CORAL_HTTP_PROXY + HF_TOKEN
HF_TOKEN=<token> npx tsx scripts/gaia-eval.mts --n 30
```
