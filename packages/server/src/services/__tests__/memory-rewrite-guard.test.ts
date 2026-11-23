import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryService, rewriteCoverage, isLossyRewrite } from '../memory-service.js';
import { EvolutionService } from '../evolution-service.js';

/**
 * REG-38：设置页点"接受"一条记忆改写提议时，改写稿比原文短一大截也照样落盘。
 *
 * 真实复现：原文 5 行、改写稿 2 行，直接覆盖。对照——"合并记忆"功能早有"疑似丢内容就拒绝写盘"
 * 的保护，这条路径没有。改写本应只修正矛盾的那一两处。
 *
 * 度量是校准出来的，不是想出来的：第一版用"逐行原样保留率 ≥ 50%"，拿真实数据一量 —
 * 用户真实接受过的一次正常改写，逐行保留率是 0%（模型把每一条都换了说法），会被误拦。
 * 正常改写与丢内容的改写，真正的区别是"有没有整条内容消失"。
 */

let dir: string;
let memDir: string;
let svc: MemoryService;
let evolution: EvolutionService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coral-rewrite-'));
  memDir = join(dir, 'memory');
  mkdirSync(memDir, { recursive: true });
  svc = new MemoryService(memDir);
  evolution = new EvolutionService(
    { llm: { chat: async () => ({ content: '{}' }) } as any, skillsDir: join(dir, 'skills'), registry: { listAll: () => [], reloadSkill: async () => {} } as any, memoryDir: memDir },
    dir,
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ORIGINAL = ['# 项目约定', '- 服务端口是 3000，去年验证过', '- 代码审查每周五进行，由小林主持', '- 发布窗口是周二上午十点', '- 负责人是小林，副手是小王', '- 文档统一放在 docs 目录下'].join('\n');
/** 内容等价，但每一条都换了说法（真实改写的典型形态 — 逐行原样保留率 0） */
const REPHRASED = ['# 项目约定', '- 服务监听 3001 端口（已于本周重新确认）', '- 每周五由小林主持代码审查', '- 发布窗口：周二上午十点', '- 小林是负责人，小王是副手', '- 所有文档都放在 docs 目录'].join('\n');

function propose(file: string, proposed: string) {
  const p = evolution.proposeMemoryRewrite({ file, current: svc.read(file)?.content ?? '', proposed, evidence: '[run abc / answer] 证据', rationale: '离线对账发现矛盾' });
  expect(p, '提议应当创建成功').toBeTruthy();
  return p!;
}

describe('rewriteCoverage / isLossyRewrite（判定规则）', () => {
  it('只看事实行：标题、空行、信任标记不计', () => {
    const r = rewriteCoverage('<!-- trust: unreviewed -->\n\n# 标题\n\n- A\n- B\n- C\n', '# 标题\n\n- A\n- B\n- C\n');
    expect(r).toMatchObject({ total: 3, kept: 3, vanished: 0, recall: 1 });
  });

  it('全部换个说法（内容等价）：逐行保留 0，但没有一条消失 → 不算丢内容', () => {
    const r = rewriteCoverage(ORIGINAL, REPHRASED);
    expect(r.total).toBe(5);
    expect(r.kept).toBe(0);
    expect(r.vanished).toBe(0);
    expect(r.recall).toBeGreaterThan(0.45);
    expect(isLossyRewrite(r)).toBe(false);
  });

  it('只修正矛盾的那一处 → 不算丢内容', () => {
    const r = rewriteCoverage(ORIGINAL, ORIGINAL.replace('3000，去年验证过', '3001，本周验证过'));
    expect(isLossyRewrite(r)).toBe(false);
  });

  it('整条整条地消失（超过三分之一）→ 丢内容', () => {
    const lostHalf = rewriteCoverage(ORIGINAL, ['# 项目约定', '- 服务端口是 3001', '- 代码审查每周五进行', '- 负责人是小林'].join('\n'));
    expect(lostHalf.vanished).toBeGreaterThanOrEqual(2); // 发布窗口、文档这两条整条不见了
    expect(lostHalf.vanished / lostHalf.total).toBeGreaterThan(1 / 3);
    expect(isLossyRewrite(lostHalf)).toBe(true);
    const lostMost = rewriteCoverage(ORIGINAL, ['# 项目约定', '- 服务端口是 3001'].join('\n'));
    expect(lostMost.vanished).toBe(4);
    expect(isLossyRewrite(lostMost)).toBe(true);
  });

  it('被替换成无关内容 → 丢内容', () => {
    expect(isLossyRewrite(rewriteCoverage(ORIGINAL, ['# 别的东西', '- 用户喜欢简洁', '- 回答使用中文'].join('\n')))).toBe(true);
  });

  it('每条都被砍到只剩一小截（没有一条"完全"消失）→ 由整体召回兜底拦住', () => {
    const trimmed = ['# 项目约定', '- 服务端', '- 代码审', '- 发布窗', '- 负责人', '- 文档统'].join('\n');
    expect(isLossyRewrite(rewriteCoverage(ORIGINAL, trimmed))).toBe(true);
  });

  it('原文不足 3 条：不构成判断依据', () => {
    expect(isLossyRewrite(rewriteCoverage('- A', '- 完全不同的内容'))).toBe(false);
    expect(isLossyRewrite(rewriteCoverage('', '- 新内容'))).toBe(false);
  });
});

describe('接受记忆改写提议 · 内容丢失保护', () => {
  it('改写稿让大半条目消失 → 拒绝落盘，原文件一字不动，提议作废', async () => {
    svc.write('project.md', ORIGINAL, { trust: 'unreviewed' });
    const p = propose('project.md', ['# 项目约定', '- 服务端口是 3001'].join('\n'));

    const r = await evolution.decide(p.id, true);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/疑似/);
    expect(svc.read('project.md')!.content.endsWith(ORIGINAL)).toBe(true);
    expect(existsSync(join(memDir, '.history')) ? readdirSync(join(memDir, '.history')).length : 0).toBe(0); // 没走到备份那一步
    expect((await evolution.decide(p.id, true)).ok).toBe(false); // 已作废，不能重复裁决
  });

  it('全部换个说法的正常改写 → 照常落地（不能误拦）', async () => {
    svc.write('project.md', ORIGINAL, { trust: 'unreviewed' });
    const p = propose('project.md', REPHRASED);
    const r = await evolution.decide(p.id, true);
    expect(r.ok).toBe(true);
    expect(svc.read('project.md')!.content).toContain('每周五由小林主持代码审查');
  });

  it('只修正矛盾的那一行 → 正常落地，信任标记保留，原文件有备份（文件名带原文件名）', async () => {
    svc.write('project.md', ORIGINAL, { trust: 'unreviewed' });
    const p = propose('project.md', ORIGINAL.replace('3000，去年验证过', '3001，本周验证过'));

    const r = await evolution.decide(p.id, true);
    expect(r.ok).toBe(true);
    const after = svc.read('project.md')!;
    expect(after.content).toContain('- 服务端口是 3001，本周验证过');
    expect(after.content).toContain('- 负责人是小林，副手是小王');
    expect(after.trust).toBe('unreviewed');
    const backups = readdirSync(join(memDir, '.history'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toContain('project.md');
  });

  it('只有一两条内容的小文件：改掉唯一那条正是改写的用途，不误拦', async () => {
    const small = '# 端口\n- 服务端口是 3000';
    svc.write('small.md', small);
    const p = propose('small.md', '# 端口\n- 服务监听 3001');
    expect((await evolution.decide(p.id, true)).ok).toBe(true);
    expect(svc.read('small.md')!.content).toContain('3001');
  });

  it('拒绝提议（点"拒绝"）永远不动文件', async () => {
    svc.write('project.md', ORIGINAL);
    const p = propose('project.md', '- 全没了');
    expect((await evolution.decide(p.id, false)).ok).toBe(true);
    expect(svc.read('project.md')!.content.endsWith(ORIGINAL)).toBe(true);
  });
});
