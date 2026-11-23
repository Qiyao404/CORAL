import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MemoryService, distillMemory } from '../memory-service.js';
import { appendToMemory } from '../memory-router.js';

/**
 * REG-19：改写既有记忆文件不得丢内容、不得丢信任标记。
 *
 * 根因两层：① write() 只有显式传 trust 才写标记 — 所有"更新既有文件"的调用方
 * （蒸馏 / 并入 / 合并）都没传，写回后 agent 写的 unreviewed 文件被洗成 reviewed；
 * ② 蒸馏只把既有文件【名】给模型，模型回一份"全新的短文件"就整篇覆盖 — 老事实蒸发。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coral-distill-'));
  mkdirSync(join(dir, 'memory'), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const item = (filename: string, content: string) =>
  JSON.stringify({ long_term: [{ filename, content }], session_files: [], session_points: [] });

describe('MemoryService.write — 更新既有文件时保留原信任标记', () => {
  it('未显式传 trust：沿用原文件的标记（unreviewed 不会被洗成 reviewed）', () => {
    const svc = new MemoryService(join(dir, 'memory'));
    svc.write('a.md', '正文', { trust: 'unreviewed' });
    svc.write('a.md', '正文\n\n追加的新内容');
    const r = svc.read('a.md')!;
    expect(r.trust).toBe('unreviewed');
    expect(r.content).toContain('追加的新内容');
  });

  it('原文件无标记（用户手编）：写回后仍无标记', () => {
    const svc = new MemoryService(join(dir, 'memory'));
    svc.write('u.md', '用户写的内容');
    svc.write('u.md', '用户写的内容\n\n追加');
    expect(svc.read('u.md')!.trust).toBe('reviewed');
    expect(svc.read('u.md')!.content).not.toContain('<!-- trust');
  });

  it('内容自身已带标记（并入路径把原文整篇拼进去）不重复加标记', () => {
    const svc = new MemoryService(join(dir, 'memory'));
    svc.write('a.md', '正文', { trust: 'unreviewed' });
    const whole = svc.read('a.md')!.content;
    svc.write('a.md', `${whole}\n\n## 追加`);
    expect(svc.read('a.md')!.content.match(/<!-- trust/g)?.length).toBe(1);
  });

  it('显式传 trust 仍以调用方为准', () => {
    const svc = new MemoryService(join(dir, 'memory'));
    svc.write('a.md', '正文', { trust: 'unreviewed' });
    svc.setTrust('a.md', 'reviewed');
    svc.write('a.md', '正文');
    expect(svc.read('a.md')!.trust).toBe('reviewed');
  });

  it('并入路径（appendToMemory）不再丢标记', () => {
    const svc = new MemoryService(join(dir, 'memory'));
    svc.write('prefs.md', '# 偏好\n- 中文回复', { trust: 'unreviewed' });
    appendToMemory(svc, 'prefs.md', '- 喜欢表格', 'tmp.md');
    const r = svc.read('prefs.md')!;
    expect(r.trust).toBe('unreviewed');
    expect(r.content).toContain('中文回复');
    expect(r.content).toContain('喜欢表格');
  });
});

describe('distillMemory — 既有文件的全保留合并', () => {
  const ORIG = '# 偏好\n- 中文回复\n- 喜欢表格汇总\n';
  function seeded(trust?: 'unreviewed' | 'reviewed') {
    const svc = new MemoryService(join(dir, 'memory'));
    svc.write('user-preferences.md', ORIG, trust ? { trust } : {});
    return svc;
  }

  it('模型回了一份丢行的"新文件" → 老事实一条不丢，只追加真正的新内容', async () => {
    const svc = seeded('unreviewed');
    const r = await distillMemory(
      { async complete() { return { content: item('user-preferences.md', '# 偏好\n- 中文回复\n- 喜欢简洁的要点列表\n') }; } } as any,
      svc, 'transcript',
    );
    const after = svc.read('user-preferences.md')!;
    expect(after.content).toContain('喜欢表格汇总'); // 被模型丢掉的老事实仍在
    expect(after.content).toContain('喜欢简洁的要点列表'); // 新内容进来了
    expect(after.trust).toBe('unreviewed');
    expect((r.longTermWritten[0] as any).mode).toBe('appended');
  });

  it('模型回的是完整超集 → 采用合并结果（merged）', async () => {
    const svc = seeded('unreviewed');
    const r = await distillMemory(
      { async complete() { return { content: item('user-preferences.md', `${ORIG}- 回答末尾给下一步建议\n`) }; } } as any,
      svc, 'transcript',
    );
    const after = svc.read('user-preferences.md')!;
    expect(after.content).toContain('喜欢表格汇总');
    expect(after.content).toContain('下一步建议');
    expect(after.content.match(/下一步建议/g)?.length).toBe(1);
    expect(after.trust).toBe('unreviewed');
    expect((r.longTermWritten[0] as any).mode).toBe('merged');
  });

  it('没有新内容 → 不重写文件', async () => {
    const svc = seeded();
    const r = await distillMemory(
      { async complete() { return { content: item('user-preferences.md', ORIG) }; } } as any,
      svc, 'transcript',
    );
    expect(r.longTermWritten).toHaveLength(0);
    expect(svc.read('user-preferences.md')!.content).toBe(ORIG);
  });

  it('覆盖既有文件前先备份到 .history/', async () => {
    const svc = seeded('unreviewed');
    await distillMemory(
      { async complete() { return { content: item('user-preferences.md', `${ORIG}- 新增一条\n`) }; } } as any,
      svc, 'transcript',
    );
    const hist = join(dir, 'memory', '.history');
    const backups = readdirSync(hist).filter(f => f.includes('user-preferences'));
    expect(backups.length).toBeGreaterThan(0);
    const backupText = readFileSync(join(hist, backups[0]), 'utf-8');
    expect(backupText).toContain('喜欢表格汇总');
  });

  it('模型能看到既有文件的正文（而不只是文件名）', async () => {
    const svc = seeded();
    let prompt = '';
    await distillMemory(
      { async complete(_m: any) { prompt = _m.map((x: any) => x.content).join('\n'); return { content: item('user-preferences.md', ORIG) }; } } as any,
      svc, 'transcript',
    );
    expect(prompt).toContain('喜欢表格汇总');
  });

  it('用户手编（无标记）与已确认（reviewed）的文件：信任级别原样保留', async () => {
    const a = seeded();
    await distillMemory({ async complete() { return { content: item('user-preferences.md', `${ORIG}- a1\n`) }; } } as any, a, 't');
    expect(a.read('user-preferences.md')!.trust).toBe('reviewed');
    expect(a.read('user-preferences.md')!.content).not.toContain('<!-- trust');

    const svc2 = new MemoryService(join(dir, 'memory2'));
    svc2.write('p.md', '# P\n- p1', { trust: 'unreviewed' });
    svc2.setTrust('p.md', 'reviewed');
    await distillMemory({ async complete() { return { content: item('p.md', '# P\n- p2\n') }; } } as any, svc2, 't');
    expect(svc2.read('p.md')!.trust).toBe('reviewed');
    expect(svc2.read('p.md')!.content).toContain('- p1');
    expect(svc2.read('p.md')!.content).toContain('- p2');
  });

  it('新文件仍然默认 unreviewed（既有行为不变）', async () => {
    const svc = seeded();
    const r = await distillMemory({ async complete() { return { content: item('brand-new.md', '# 新\n- n1\n') }; } } as any, svc, 't');
    expect((r.longTermWritten[0] as any).mode).toBe('created');
    expect(svc.read('brand-new.md')!.trust).toBe('unreviewed');
  });
});
