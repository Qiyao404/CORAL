import { describe, it, expect } from 'vitest';
import { createProgress } from './index.js';

function capture() {
  const lines: string[] = [];
  return { lines, sink: { write: (l: string) => lines.push(l) } };
}

/** sink 收到的是含 \n 的完整行 — 去尾后断言 */
const bare = (l: string) => l.replace(/\n$/, '');

describe('@coral/progress — CORAL_PROGRESS 协议 SDK（M1-7）', () => {
  it('emitProgress：单行 [CORAL_PROGRESS] JSON，percent 钳制 0-100，可选字段按需出现', () => {
    const { lines, sink } = capture();
    const p = createProgress(sink);

    p.emitProgress('scraping', '[3/8] 第 1 页', { step: 3, total: 8, percent: 37, detail: { site: 'gdii' } });
    p.emitProgress('x', 'over', { percent: 150 });
    p.emitProgress('y', 'under', { percent: -5 });

    expect(bare(lines[0])).toMatch(/^\[CORAL_PROGRESS\] \{.*\}$/);
    const e1 = JSON.parse(bare(lines[0]).replace('[CORAL_PROGRESS] ', ''));
    expect(e1).toMatchObject({ phase: 'scraping', step: 3, total: 8, percent: 37, detail: { site: 'gdii' } });
    expect(JSON.parse(bare(lines[1]).replace('[CORAL_PROGRESS] ', '')).percent).toBe(100);
    expect(JSON.parse(bare(lines[2]).replace('[CORAL_PROGRESS] ', '')).percent).toBe(0);
  });

  it('emitLog：不带协议前缀，级别映射为 [WARN]/[ERROR]/[DEBUG] 前缀', () => {
    const { lines, sink } = capture();
    const p = createProgress(sink);
    p.emitLog('普通');
    p.emitLog('警告', 'warn');
    p.emitLog('错误', 'error');
    p.emitLog('调试', 'debug');
    expect(lines.map(bare)).toEqual(['普通', '[WARN] 警告', '[ERROR] 错误', '[DEBUG] 调试']);
  });

  it('emitArtifact：phase=artifact + detail._artifact 结构（与 Python 版同语义）', () => {
    const { lines, sink } = capture();
    const p = createProgress(sink);
    p.emitArtifact({ name: '报告', path: 'output/report.md', type: 'markdown', preview: '# ...' });

    const e = JSON.parse(bare(lines[0]).replace('[CORAL_PROGRESS] ', ''));
    expect(e.phase).toBe('artifact');
    expect(e.message).toContain('报告');
    expect(e.detail._artifact).toMatchObject({ name: '报告', path: 'output/report.md', type: 'markdown' });
  });

  it('便捷默认实例 API 与服务端 ProgressParser 兼容（格式可直接解析）', async () => {
    const { lines, sink } = capture();
    const p = createProgress(sink);
    p.emitProgress('init', 'start', { percent: 10 });

    // 用服务端解析器验证往返（跨包 import，仅测试）
    const { ProgressParser } = await import('../../server/src/skill-runtime/progress-parser.js');
    const { progressEvents } = new ProgressParser().feed(lines[0]);
    expect(progressEvents[0].phase).toBe('init');
    expect(progressEvents[0].percent).toBe(10);
  });
});
