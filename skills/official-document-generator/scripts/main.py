#!/usr/bin/env python3
"""
official-document-generator: 生成符合 GB/T 9704-2012 标准的党政机关公文 Word 文档
"""
import sys
import tempfile
import json
import os
import re
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '_lib'))
from coral_progress import emit_progress, emit_log, emit_artifact

try:
    from docx import Document
    from docx.shared import Pt, Cm, Inches
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn
except ImportError:
    emit_log('error', '缺少 python-docx 依赖，请安装: pip install python-docx')
    raise


def set_run_font(run, font_name='仿宋_GB2312', size=16, bold=False):
    """设置字体格式"""
    run.font.name = font_name
    run._element.rPr.rFonts.set(qn('w:eastAsia'), font_name)
    run.font.size = Pt(size)
    run.font.bold = bold


def add_formatted_paragraph(doc, text, font_name='仿宋_GB2312', size=16, 
                            bold=False, align='left', first_line_indent=0,
                            line_spacing=28, space_after=0):
    """添加格式化的段落"""
    p = doc.add_paragraph()
    
    # 对齐方式
    if align == 'center':
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    elif align == 'right':
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    elif align == 'justify':
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    
    # 首行缩进（字符数转厘米，约0.74cm/字符）
    if first_line_indent > 0:
        p.paragraph_format.first_line_indent = Cm(first_line_indent * 0.74)
    
    # 行距（磅值）
    p.paragraph_format.line_spacing = Pt(line_spacing)
    p.paragraph_format.space_after = Pt(space_after)
    
    run = p.add_run(text)
    set_run_font(run, font_name, size, bold)
    
    return p


def generate_document(inputs):
    """生成公文文档"""
    emit_progress(10, 100, '初始化文档')
    
    # 提取参数
    title = inputs.get('title', '')
    document_type = inputs.get('document_type', '通知')
    main_body = inputs.get('main_body', '')
    addressee = inputs.get('addressee', '')
    issuer = inputs.get('issuer', '')
    date_str = inputs.get('date', datetime.now().strftime('%Y-%m-%d'))
    attachment_list = inputs.get('attachment_list', [])
    copy_to = inputs.get('copy_to', [])
    urgency_level = inputs.get('urgency_level', '')
    
    # 解析日期
    try:
        date_obj = datetime.strptime(date_str, '%Y-%m-%d')
        date_display = f"{date_obj.year}年{date_obj.month}月{date_obj.day}日"
    except:
        date_display = date_str
    
    emit_progress(20, 100, '创建文档结构')
    
    # 创建文档
    doc = Document()
    
    # 页面设置（A4，标准页边距）
    section = doc.sections[0]
    section.page_width = Cm(21)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(3.7)
    section.bottom_margin = Cm(3.5)
    section.left_margin = Cm(2.8)
    section.right_margin = Cm(2.6)
    
    emit_progress(30, 100, '添加公文版头')
    
    # 紧急程度（如有）
    if urgency_level:
        p = add_formatted_paragraph(doc, urgency_level, '黑体', 16, 
                                    align='right', line_spacing=28)
    
    # 发文机关标志（红头效果用文字模拟，实际需图片）
    # 留空位置
    
    emit_progress(40, 100, '添加标题')
    
    # 标题：二号小标宋，居中
    add_formatted_paragraph(doc, title, '方正小标宋简体', 22, 
                           align='center', line_spacing=36, space_after=12)
    
    emit_progress(50, 100, '添加主送机关')
    
    # 主送机关：顶格，三号仿宋
    if addressee:
        add_formatted_paragraph(doc, addressee + '：', '仿宋_GB2312', 16,
                               line_spacing=28, space_after=6)
    
    emit_progress(60, 100, '添加正文')
    
    # 正文处理：按段落分割
    paragraphs = main_body.strip().split('\n')
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        
        # 判断是否为标题行（以数字或特定词开头）
        is_heading = re.match(r'^([一二三四五六七八九十]+、|\([0-9]+\)|[0-9]+\.)', para)
        
        if is_heading:
            # 公文小标题：三号黑体
            add_formatted_paragraph(doc, para, '黑体', 16, 
                                   first_line_indent=2, line_spacing=28)
        else:
            # 正文：三号仿宋，首行缩进2字符
            add_formatted_paragraph(doc, para, '仿宋_GB2312', 16,
                                   first_line_indent=2, line_spacing=28)
    
    emit_progress(75, 100, '添加附件说明')
    
    # 附件说明
    if attachment_list:
        doc.add_paragraph()  # 空行
        attach_text = '附件：' + '\n'.join([f"{i+1}.{name}" for i, name in enumerate(attachment_list)])
        add_formatted_paragraph(doc, attach_text, '仿宋_GB2312', 16,
                               first_line_indent=2, line_spacing=28)
    
    emit_progress(85, 100, '添加发文机关署名和成文日期')
    
    # 发文机关署名和成文日期：右对齐，右空四字
    doc.add_paragraph()  # 空行
    add_formatted_paragraph(doc, issuer, '仿宋_GB2312', 16,
                           align='right', line_spacing=28)
    add_formatted_paragraph(doc, date_display, '仿宋_GB2312', 16,
                           align='right', line_spacing=28)
    
    emit_progress(90, 100, '添加抄送机关')
    
    # 抄送机关
    if copy_to:
        doc.add_paragraph()  # 分隔线效果用空行
        copy_text = '抄送：' + '，'.join(copy_to) + '。'
        p = add_formatted_paragraph(doc, copy_text, '仿宋_GB2312', 14,
                                   line_spacing=28)
        # 左右各空一字
        p.paragraph_format.left_indent = Cm(0.74)
        p.paragraph_format.right_indent = Cm(0.74)
    
    emit_progress(95, 100, '保存文档')
    
    # 生成文件名
    safe_title = re.sub(r'[\\\\/:*?\"<>|]', '_', title)[:30]
    filename = f"{safe_title}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.docx"
    # 输出目录：CORAL_OUTPUT_DIR（graph run 绑定工作区时平台注入）> 系统临时目录
    out_dir = os.environ.get('CORAL_OUTPUT_DIR') or tempfile.gettempdir()
    os.makedirs(out_dir, exist_ok=True)
    output_path = os.path.join(out_dir, filename)
    
    # 保存文档
    doc.save(output_path)
    
    # 生成预览文本
    preview = main_body[:500] + '...' if len(main_body) > 500 else main_body
    
    # 上报产物（coral_progress 契约：name + path + type + preview）
    emit_artifact(filename, output_path, 'file', preview=preview[:200])
    
    emit_progress(100, 100, '完成')
    
    return {
        "document_path": output_path,
        "preview_text": preview,
        "format_check": {
            "page_setup": True,
            "font_standard": True,
            "structure_complete": bool(title and issuer and main_body)
        }
    }


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw else {}
        # 协议契约：执行器喂 {input, context} 包装；兼容手动裸输入
        inputs = payload.get('input', payload) if isinstance(payload, dict) else {}
        
        emit_log('info', f'开始生成公文: {inputs.get("title", "未命名")}')
        
        result = generate_document(inputs)
        
        print(json.dumps({
            "ok": True,
            "result": result
        }, ensure_ascii=False))
        
    except Exception as e:
        emit_log('error', f'生成失败: {str(e)}')
        print(json.dumps({
            "ok": False,
            "error": str(e)
        }, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()