import { describe, it, expect } from 'vitest';
import { verifyDeliverable, type VerifyLine } from '../verification-service.js';

/**
 * REG-36：检查者把检查行的文字"改写"了一下 → 对不上清单 → 原行被当成"判定缺失"按未通过处理。
 *
 * 真实复现：检查者对 2 条检查行全部判了通过，只是回传时写成了
 * "工作区根目录存在 report.md 文件"（原文：…存在名为 report.md 的文件）——
 * 平台最终判决变成 2/4 通过并打回重做。明明全过，却被自己的清单冤枉。
 *
 * 归位规则（三层，默认否的纪律不变）：
 *  1. 行号（检查者带回 index）        2. 文字：完全相等 → 去标点空白相等 → 包含 → 明显唯一的相似行
 *  3. 归不了位的判定丢弃，原行仍按"判定缺失 = 未通过"补齐
 */

const lines = (arr: string[]): VerifyLine[] => arr.map(line => ({ line, source: 'generated' }));
const checker = (results: unknown) => ({ chat: async () => ({ content: JSON.stringify({ results }) }) }) as any;
const run = (criteria: VerifyLine[], results: unknown) =>
  verifyDeliverable({ llm: checker(results), goal: '生成报告', criteria, finalContent: '见 report.md', artifacts: [] });

describe('verifyDeliverable · 判定结果归位', () => {
  const criteria = lines(['工作区根目录存在名为 report.md 的文件', '文档里有 3 行榜单']);

  it('检查者改写了行文字但全部判过 → 应当全过（不是 2/4）', async () => {
    const v = await run(criteria, [
      { line: '工作区根目录存在 report.md 文件', pass: true, evidence: '看到文件' },
      { line: '文档包含恰好 3 行榜单', pass: true, evidence: '看到 3 行' },
    ]);
    expect(v.passed).toBe(true);
    expect(v.passedCount).toBe(2);
    expect(v.totalCount).toBe(2);
    expect(v.level).toBe(4);
    expect(v.results.some(r => r.evidence.includes('判定缺失'))).toBe(false);
    expect(v.results.map(r => r.line)).toEqual(criteria.map(c => c.line)); // 行文字始终是清单原文
  });

  it('检查者带回行号：行文字被截断 / 改写也按行号归位', async () => {
    const v = await run(criteria, [
      { index: 2, line: '文档…', pass: true, evidence: '3 行' },
      { index: 1, line: '工作区…', pass: false, evidence: '文件不存在' },
    ]);
    expect(v.totalCount).toBe(2);
    expect(v.results[0].pass).toBe(false);
    expect(v.results[0].evidence).toBe('文件不存在');
    expect(v.results[1].pass).toBe(true);
    expect(v.results.every(r => r.matchedBy === 'index')).toBe(true);
  });

  it('默认否不变：检查者漏判的行仍按"判定缺失 = 未通过"补齐', async () => {
    const v = await run(criteria, [{ line: '工作区根目录存在 report.md 文件', pass: true, evidence: 'x' }]);
    expect(v.passed).toBe(false);
    expect(v.passedCount).toBe(1);
    expect(v.totalCount).toBe(2);
    expect(v.results[1].pass).toBe(false);
    expect(v.results[1].evidence).toContain('判定缺失');
  });

  it('与清单毫无关系的判定不会被硬塞给某一行', async () => {
    const v = await run(criteria, [{ line: '月亮是奶酪做的', pass: true, evidence: 'x' }]);
    expect(v.passedCount).toBe(0);
    expect(v.results.every(r => !r.pass && r.evidence.includes('判定缺失'))).toBe(true);
  });

  it('同一行被判了两次：只认第一条，不重复计数', async () => {
    const v = await run(criteria, [
      { line: '工作区根目录存在 report.md 的文件', pass: true, evidence: 'a' },
      { line: '工作区根目录存在名为 report.md 的文件', pass: false, evidence: 'b' },
      { line: '文档里有 3 行榜单', pass: true, evidence: 'c' },
    ]);
    expect(v.totalCount).toBe(2);
    expect(v.results[0].pass).toBe(true);
    expect(v.results[0].evidence).toBe('a');
  });

  it('相似但不相同的行不会被张冠李戴：相近的两条检查行各归各位', async () => {
    const c = lines(['输出文件是 report.md', '输出文件是 report.pdf']);
    const v = await run(c, [
      { line: '输出了 report.md 文件', pass: true, evidence: 'md 在' },
      { line: '输出了 report.pdf 文件', pass: false, evidence: 'pdf 不在' },
    ]);
    expect(v.totalCount).toBe(2);
    expect(v.results[0].pass).toBe(true);
    expect(v.results[1].pass).toBe(false);
  });
});
