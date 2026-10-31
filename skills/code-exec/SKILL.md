---
name: code-exec
version: "1.0.0"
description: "安全 Python 代码执行——用于精确计算、数据处理、单位换算、地理距离等需要编程解决的问题。比反复搜索更准确更高效。当任务涉及数学计算、坐标/距离、单位换算、数据分析时优先使用。"
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
      description: "Python 3 代码（禁止 import os/sys/subprocess，禁止文件写入，禁止网络请求）"

output_schema:
  type: object
  properties:
    stdout:
      type: string
    error:
      type: string

execution_mode: script
script_entry: scripts/main.mjs
script_runtime: node
script_timeout_ms: 30000
status: stable
tags: [计算, 编程, 工具]
---

# 安全代码执行（Code Exec）

## 使用场景

当你遇到以下类型的问题时，**优先使用本技能而非反复搜索**：

1. **数学计算**："时速 20km/h 跑 42.195 公里需要多少小时"
2. **单位换算**："17000 小时等于多少千小时"
3. **地理距离**："布宜诺斯艾利斯和赫尔辛基哪个离赤道更远"（用 haversine 公式）
4. **数据分析**："这组数据的标准差是多少"
5. **日期计算**："从 2024-01-15 到 2025-03-20 有多少天"
6. **逻辑验证**："验证这个公式是否恒成立"

## 代码规则

```python
# ✅ 允许的
import math
result = math.hypot(3, 4)  # 5.0

# ✅ 允许：定义坐标计算距离
from math import radians, sin, cos, asin, sqrt
def haversine(lat1, lon1, lat2, lon2):
    ...

# ❌ 禁止：import os / sys / subprocess
# ❌ 禁止：open() / 文件操作
# ❌ 禁止：网络请求 / requests / urllib
# ❌ 禁止：eval() / exec() / __import__
```

## 输出要求
- 用 `print()` 输出结果
- 最后一个 print 的内容就是给 agent 看的答案
- 需要中间过程时 print 多行

## 精度优势
搜索"马拉松 42.195 公里 用时 1:59:40 平均速度"可能得到不精确的网页结果。
直接算：42195 / (1*3600 + 59*60 + 40) = 5.878 m/s ✓
