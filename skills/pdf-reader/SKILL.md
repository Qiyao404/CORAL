---
name: pdf-reader
version: "1.0.0"
description: "PDF 文本提取——当工作区有 .pdf 文件或网页返回 PDF 时使用。从 PDF 中提取全文文本供分析。适用场景：论文阅读、报告分析、技术文档提取。"
domain: tools
capabilities:
  - pdf_text_extraction
  - document_parsing

input_schema:
  type: object
  required: [path]
  properties:
    path:
      type: string
      description: "PDF 文件路径（工作区内相对路径）"
    pages:
      type: string
      description: "页码范围（如 '1-5'，默认全部）"

output_schema:
  type: object
  properties:
    text:
      type: string

execution_mode: llm_only
cost_level: low
status: stable
tags: [PDF, 文档, 工具]
---

# PDF 文本提取（PDF Reader）

当需要从 PDF 文件中提取文本时，使用以下方法：

## 方法 1：用 code-exec 跑 Python

```python
# 纯标准库方案（无需 pip install）
import zlib
import re
from pathlib import Path

def extract_pdf_text(path):
    data = Path(path).read_bytes()
    # 找到所有 stream 对象
    streams = re.findall(rb'stream\r?\n(.*?)endstream', data, re.DOTALL)
    texts = []
    for stream in streams:
        try:
            decompressed = zlib.decompress(stream)
            # 提取文本内容（在括号里的）
            text_matches = re.findall(rb'\((.*?)\)', decompressed)
            for t in text_matches:
                decoded = t.decode('utf-8', errors='ignore')
                if decoded.strip():
                    texts.append(decoded)
        except:
            pass
    return ' '.join(texts)

text = extract_pdf_text('document.pdf')
print(text[:5000])  # 前 5000 字
```

## 方法 2：如果 Python 有 PyPDF2

```python
from PyPDF2 import PdfReader
reader = PdfReader('document.pdf')
for page in reader.pages:
    print(page.extract_text())
```

## 方法 3：http_fetch 下载 PDF 后处理

如果 PDF 在网上：
1. 先用 http_fetch 下载（设置 `output_file` 参数保存到工作区）
2. 再用 code-exec 提取

## 限制
- 扫描版 PDF（纯图片）无法用此方法提取文字
- 加密 PDF 需要密码
- 复杂排版（多栏、表格）可能提取顺序不准确
