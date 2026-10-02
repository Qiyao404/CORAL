# Cursor Agent Skills 编写标准

> 本文档作为编写 Cursor Agent Skills 的标准参考，涵盖目录结构、文件规范、编写原则、常见模式及注意事项。

---

## 一、Skill 目录结构

每个 Skill 以**独立文件夹**形式存在，文件夹名即为技能标识符。

```
skill-name/
├── SKILL.md              # [必需] 主指令文件，Agent 首先读取此文件
├── reference.md          # [可选] 详细参考文档（API 文档、协议规范等）
├── examples.md           # [可选] 使用示例集合
└── scripts/              # [可选] 工具脚本目录
    ├── validate.py       #   验证脚本
    ├── helper.sh         #   辅助脚本
    └── template.json     #   模板文件
```

### 各文件职责

| 文件 | 必需 | 用途 | 注意事项 |
|------|:----:|------|----------|
| `SKILL.md` | ✅ | 核心指令，定义技能的元数据和执行逻辑 | 控制在 **500 行以内** |
| `reference.md` | ❌ | 详细参考资料，按需加载 | 仅在 SKILL.md 中引用，避免嵌套引用 |
| `examples.md` | ❌ | 输入输出示例 | 用于产出质量依赖示例的场景 |
| `scripts/` | ❌ | 可执行脚本或模板 | 比生成代码更可靠，节省 token |

---

## 二、存储位置

| 类型 | 路径 | 作用域 |
|------|------|--------|
| **个人级** | `~/.cursor/skills/skill-name/` | 所有项目通用 |
| **项目级** | `.cursor/skills/skill-name/` | 仅当前仓库，可提交到版本控制 |
| **CORAL 项目级** | `skills/skill-name/` | CORAL 自定义运行时使用 |

> **禁止** 在 `~/.cursor/skills-cursor/` 下创建文件，该目录由 Cursor 系统内部管理。

---

## 三、SKILL.md 文件结构

### 3.1 完整格式

```markdown
---
name: skill-name
description: >-
  简明描述此技能做什么以及何时使用。
---

# 技能标题

## 指令 / Instructions
清晰的分步指导。

## 示例 / Examples
具体的输入输出示例。

## 附加资源 / Additional Resources
- 详细参考见 [reference.md](reference.md)
- 更多示例见 [examples.md](examples.md)
```

### 3.2 Frontmatter 字段规范

#### 标准字段（Cursor 原生）

| 字段 | 必需 | 类型 | 约束 | 说明 |
|------|:----:|------|------|------|
| `name` | ✅ | string | 最长 64 字符；仅小写字母、数字、连字符 | 唯一标识符 |
| `description` | ✅ | string | 最长 1024 字符；不能为空 | Agent 用来判断何时触发此技能 |
| `disable-model-invocation` | ❌ | boolean | 默认 `false` | 设为 `true` 时 Agent 不会自动调用，仅通过 `/` 菜单手动触发 |

#### 扩展字段（CORAL 自定义运行时）

当技能运行在 CORAL 技能运行时中时，可使用以下扩展字段：

| 字段 | 必需 | 类型 | 说明 |
|------|:----:|------|------|
| `version` | ❌ | string | 语义化版本号，如 `"1.0.0"` |
| `domain` | ❌ | string | 领域分类，如 `data-processing`、`text-processing` |
| `capabilities` | ❌ | string[] | 能力标签列表 |
| `input_schema` | ❌ | object | 输入参数的 JSON Schema 定义 |
| `output_schema` | ❌ | object | 输出结果的 JSON Schema 定义 |
| `execution_mode` | ❌ | string | 执行模式：`llm_only` / `script` / `hybrid` |
| `human_gate` | ❌ | boolean | 是否需要人工审批 |
| `estimated_duration_ms` | ❌ | number | 预计执行时间（毫秒） |
| `cost_level` | ❌ | string | 成本等级：`low` / `medium` / `high` |
| `status` | ❌ | string | 状态：`stable` / `beta` / `experimental` |
| `tags` | ❌ | string[] | 搜索标签 |

---

## 四、Description 编写规范

`description` 是技能发现的**关键入口**，Agent 依据它决定是否触发技能。

### 4.1 核心原则

1. **使用第三人称**（description 会被注入系统提示词）：
   - ✅ `"对 PDF 文件进行文本提取和表格解析"`
   - ❌ `"我可以帮你处理 PDF 文件"`

2. **同时包含 WHAT 和 WHEN**：
   - **WHAT**：这个技能做什么（具体能力）
   - **WHEN**：什么时候应该使用（触发场景）

3. **包含触发关键词**：
   - ✅ `"审查代码质量、安全性和可维护性。用于审查 PR、检查代码变更或用户要求代码审查时。"`
   - ❌ `"帮助处理代码"`

### 4.2 示例

```yaml
# 数据转换
description: >-
  将输入的数据按照指定规则进行格式转换和结构化处理。
  用于处理 JSON、CSV 格式转换或字段映射等数据处理任务。

# Git 提交助手
description: >-
  通过分析 git diff 生成规范的提交信息。
  用于用户需要编写 commit message 或审查暂存变更时。

# PR 维护
description: >-
  保持 PR 处于可合并状态：分类评论、解决冲突、修复 CI。
  用于 PR 需要持续维护直到合并时。
```

---

## 五、编写原则

### 5.1 精简至上

上下文窗口由对话历史、其他技能和请求共享，每个 token 都在竞争空间。

**默认假设**：Agent 已经非常智能，只添加它不知道的内容。

自检标准：
- "Agent 真的需要这段解释吗？"
- "能否假设 Agent 已知此内容？"
- "这段文字值得占用 token 吗？"

```markdown
<!-- ✅ 精简 -->
## 提取 PDF 文本
使用 pdfplumber 提取文本：
\`\`\`python
import pdfplumber
with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
\`\`\`

<!-- ❌ 冗余 -->
## 提取 PDF 文本
PDF（便携式文档格式）是一种常见的文件格式，包含文本、图片和其他内容。
要从 PDF 中提取文本，您需要使用一个库。有很多库可供选择……
```

### 5.2 SKILL.md 控制在 500 行以内

主文件保持精简，详细内容使用渐进式披露（Progressive Disclosure）。

### 5.3 渐进式披露

```markdown
# PDF 处理

## 快速开始
[核心指令放在这里]

## 附加资源
- 完整 API 参见 [reference.md](reference.md)
- 使用示例参见 [examples.md](examples.md)
```

**引用保持一层深度** — 从 SKILL.md 直接链接到参考文件，避免多层嵌套引用（深层嵌套可能导致部分内容未被读取）。

### 5.4 适当的自由度

根据任务的脆弱程度匹配具体程度：

| 自由度 | 适用场景 | 示例 |
|--------|----------|------|
| **高**（文字指令） | 多种合理方案、依赖上下文 | 代码审查指南 |
| **中**（伪代码/模板） | 有首选模式但允许变化 | 报告生成 |
| **低**（具体脚本） | 脆弱操作、一致性关键 | 数据库迁移 |

---

## 六、常见模式

### 6.1 模板模式（Template Pattern）

提供标准化的输出格式模板：

```markdown
## 报告结构

使用此模板：

\`\`\`markdown
# [分析标题]

## 概要
[一段话概述核心发现]

## 关键发现
- 发现 1 及支撑数据
- 发现 2 及支撑数据

## 建议
1. 具体可执行的建议
2. 具体可执行的建议
\`\`\`
```

### 6.2 示例模式（Examples Pattern）

输出质量依赖示例时使用：

```markdown
## 提交信息格式

**示例 1：**
输入: 添加了基于 JWT 的用户认证
输出:
\`\`\`
feat(auth): implement JWT-based authentication

Add login endpoint and token validation middleware
\`\`\`

**示例 2：**
输入: 修复了日期在时区转换时显示错误的问题
输出:
\`\`\`
fix(reports): correct date formatting in timezone conversion

Use UTC timestamps consistently across report generation
\`\`\`
```

### 6.3 工作流模式（Workflow Pattern）

复杂操作分解为明确步骤并配合检查清单：

```markdown
## 表单填充工作流

复制此清单追踪进度：
\`\`\`
任务进度:
- [ ] 步骤 1: 分析表单结构
- [ ] 步骤 2: 创建字段映射
- [ ] 步骤 3: 验证映射
- [ ] 步骤 4: 填充表单
- [ ] 步骤 5: 验证输出
\`\`\`

**步骤 1: 分析表单结构**
运行: `python scripts/analyze_form.py input.pdf`
...
```

### 6.4 条件工作流模式（Conditional Workflow Pattern）

引导通过决策分支：

```markdown
## 文档修改工作流

1. 确定修改类型：

   **创建新内容？** → 跟随下方"创建工作流"
   **编辑已有内容？** → 跟随下方"编辑工作流"

2. 创建工作流:
   - 使用 docx-js 库
   - 从零构建文档
   ...
```

### 6.5 反馈循环模式（Feedback Loop Pattern）

对质量关键的任务实施验证循环：

```markdown
## 文档编辑流程

1. 进行编辑操作
2. **立即验证**: `python scripts/validate.py output/`
3. 如果验证失败：
   - 检查错误信息
   - 修复问题
   - 再次运行验证
4. **只有验证通过后才可继续**
```

---

## 七、工具脚本规范

预制脚本相比 Agent 生成代码的优势：
- 更可靠（经过测试验证）
- 节省 token（不需要在上下文中包含代码）
- 节省时间（无需生成代码）
- 保证多次使用的一致性

### 脚本文档模板

```markdown
## 工具脚本

**analyze_form.py**: 从 PDF 中提取所有表单字段
\`\`\`bash
python scripts/analyze_form.py input.pdf > fields.json
\`\`\`

**validate.py**: 检查错误
\`\`\`bash
python scripts/validate.py fields.json
# 返回: "OK" 或列出冲突
\`\`\`
```

### 脚本编写要求

- 明确说明 Agent 应该**执行**脚本还是**读取**脚本作为参考
- 记录所需的依赖包
- 包含明确且有用的错误处理
- 使用正斜杠路径（`scripts/helper.py`），避免反斜杠（`scripts\helper.py`）

---

## 八、反面模式（Anti-Patterns）

### 8.1 使用反斜杠路径

```
❌ scripts\helper.py
✅ scripts/helper.py
```

### 8.2 提供过多选项造成混淆

```markdown
<!-- ❌ 令人困惑 -->
"你可以使用 pypdf, 或者 pdfplumber, 或者 PyMuPDF, 或者……"

<!-- ✅ 提供默认值并保留替代方案 -->
"使用 pdfplumber 进行文本提取。
对于需要 OCR 的扫描件，改用 pdf2image 配合 pytesseract。"
```

### 8.3 包含时效性信息

```markdown
<!-- ❌ 会过时 -->
"如果你在 2025 年 8 月之前执行此操作，使用旧版 API。"

<!-- ✅ 使用「旧方法」分区 -->
## 当前方法
使用 v2 API 端点。

## 旧方法（已弃用）
<details>
<summary>Legacy v1 API</summary>
...
</details>
```

### 8.4 术语不一致

在整个技能中使用统一术语：
- ✅ 始终使用 "API 端点"（不要混用 "URL"、"路由"、"路径"）
- ✅ 始终使用 "字段"（不要混用 "框"、"元素"、"控件"）

### 8.5 模糊的技能名称

```
❌ helper, utils, tools, my-skill
✅ processing-pdfs, analyzing-spreadsheets, code-review
```

### 8.6 在 SKILL.md 中放置过多内容

```
❌ 将 1000+ 行的 API 文档直接放在 SKILL.md 中
✅ SKILL.md 放核心指令，API 文档放到 reference.md 中
```

---

## 九、完整示例

### 示例 1：标准 Cursor Skill

```
code-review/
├── SKILL.md
├── STANDARDS.md
└── examples.md
```

**SKILL.md：**

```markdown
---
name: code-review
description: >-
  审查代码质量、安全性和可维护性。
  用于审查 PR、检查代码变更或用户要求代码审查时。
---

# 代码审查

## 快速开始

审查代码时：
1. 检查正确性和潜在 Bug
2. 验证安全最佳实践
3. 评估代码可读性和可维护性
4. 确保测试充分

## 审查清单

- [ ] 逻辑正确且覆盖边界情况
- [ ] 无安全漏洞（SQL 注入、XSS 等）
- [ ] 代码遵循项目风格规范
- [ ] 函数大小合理且职责单一
- [ ] 错误处理全面
- [ ] 测试覆盖变更

## 反馈格式

- 🔴 **严重**: 合并前必须修复
- 🟡 **建议**: 建议改进
- 🟢 **可选**: 可选增强

## 附加资源

- 详细编码标准见 [STANDARDS.md](STANDARDS.md)
- 审查示例见 [examples.md](examples.md)
```

### 示例 2：CORAL 扩展 Skill

```
data-transform/
├── SKILL.md
├── reference.md
└── scripts/
    └── validate.py
```

**SKILL.md：**

```markdown
---
name: data-transform
version: "1.0.0"
description: "将输入的数据按照指定规则进行格式转换和结构化处理"
domain: data-processing
capabilities:
  - data_transformation
  - format_conversion
  - json_processing

input_schema:
  type: object
  required: [data]
  properties:
    data:
      type: object
      description: "需要转换的原始数据"
    transform_rules:
      type: string
      description: "转换规则说明（自然语言描述）"
    output_format:
      type: string
      description: "期望的输出格式（json/csv/markdown）"

output_schema:
  type: object
  properties:
    transformed_data:
      type: object
      description: "转换后的数据"
    transform_log:
      type: string
      description: "转换过程日志"

execution_mode: llm_only
human_gate: false
estimated_duration_ms: 6000
cost_level: low
status: stable
tags: [数据转换, JSON, 格式化]
---

# 数据格式转换

你是一个数据转换专家，能够根据用户描述的规则对数据进行格式变换、字段映射和结构化处理。

## 任务说明
1. 分析输入的原始数据结构
2. 理解用户指定的转换规则
3. 执行数据转换操作
4. 输出转换后的结构化结果

## 输出要求
- 输出纯 JSON 格式，不要包含 Markdown 代码块标记
- 保持数据完整性，不丢失有效信息
- 记录转换过程日志

## 附加资源
- 详细 API 说明见 [reference.md](reference.md)
- 验证脚本: `python scripts/validate.py output.json`
```

---

## 十、编写流程

### 阶段 1：需求收集

明确以下信息：
1. **目的与范围** — 技能帮助完成什么具体任务或工作流？
2. **存储位置** — 个人级（`~/.cursor/skills/`）还是项目级（`.cursor/skills/`）？
3. **触发场景** — Agent 在什么情况下自动应用此技能？
4. **领域知识** — 需要哪些 Agent 本身不具备的专业信息？
5. **输出格式** — 是否有特定模板、格式或风格要求？
6. **已有模式** — 是否有现成的示例或惯例可以参考？

### 阶段 2：设计

1. 确定技能名称（小写、连字符、最长 64 字符）
2. 编写第三人称的 description
3. 规划主要章节
4. 判断是否需要支撑文件（reference.md、scripts/）

### 阶段 3：实现

1. 创建目录结构
2. 编写 SKILL.md（frontmatter + 正文）
3. 创建参考文件（如需要）
4. 编写工具脚本（如需要）

### 阶段 4：验证

使用以下清单逐项检查。

---

## 十一、发布前检查清单

### 核心质量

- [ ] `name` 符合规范（小写字母 + 数字 + 连字符，≤ 64 字符）
- [ ] `description` 具体且包含触发关键词
- [ ] `description` 同时包含 WHAT（做什么）和 WHEN（何时用）
- [ ] `description` 使用第三人称
- [ ] SKILL.md 正文不超过 500 行
- [ ] 全文术语一致
- [ ] 示例是具体的而非抽象的

### 结构

- [ ] 文件引用保持一层深度（无嵌套引用）
- [ ] 适当使用渐进式披露
- [ ] 工作流步骤清晰明确
- [ ] 不包含时效性信息

### 脚本（如有）

- [ ] 脚本解决实际问题
- [ ] 依赖包已记录
- [ ] 错误处理明确且有用
- [ ] 使用正斜杠路径
- [ ] 明确标注是执行还是参考

### CORAL 扩展（如适用）

- [ ] `input_schema` 和 `output_schema` 定义完整
- [ ] `execution_mode` 设置正确
- [ ] `cost_level` 和 `estimated_duration_ms` 合理评估
- [ ] `status` 反映当前稳定程度
- [ ] `tags` 覆盖主要搜索词
