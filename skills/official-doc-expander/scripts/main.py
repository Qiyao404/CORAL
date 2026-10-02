#!/usr/bin/env python3
"""
official-doc-expander: 公文扩写与 Word 生成
符合 GB/T 9704-2012《党政机关公文格式》
"""
import sys
import json
import os
import re
import tempfile
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '_lib'))
from coral_progress import emit_progress, emit_log, emit_artifact

# 尝试导入 docx，如未安装则给出友好提示
try:
    from docx import Document
    from docx.shared import Pt, Mm, RGBColor, Inches
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
    from docx.oxml.ns import qn
    HAS_DOCX = True
except ImportError:
    HAS_DOCX = False

def set_run_font(run, font_name='仿宋', size_pt=16, bold=False):
    """设置字体，兼容 Windows/Linux"""
    run.font.name = font_name
    run._element.rPr.rFonts.set(qn('w:eastAsia'), font_name)
    run.font.size = Pt(size_pt)
    run.font.bold = bold

def add_red_header(doc, org_name):
    """添加发文机关标志（红色小标宋体）"""
    para = doc.add_paragraph()
    para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = para.add_run(org_name + "文件")
    set_run_font(run, '小标宋简体', 22, bold=True)
    run.font.color.rgb = RGBColor(0xFF, 0x00, 0x00)
    # 红色分隔线通过下边框模拟（简化版）
    para.paragraph_format.space_after = Pt(12)

def format_doc_number(doc_type, org_name):
    """生成发文字号"""
    # 简化处理：取机关简称 + 年份 + 序号
    short = re.sub(r'[省市县区局委员会]+', '', org_name)[:2]
    year = datetime.now().year
    return f"{short}发〔{year}〕1号"

def expand_content(key_points, doc_type):
    """AI 扩写公文正文（LLM 部分，此处为占位框架）"""
    # 实际由 hybrid 模式的 LLM 层处理，脚本负责格式编排
    # 此处仅做结构化拆分
    lines = [l.strip() for l in key_points.split('\n') if l.strip()]
    return {
        'background': lines[0] if lines else '',
        'body': '\n'.join(lines[1:]) if len(lines) > 1 else key_points,
        'requirements': ''
    }

def create_official_document(inputs):
    """生成符合 GB/T 9704-2012 的 Word 文档"""
    if not HAS_DOCX:
        raise RuntimeError("缺少 python-docx 依赖，请联系管理员安装")
    
    key_points = inputs.get('key_points', '')
    doc_type = inputs.get('doc_type', '通知')
    title = inputs.get('title', '') or f"关于{key_points[:20]}的{doc_type}"
    org_name = inputs.get('org_name', '××单位')
    date_str = inputs.get('date', datetime.now().strftime('%Y-%m-%d'))
    
    emit_progress(10, 100, '初始化文档格式')
    
    # 创建文档
    doc = Document()
    
    # 设置页面（A4，标准页边距）
    section = doc.sections[0]
    section.page_width = Mm(210)
    section.page_height = Mm(297)
    section.top_margin = Mm(37)
    section.bottom_margin = Mm(35)
    section.left_margin = Mm(28)
    section.right_margin = Mm(26)
    
    emit_progress(25, 100, '编排版头')
    
    # 版头：发文机关标志（红色）
    add_red_header(doc, org_name)
    
    # 发文字号
    para = doc.add_paragraph()
    para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = para.add_run(format_doc_number(doc_type, org_name))
    set_run_font(run, '仿宋', 14)
    para.paragraph_format.space_after = Pt(18)
    
    emit_progress(40, 100, '编排主体')
    
    # 标题（2号小标宋体，居中）
    para = doc.add_paragraph()
    para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = para.add_run(title)
    set_run_font(run, '小标宋简体', 22, bold=True)
    para.paragraph_format.space_before = Pt(18)
    para.paragraph_format.space_after = Pt(18)
    
    # 主送机关（3号仿宋，顶格）
    para = doc.add_paragraph()
    run = para.add_run("各有关单位：")
    set_run_font(run, '仿宋', 16)
    para.paragraph_format.space_after = Pt(12)
    
    # 正文（3号仿宋，首行缩进2字符）
    content = expand_content(key_points, doc_type)
    body_text = content['body']
    
    # 简单的层次结构处理
    paragraphs = re.split(r'\n\s*\n', body_text)
    for ptext in paragraphs:
        if not ptext.strip():
            continue
        para = doc.add_paragraph()
        # 检查是否已有层次序号
        if re.match(r'^[一二三四五六七八九十]+[、\.]', ptext.strip()):
            run = para.add_run(ptext.strip())
            set_run_font(run, '黑体', 16, bold=True)
        else:
            run = para.add_run('　　' + ptext.strip())  # 首行缩进用全角空格
            set_run_font(run, '仿宋', 16)
        para.paragraph_format.line_spacing = Pt(28.8)  # 28磅行距
        para.paragraph_format.space_after = Pt(0)
    
    emit_progress(70, 100, '编排版记')
    
    # 附件说明（如有）
    # 发文机关署名和成文日期
    doc.add_paragraph()  # 空行
    para = doc.add_paragraph()
    para.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run = para.add_run(org_name)
    set_run_font(run, '仿宋', 16)
    
    para = doc.add_paragraph()
    para.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    # 日期转中文格式
    date_obj = datetime.strptime(date_str, '%Y-%m-%d')
    cn_date = f"{date_obj.year}年{date_obj.month}月{date_obj.day}日"
    run = para.add_run(cn_date)
    set_run_font(run, '仿宋', 16)
    
    # 附注（如有）
    
    emit_progress(85, 100, '保存文档')
    
    # 保存到临时文件
    filename = f"{org_name}_{doc_type}_{date_str}.docx"
    with tempfile.NamedTemporaryFile(mode='wb', suffix='.docx', delete=False) as tmp:
        doc_path = tmp.name
        doc.save(doc_path)
    
    # 上报为 artifact
    emit_artifact(doc_path, filename, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    
    emit_progress(100, 100, '完成')
    
    return {
        "ok": True,
        "doc_url": f"artifact://{filename}",
        "filename": filename,
        "expanded_text": body_text[:500] + "..." if len(body_text) > 500 else body_text
    }

def main():
    try:
        raw = sys.stdin.read()
        inputs = json.loads(raw) if raw else {}
        
        if not inputs.get('key_points'):
            print(json.dumps({"ok": False, "error": "缺少必填参数 key_points"}, ensure_ascii=False))
            return
        
        result = create_official_document(inputs)
        print(json.dumps(result, ensure_ascii=False))
        
    except Exception as e:
        emit_log('ERROR', str(e))
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))

if __name__ == '__main__':
    main()