import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { HabitService } from '../habit-service.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coral-habit-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 脚本化 LLM：蒸馏固定返回一条"docx 用 docx_read"的习惯 */
const fakeLlm = {
  complete: async () => ({
    content: JSON.stringify({
      habits: [
        { trigger: 'reading Word .docx files', action: 'use docx_read, never fs_read', evidence: 'goal=读取合同.docx tool=fs_read ok=true ×2' },
      ],
    }),
  }),
};

describe('HabitService — 观察→蒸馏→置信度→晋升', () => {
  it('observe 落 JSONL；observationsSinceLastDistill 随写入递增', () => {
    const svc = new HabitService(dir);
    for (let i = 0; i < 12; i++) {
      svc.observe({
        runId: `r${i}`, sessionId: 's1', agentId: 'main', tool: 'fs_read',
        ok: true, inputPreview: '{"path":"合同.docx"}', goalPreview: '读取合同',
      });
    }
    expect(svc.observationsSinceLastDistill()).toBe(12);
  });

  it('蒸馏：新建 0.3 → 相似触发再蒸馏 +0.1（会话去重累计）', async () => {
    const svc = new HabitService(dir);
    for (let i = 0; i < 12; i++) {
      svc.observe({ runId: `r${i}`, sessionId: 's1', agentId: 'main', tool: 'fs_read', ok: true, inputPreview: '{"path":"a.docx"}', goalPreview: '读 Word 文件' });
    }
    const r1 = await svc.distill(fakeLlm, 's1');
    expect(r1.created).toBe(1);
    const h1 = svc.list()[0];
    expect(h1.confidence).toBeCloseTo(0.3);
    expect(h1.sessions).toEqual(['s1']);

    // 再次蒸馏（相似触发的措辞变化也算同一习惯）
    for (let i = 0; i < 12; i++) {
      svc.observe({ runId: `r2-${i}`, sessionId: 's2', agentId: 'main', tool: 'docx_read', ok: true, inputPreview: '{"path":"b.docx"}', goalPreview: '读 Word 文档' });
    }
    const r2 = await svc.distill(fakeLlm, 's2');
    expect(r2.reinforced).toBe(1);
    const h2 = svc.list()[0];
    expect(h2.confidence).toBeCloseTo(0.4);
    expect(h2.sessions).toEqual(['s1', 's2']);
    // 蒸馏后计数清零
    expect(svc.observationsSinceLastDistill()).toBe(0);
  });

  it('晋升守卫：单会话不够；置信度≥0.8 且 ≥2 会话才可晋升，产物是合法技能目录', async () => {
    const svc = new HabitService(dir);
    for (let i = 0; i < 12; i++) {
      svc.observe({ runId: `r${i}`, sessionId: 's1', agentId: 'main', tool: 'fs_read', ok: true, inputPreview: '{"path":"a.docx"}', goalPreview: '读 Word' });
    }
    await svc.distill(fakeLlm, 's1');
    const h = svc.list()[0];
    expect(svc.promotionReady(h)).toBe(false); // 0.3 单会话

    // 拉满：跨会话多次强化到 0.8
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 12; i++) {
        svc.observe({ runId: `r${round}-${i}`, sessionId: `s${round + 2}`, agentId: 'main', tool: 'docx_read', ok: true, inputPreview: '{}', goalPreview: '读 Word' });
      }
      await svc.distill(fakeLlm, `s${round + 2}`);
    }
    const grown = svc.list()[0];
    expect(grown.confidence).toBeGreaterThanOrEqual(0.8);
    expect(svc.promotionReady(grown)).toBe(true);

    const skillsDir = join(dir, 'skills');
    const { writeSkillAtomic } = await import('../../skill-runtime/skill-writer.js');
    const out = svc.promote(grown.id, skillsDir, { write: (d, n, p, o) => writeSkillAtomic(d, n, p, o) });
    expect(existsSync(join(skillsDir, out.skillName, 'SKILL.md'))).toBe(true);
    const md = readFileSync(join(skillsDir, out.skillName, 'SKILL.md'), 'utf-8');
    expect(md).toContain('docx_read');
    expect(md).toContain('execution_mode');
    // 已晋升的习惯不再参与晋升
    expect(svc.promotionReady(svc.get(grown.id)!)).toBe(false);
  });

  it('用户否决（adjustConfidence 负向）可把习惯压回不注入区', async () => {
    const svc = new HabitService(dir);
    for (let i = 0; i < 12; i++) {
      svc.observe({ runId: `r${i}`, sessionId: 's1', agentId: 'main', tool: 'x', ok: true, inputPreview: '{}', goalPreview: 'g' });
    }
    await svc.distill(fakeLlm, 's1');
    const h = svc.list()[0];
    const adjusted = svc.adjustConfidence(h.id, -0.2)!;
    expect(adjusted.confidence).toBeCloseTo(0.1);
    expect(svc.toPromptText()).toBe(''); // 0.1 远低于 0.7 注入线
  });

  it('注入文本只含 ≥0.7 的习惯且最多 5 条', async () => {
    const svc = new HabitService(dir);
    // 直接构造 habits.json
    mkdirSync(join(dir, 'habits'), { recursive: true });
    const mk = (id: string, conf: number) => ({
      id, trigger: `t-${id}`, action: `a-${id}`, confidence: conf, sessions: ['s1', 's2'], evidence: [], createdAt: '', updatedAt: new Date().toISOString(),
    });
    writeFileSync(
      join(dir, 'habits', 'habits.json'),
      JSON.stringify({ habits: [mk('a', 0.9), mk('b', 0.75), mk('c', 0.69), mk('d', 0.71), mk('e', 0.8), mk('f', 0.72), mk('g', 0.95), mk('h', 0.7)], meta: {} }),
      'utf-8'
    );
    const text = svc.toPromptText();
    expect(text).toContain('t-g'); // 0.95 最高
    expect(text).toContain('t-a');
    expect(text).not.toContain('t-c'); // 0.69 不注入
    // 最多 5 条
    const count = (text.match(/^- /gm) ?? []).length;
    expect(count).toBe(5);
  });
});
