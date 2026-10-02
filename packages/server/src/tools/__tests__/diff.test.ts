import { describe, it, expect } from 'vitest';
import { unifiedDiff } from '../diff.js';

describe('unifiedDiff（M1-2）', () => {
  it('内容一致 → 空字符串', () => {
    expect(unifiedDiff('a\nb\nc', 'a\nb\nc', 'f.txt')).toBe('');
  });

  it('修改一行 → 头两行 + 单 hunk，含 -/+ 行', () => {
    const d = unifiedDiff('one\ntwo\nthree', 'one\nTWO\nthree', 'f.txt');
    const lines = d.split('\n');
    expect(lines[0]).toBe('--- a/f.txt');
    expect(lines[1]).toBe('+++ b/f.txt');
    expect(lines[2]).toMatch(/^@@ -1,3 \+1,3 @@$/);
    expect(lines).toContain(' one');
    expect(lines).toContain('-two');
    expect(lines).toContain('+TWO');
    expect(lines).toContain(' three');
  });

  it('新增文件（空 → 内容）→ 全部为 + 行，行号从 1 起', () => {
    const d = unifiedDiff('', 'hello\nworld', 'new.txt');
    expect(d).toContain('@@ -0,0 +1,2 @@');
    expect(d).toContain('+hello');
    expect(d).toContain('+world');
  });

  it('删除行 → hunk 中只有 - 行（无 + 开头的变更行）', () => {
    const d = unifiedDiff('a\nb\nc', 'a\nc', 'f.txt');
    const bodyLines = d.split('\n').slice(2); // 跳过 ---/+++ 头
    expect(bodyLines).toContain('-b');
    expect(bodyLines.some(l => l.startsWith('+'))).toBe(false);
  });

  it('相隔超过 2×context 的两处修改 → 两个 hunk', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n');
    const after = before
      .split('\n')
      .map((l, i) => (i === 1 || i === 18 ? l + '-changed' : l))
      .join('\n');
    const d = unifiedDiff(before, after, 'f.txt');
    const hunks = d.split('\n').filter(l => l.startsWith('@@'));
    expect(hunks.length).toBe(2);
  });

  it('相邻修改合并进一个 hunk（上下文桥接）', () => {
    const d = unifiedDiff('a\nb\nc\nd\ne', 'a\nB\nc\nD\ne', 'f.txt');
    const hunks = d.split('\n').filter(l => l.startsWith('@@'));
    expect(hunks.length).toBe(1);
  });
});
