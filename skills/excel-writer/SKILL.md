---
name: excel-writer
version: "1.0.0"
description: "Excel 生成——将表格数据写入 .xlsx 文件（用 Python openpyxl 或纯 XML 方案）。适用场景：数据导出、报表生成、清单制作。当用户要求 Excel 格式输出时使用。"
domain: tools
capabilities:
  - xlsx_generation
  - spreadsheet_export

input_schema:
  type: object
  required: [data, filename]
  properties:
    data:
      type: string
      description: "表格数据（JSON 格式：{headers:[], rows:[[]]} 或 CSV 字符串）"
    filename:
      type: string
      description: "输出文件名（如 report.xlsx）"

output_schema:
  type: object
  properties:
    path:
      type: string

execution_mode: llm_only
cost_level: low
status: stable
tags: [Excel, 表格, 导出]
---

# Excel 生成（Excel Writer）

你是表格生成助手。将数据写入真实的 .xlsx 文件。

## 方案选择

### 方案 1：Python openpyxl（推荐）
```python
# 用 code-exec 执行
from openpyxl import Workbook
wb = Workbook()
ws = wb.active
ws.append(["姓名", "年龄", "部门"])
ws.append(["张三", 28, "技术部"])
ws.append(["李四", 32, "产品部"])
wb.save("output/report.xlsx")
```

### 方案 2：纯 CSV（兼容性最好）
如果 openpyxl 不可用，生成 CSV 并告知用户。
```python
import csv
with open("output/report.csv", "w", newline="", encoding="utf-8-sig") as f:
    writer = csv.writer(f)
    writer.writerow(["姓名", "年龄", "部门"])
    writer.writerow(["张三", 28, "技术部"])
```

## 格式建议
- 表头加粗+背景色（openpyxl 的 Font/Fill）
- 数字列右对齐
- 中文字段用 utf-8-sig 编码（Excel 兼容）

## 纪律
- 优先用 code-exec + Python（真实 xlsx）
- openpyxl 不可用时降级为 CSV 并告知
- 列宽自适应（ws.column_dimensions[A].width = 15）
