import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryService } from '../memory-service.js';
import { MemoryUsageService } from '../memory-usage-service.js';
import { makeMemoryTools } from '../../tools/builtin/memory.js';

/**
 * 记忆使用追踪（B4）：
 *  · recordUse / recordSuspect 记账 → stats 合并展示（flagged/stale 判定）
 *  · memory_read / memory_search 命中时经 ctx.emit 上报（run-engine 记账数据源）
 *  · 弱归因纪律：只记录，绝不自动删除
 */

let dir: string;
let svc: MemoryService;
let usage: MemoryUsageService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coral-memusage-'));
  svc = new MemoryService(dir);
  usage = new MemoryUsageService(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('MemoryUsageService — 记账与统计', () => {
  it('recordUse 累计计数并更新 lastUsedAt；stats 与文件列表合并', () => {
    svc.write('a.md', '内容 A');
    usage.recordUse(['a.md'], svc);
    usage.recordUse(['a.md'], svc);
    const stats = usage.stats(svc);
    expect(stats).toHaveLength(1);
    expect(stats[0].useCount).toBe(2);
    expect(stats[0].lastUsedAt).toBeTruthy();
    expect(stats[0].flagged).toBe(false);
  });

  it('misleads ≥ 2 → flagged（疑似误导徽标）；未达阈值不标', () => {
    svc.write('bad.md', '可疑记忆');
    svc.write('ok.md', '正常记忆');
    usage.recordSuspect(['bad.md'], svc);
    expect(usage.stats(svc).find(s => s.name === 'bad.md')!.flagged).toBe(false);
    usage.recordSuspect(['bad.md'], svc);
    expect(usage.stats(svc).find(s => s.name === 'bad.md')!.flagged).toBe(true);
    expect(usage.stats(svc).find(s => s.name === 'ok.md')!.flagged).toBe(false);
  });

  it('30 天未使用 → stale；从未使用 → idleDays null 不标', () => {
    svc.write('old.md', '旧记忆');
    svc.write('fresh.md', '新记忆');
    const now = Date.now();
    usage.recordUse(['old.md'], svc, new Date(now - 40 * 86_400_000)); // 40 天前用过
    usage.recordUse(['fresh.md'], svc, new Date(now - 86_400_000));    // 1 天前
    const stats = usage.stats(svc, now);
    expect(stats.find(s => s.name === 'old.md')!.stale).toBe(true);
    expect(stats.find(s => s.name === 'old.md')!.idleDays).toBe(40);
    expect(stats.find(s => s.name === 'fresh.md')!.stale).toBe(false);
    // 从未使用：idleDays null（不是 0 — "从未被需要过"与"今天刚用过"是两回事）
    expect(stats.find(s => s.name === 'never')?.idleDays).toBeUndefined();
  });

  it('记账落盘 .usage.json 且不污染记忆文件列表（只认 *.md）', () => {
    svc.write('a.md', 'x');
    usage.recordUse(['a.md'], svc);
    expect(existsSync(join(dir, '.usage.json'))).toBe(true);
    const persisted = JSON.parse(readFileSync(join(dir, '.usage.json'), 'utf-8'));
    expect(persisted['a.md'].useCount).toBe(1);
    // 列表不含 .usage.json / .history
    expect(svc.list().map(f => f.name)).toEqual(['a.md']);
  });

  it('文件名消毒：路径注入被清洗为扁平键（无路径分隔符，无法逃逸目录）', () => {
    usage.recordUse(['../../etc/passwd'], svc);
    const persisted = JSON.parse(readFileSync(join(dir, '.usage.json'), 'utf-8'));
    const keys = Object.keys(persisted);
    expect(keys.length).toBe(1);
    expect(keys[0]).not.toMatch(/[/\\]/); // 斜杠全部转为连字符 → join 后仍是目录内扁平文件名
    expect(keys[0].endsWith('.md')).toBe(true);
  });

  it('弱归因纪律：suspect 只改计数，文件原样保留（绝不自动删除）', () => {
    svc.write('keep.md', '内容不可被自动删除');
    for (let i = 0; i < 5; i++) usage.recordSuspect(['keep.md'], svc);
    expect(usage.stats(svc)[0].misleads).toBe(5);
    expect(svc.read('keep.md')!.content).toContain('不可被自动删除');
  });
});

describe('memory 工具 — 命中事件上报', () => {
  it('memory_read 上报 memory.read（含消毒后的文件名）', async () => {
    svc.write('note.md', '内容');
    const events: Array<{ type: string; payload: any }> = [];
    const tools = makeMemoryTools(svc);
    const read = tools.find(t => t.name === 'memory_read')!;
    const r = await read.invoke({ name: 'note.md' }, { emit: (e: any) => events.push(e) } as any);
    expect(r.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('memory.read');
    expect(events[0].payload.name).toBe('note.md');
  });

  it('memory_search 上报 memory.search_hit（命中文件去重）', async () => {
    svc.write('alpha.md', 'docker 修法 A');
    svc.write('beta.md', 'docker 修法 B');
    svc.write('gamma.md', '无关内容');
    const events: Array<{ type: string; payload: any }> = [];
    const tools = makeMemoryTools(svc);
    const search = tools.find(t => t.name === 'memory_search')!;
    const r = await search.invoke({ query: 'docker' }, { emit: (e: any) => events.push(e) } as any);
    expect(r.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('memory.search_hit');
    expect(events[0].payload.files.sort()).toEqual(['alpha.md', 'beta.md']);
  });

  it('ctx 缺失/emit 抛错不影响工具正常返回', async () => {
    svc.write('note.md', '内容');
    const tools = makeMemoryTools(svc);
    const read = tools.find(t => t.name === 'memory_read')!;
    const r1 = await read.invoke({ name: 'note.md' }, undefined as any);
    expect(r1.ok).toBe(true);
    const r2 = await read.invoke({ name: 'note.md' }, { emit: () => { throw new Error('boom'); } } as any);
    expect(r2.ok).toBe(true);
  });
});
