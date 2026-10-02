import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';
import { docxReadTool, docxWriteTool } from '../builtin/docx.js';
import { makeToolContext } from '../types.js';

const tmp = mkdtempSync(join(tmpdir(), 'coral-docx-'));
const ws = join(tmp, 'ws');
const ctx = () => makeToolContext({ workspaceDir: ws });

beforeAll(() => mkdirSync(ws, { recursive: true }));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('docx_read / docx_write 工具（M1 补强：真实 Word 读写）', () => {
  it('写 → 读 往返：内容一致，产物为真实 OOXML（zip 结构）', async () => {
    const content = '# 会议纪要（浓缩版）\n\n一、会议概况\n本次会议完成了产品评审。\n\n二、议定事项\n- 技术部完成调度优化\n- 产品部输出体验清单';
    const w = await docxWriteTool.invoke({ path: '纪要-浓缩版.docx', content }, ctx());
    expect(w.ok).toBe(true);
    expect((w.data as any).paragraphs).toBeGreaterThan(3);
    expect(existsSync(join(ws, '纪要-浓缩版.docx'))).toBe(true);

    // 真实 OOXML：zip 魔数 PK
    const head = readFileSync(join(ws, '纪要-浓缩版.docx')).subarray(0, 2);
    expect(head.toString('latin1')).toBe('PK');

    const r = await docxReadTool.invoke({ path: '纪要-浓缩版.docx' }, ctx());
    expect(r.ok).toBe(true);
    const text = (r.data as any).text;
    expect(text).toContain('会议纪要（浓缩版）');
    expect(text).toContain('技术部完成调度优化');
    expect((r.data as any).count).toBeGreaterThan(3);
  }, 20000);

  it('非 .docx 输出路径 / 空 content → BAD_INPUT', async () => {
    expect((await docxWriteTool.invoke({ path: 'a.txt', content: 'x' }, ctx())).error?.code).toBe('BAD_INPUT');
    expect((await docxWriteTool.invoke({ path: 'a.docx', content: '' }, ctx())).error?.code).toBe('BAD_INPUT');
  });

  it('读不存在的文件 → 明确错误；越界 → PATH_ESCAPE', async () => {
    const miss = await docxReadTool.invoke({ path: 'ghost.docx' }, ctx());
    expect(miss.ok).toBe(false);
    expect(miss.error?.message).toContain('不存在');

    const escape = await docxReadTool.invoke({ path: '../out.docx' }, ctx());
    expect(escape.error?.code).toBe('PATH_ESCAPE');
  });

  it('权限位：读 auto / 写 approval', () => {
    expect(docxReadTool.permission).toBe('auto');
    expect(docxWriteTool.permission).toBe('approval');
  });
});
