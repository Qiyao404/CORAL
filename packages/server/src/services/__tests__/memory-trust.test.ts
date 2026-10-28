import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MemoryService } from '../memory-service.js';
import { makeMemoryTools } from '../../tools/builtin/memory.js';
import { SessionContextService } from '../session-context-service.js';
import { makeToolContext } from '../../tools/types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coral-mem-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('记忆信任分级', () => {
  it('带 trust 标记的写入可读出级别；无标记视为 reviewed（用户手编内容天然可信）', () => {
    const svc = new MemoryService(join(dir, 'memory'));
    svc.write('agent-note.md', '内容', { trust: 'unreviewed' });
    svc.write('user-note.md', '内容');
    expect(svc.read('agent-note.md')!.trust).toBe('unreviewed');
    expect(svc.read('user-note.md')!.trust).toBe('reviewed');
  });

  it('setTrust 只动头部标记，不碰正文', () => {
    const svc = new MemoryService(join(dir, 'memory'));
    svc.write('a.md', '正文第一行\n正文第二行', { trust: 'unreviewed' });
    expect(svc.setTrust('a.md', 'reviewed')).toBe(true);
    const r = svc.read('a.md')!;
    expect(r.trust).toBe('reviewed');
    expect(r.content).toContain('正文第一行');
    expect(r.content).toContain('正文第二行');
  });
});

describe('memory_write 防覆盖守卫（create-only + 显式 overwrite）', () => {
  it('已存在文件：默认拒绝并提示先读后合；overwrite=true 放行', async () => {
    const svc = new MemoryService(join(dir, 'memory'));
    const [,, write] = makeMemoryTools(svc);
    svc.write('prefs.md', '旧内容');

    const denied = await write.invoke({ name: 'prefs.md', content: '新内容' }, makeToolContext());
    expect(denied.ok).toBe(false);
    expect((denied.error as any).code).toBe('MEMORY_EXISTS');

    const allowed = await write.invoke({ name: 'prefs.md', content: '合并后的内容', overwrite: true }, makeToolContext());
    expect(allowed.ok).toBe(true);
    expect(svc.read('prefs.md')!.content).toContain('合并后的内容');
  });

  it('新文件：直接创建成功', async () => {
    const svc = new MemoryService(join(dir, 'memory'));
    const [,, write] = makeMemoryTools(svc);
    const r = await write.invoke({ name: 'fresh.md', content: 'x' }, makeToolContext());
    expect(r.ok).toBe(true);
  });
});

describe('会话决策与接力记录', () => {
  it('addDecision 累积（what+why+时间）；toPromptText 渲染为决策区', () => {
    const svc = new SessionContextService(dir);
    svc.addDecision('s1', '用表格对比两方案', '用户偏好结构化呈现');
    svc.addDecision('s1', '不生成 Word 改 Markdown', '用户明确要求轻量交付');
    const text = svc.toPromptText('s1');
    expect(text).toContain('本会话关键决策');
    expect(text).toContain('用表格对比两方案');
    expect(text).toContain('用户偏好结构化呈现');
  });

  it('setHandoff 覆盖式更新；toPromptText 的续接简报含中断点/下一步/阻塞', () => {
    const svc = new SessionContextService(dir);
    svc.setGoal('s1', '完成季度报告');
    svc.setHandoff('s1', { leftOff: '已收集数据，未成文', nextSteps: ['写第一章', '生成图表'], blockers: ['缺 Q3 数据'] });
    svc.setHandoff('s1', { leftOff: '第一章完成', nextSteps: ['写第二章'], blockers: [] });

    const ctx = svc.get('s1');
    expect(ctx.handoff!.leftOff).toBe('第一章完成');
    expect(ctx.handoff!.goal).toBe('完成季度报告'); // goal 不被覆盖

    const text = svc.toPromptText('s1');
    expect(text.startsWith('## 上次中断处')).toBe(true); // 简报在最前
    expect(text).toContain('第一章完成');
    expect(text).toContain('写第二章');
    expect(text).not.toContain('写第一章'); // 旧 nextSteps 已被覆盖
  });

  it('压缩（compress）保留决策与接力记录', () => {
    const svc = new SessionContextService(dir);
    svc.addDecision('s1', '决策A', '原因A');
    svc.setHandoff('s1', { leftOff: '中断', nextSteps: [], blockers: [] });
    svc.compress('s1', '精简后的要点');
    const ctx = svc.get('s1');
    expect(ctx.decisions.map(d => d.what)).toContain('决策A');
    expect(ctx.handoff?.leftOff).toBe('中断');
  });

  it('旧版 context.json（无 decisions 字段）读取时自动补默认', () => {
    const svc = new SessionContextService(dir);
    mkdirSync(join(dir, 'sessions', 'old'), { recursive: true });
    writeFileSync(join(dir, 'sessions', 'old', 'context.json'), JSON.stringify({ sessionId: 'old', fileSummaries: [], keyPoints: ['p1'], updatedAt: '2026-01-01' }), 'utf-8');
    const ctx = svc.get('old');
    expect(ctx.decisions).toEqual([]);
    expect(ctx.keyPoints).toEqual(['p1']);
  });
});
