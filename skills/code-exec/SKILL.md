---
name: code-exec
version: "1.1.0"
description: "在受限解释器内执行 Python 代码——用于精确计算、数据处理、单位换算、地理距离等需要编程解决的问题。比反复搜索更准确更高效。当任务涉及数学计算、坐标/距离、单位换算、数据分析时优先使用。只支持标准库计算模块；不能读写文件、联网或调用外部程序。"
domain: tools
capabilities:
  - safe_code_execution
  - calculation
  - data_processing

input_schema:
  type: object
  required: [code]
  properties:
    code:
      type: string
      description: "Python 3 代码（标准库计算模块；不能读写文件、联网、起子进程——违反会被沙箱拦截并返回说明）"

output_schema:
  type: object
  properties:
    stdout:
      type: string
    error:
      type: string

# 该技能的入参是模型写的代码；执行边界由 scripts/sandbox_prelude.py 实现（解释器级审计钩子 + 拒绝查找器 + 最小环境变量）
accepts_code: true
sandboxed: true

execution_mode: script
script_entry: scripts/main.mjs
script_runtime: node
script_timeout_ms: 30000
status: stable
tags: [计算, 编程, 工具]
---

# 受限代码执行（Code Exec）

## 使用场景

当你遇到以下类型的问题时，**优先使用本技能而非反复搜索**：

1. **数学计算**："时速 20km/h 跑 42.195 公里需要多少小时"
2. **单位换算**："17000 小时等于多少千小时"
3. **地理距离**："布宜诺斯艾利斯和赫尔辛基哪个离赤道更远"（用 haversine 公式）
4. **数据分析**："这组数据的标准差是多少"
5. **日期计算**："从 2024-01-15 到 2025-03-20 有多少天"
6. **逻辑验证**："验证这个公式是否恒成立"

## 沙箱边界（由运行时强制，不靠自觉）

代码在**受限解释器**内执行：读写文件、联网、起子进程、读注册表、加载动态库这些动作会被运行时直接拦截，并返回一条说明"这是沙箱的限制，不是代码 bug"。

- 能用：Python **标准库**的计算模块 —— `math` `statistics` `datetime` `json` `csv`（配合 `io.StringIO`）`re` `decimal` `fractions` `collections` `itertools` `random` `pathlib`（纯路径运算）`urllib.parse`（纯 URL 解析）等
- 不能用：任何文件读写、网络请求、子进程；`numpy` / `pandas` / `scipy` 等第三方库（它们在导入时自身会加载受限模块）—— 需要它们时请改用标准库等价写法，或改用专门处理文件的技能
- 拿不到密钥：代码里读不到任何 API 令牌（环境变量只保留系统目录项）

```python
# ✅ 允许的
import math
result = math.hypot(3, 4)  # 5.0

# ✅ 允许：定义坐标计算距离
from math import radians, sin, cos, asin, sqrt
def haversine(lat1, lon1, lat2, lon2):
    ...

# ❌ 被沙箱拦截：读写文件（open / pathlib 的读写方法）
# ❌ 被沙箱拦截：网络请求 / socket / urllib.request
# ❌ 被沙箱拦截：subprocess / os.system / ctypes / sqlite3 / winreg
```

## 输出要求
- 用 `print()` 输出结果
- 最后一个 print 的内容就是给 agent 看的答案
- 需要中间过程时 print 多行

## 精度优势
搜索"马拉松 42.195 公里 用时 1:59:40 平均速度"可能得到不精确的网页结果。
直接算：42195 / (1*3600 + 59*60 + 40) = 5.878 m/s ✓
