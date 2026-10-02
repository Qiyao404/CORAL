#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
docx_text.py — 真实 .docx 读/写（M1 补强，纯标准库零依赖）

用法（由 CORAL 内置工具 docx_read / docx_write 调用，JSON 走 stdin）：
    {"mode": "read",  "path": "..."}                    → {"ok":true,"paragraphs":[...]}
    {"mode": "write", "path": "...", "content": "..."}  → {"ok":true,"paragraphs":N}

read:  解压 word/document.xml，按段落抽取全部文本。
write: 把纯文本构建为最小合法 OOXML（.docx）：一行 = 一段，
       "# " 前缀 = Heading 样式，空行 = 空段。Word/WPS 可直接打开。
"""
import json
import re
import sys
import zipfile


def esc(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def do_read(path: str) -> dict:
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8", "replace")
    paras = []
    for p in re.split(r"</w:p>", xml):
        texts = re.findall(r"<w:t[^>]*>([\s\S]*?)</w:t>", p)
        text = "".join(texts)
        text = (
            text.replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", '"')
            .replace("&#39;", "'")
        )
        if text.strip():
            paras.append(text.strip())
    return {"ok": True, "path": path, "paragraphs": paras, "count": len(paras)}


def do_write(path: str, content: str) -> dict:
    lines = content.replace("\r\n", "\n").split("\n")
    paras = []
    for line in lines:
        text = line.strip()
        if not text:
            paras.append("<w:p/>")
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", text)
        if m:
            level = len(m.group(1))
            paras.append(
                f'<w:p><w:pPr><w:pStyle w:val="Heading{level}"/></w:pPr>'
                f'<w:r><w:t xml:space="preserve">{esc(m.group(2))}</w:t></w:r></w:p>'
            )
        else:
            paras.append(
                f'<w:p><w:r><w:t xml:space="preserve">{esc(text)}</w:t></w:r></w:p>'
            )

    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>"
        + "".join(paras)
        + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"/></w:sectPr>'
        "</w:body></w:document>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/>'
        "</Relationships>"
    )

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", document)

    return {"ok": True, "path": path, "paragraphs": len(paras)}


def main() -> None:
    data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    mode = data.get("mode", "read")
    try:
        if mode == "read":
            out = do_read(data["path"])
        elif mode == "write":
            out = do_write(data["path"], data["content"])
        else:
            out = {"ok": False, "error": f"未知 mode: {mode}"}
    except FileNotFoundError:
        out = {"ok": False, "error": f"文件不存在: {data.get('path')}"}
    except zipfile.BadZipFile:
        out = {"ok": False, "error": "不是有效的 .docx 文件（OOXML zip 结构损坏）"}
    except KeyError as e:
        out = {"ok": False, "error": f"docx 缺少必需部件: {e}"}

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
