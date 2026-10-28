import { describe, it, expect } from 'vitest';
import { validateSkillDraft } from '../skill-quality.js';

describe('技能质量门 — validateSkillDraft', () => {
  const okDraft = {
    name: 'pdf-extractor',
    description: '从 PDF 中提取全文与表格并落盘为 Markdown（当用户上传 PDF 要读取内容时使用）',
    executionMode: 'script',
    promptContent: [
      '# PDF 提取',
      '',
      '## 工作流',
      '1. 接收 path 参数并确认文件存在（fs_read 前置检查）',
      '2. 逐页提取文本与表格结构',
      '3. 合并为 Markdown 并落盘（fs_write，输出路径沿用输入名换 .md 后缀）',
      '4. 返回 {pages, chars, output_path}',
      '',
      '## 纪律',
      '- 只读源文件，绝不修改；解析失败逐页降级而不是整体失败',
    ].join('\n'),
  };

  it('合格草稿零错误零提醒', () => {
    const r = validateSkillDraft(okDraft, []);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('命名：非法/占位名是错误；冗余前缀是提醒', () => {
    const r1 = validateSkillDraft({ ...okDraft, name: 'MySkill' }, []);
    expect(r1.errors.some(e => e.includes('kebab-case'))).toBe(true);

    const r2 = validateSkillDraft({ ...okDraft, name: 'test-skill' }, []);
    expect(r2.errors.some(e => e.includes('占位名'))).toBe(true);

    const r3 = validateSkillDraft({ ...okDraft, name: 'skill-pdf-extractor' }, []);
    expect(r3.errors).toEqual([]);
    expect(r3.warnings.some(w => w.includes('冗余'))).toBe(true);
  });

  it('描述：过短/空话是错误；缺触发场景是提醒', () => {
    const r1 = validateSkillDraft({ ...okDraft, description: '处理数据' }, []);
    expect(r1.errors.some(e => e.includes('过短'))).toBe(true);

    const r2 = validateSkillDraft({ ...okDraft, description: '帮我做一个处理数据的功能' }, []);
    expect(r2.errors.some(e => e.includes('空话'))).toBe(true);

    const r3 = validateSkillDraft({ ...okDraft, description: '把 PDF 转成 Markdown 文件并提取全部表格' }, []);
    expect(r3.errors).toEqual([]);
    expect(r3.warnings.some(w => w.includes('触发场景'))).toBe(true);
  });

  it('查重：名字高度相近是提醒（建议改造而非新建）', () => {
    const r = validateSkillDraft(okDraft, [
      { name: 'pdf-extract-tables', description: '...' },
      { name: 'totally-different', description: '...' },
    ]);
    expect(r.warnings.some(w => w.includes('pdf-extract-tables'))).toBe(true);
    // 完全不同的名字不触发
    const r2 = validateSkillDraft(okDraft, [{ name: 'weather-report', description: '...' }]);
    expect(r2.warnings.some(w => w.includes('weather-report'))).toBe(false);
  });

  it('input_schema 形状与正文厚度', () => {
    const r1 = validateSkillDraft({ ...okDraft, inputSchema: { type: 'string' } as any }, []);
    expect(r1.errors.some(e => e.includes('input_schema'))).toBe(true);

    const r2 = validateSkillDraft({ ...okDraft, promptContent: '太短' }, []);
    expect(r2.warnings.some(w => w.includes('过薄'))).toBe(true);
  });
});
