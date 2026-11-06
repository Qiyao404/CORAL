import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listHistory, rollback } from '../../services/skill-history-service.js';

/** 技能版本历史与回滚（演化提议的安全网） */

let skillsDir: string;
beforeEach(() => {
  skillsDir = mkdtempSync(join(tmpdir(), 'coral-skillhist-'));
  mkdirSync(join(skillsDir, 'demo-skill', '.history'), { recursive: true });
});
afterEach(() => rmSync(skillsDir, { recursive: true, force: true }));

describe('listHistory', () => {
  it('按时间倒序列出版本，diff 与当前内容对照（- 旧 + 新）', () => {
    writeFileSync(join(skillsDir, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\n---\n\nv2 内容', 'utf-8');
    writeFileSync(join(skillsDir, 'demo-skill', '.history', 'a.md'), '---\nname: demo-skill\n---\n\nv1 内容', 'utf-8');
    const { versions, current } = listHistory(skillsDir, 'demo-skill');
    expect(current).toContain('v2 内容');
    expect(versions.length).toBe(1);
    expect(versions[0].diff).toContain('-v1 内容');
    expect(versions[0].diff).toContain('+v2 内容');
  });

  it('无历史时返回空列表不报错', () => {
    writeFileSync(join(skillsDir, 'demo-skill', 'SKILL.md'), 'x', 'utf-8');
    rmSync(join(skillsDir, 'demo-skill', '.history'), { recursive: true });
    const { versions } = listHistory(skillsDir, 'demo-skill');
    expect(versions).toHaveLength(0);
  });
});

describe('rollback', () => {
  it('恢复指定版本；当前版本自动备份（回滚可回滚）；路径穿越被拒', () => {
    writeFileSync(join(skillsDir, 'demo-skill', 'SKILL.md'), '当前=v2', 'utf-8');
    writeFileSync(join(skillsDir, 'demo-skill', '.history', 'v1.md'), '旧=v1', 'utf-8');

    const r = rollback(skillsDir, 'demo-skill', 'v1.md');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.backedUpAs).toMatch(/^pre-rollback-/);
    expect(readFileSync(join(skillsDir, 'demo-skill', 'SKILL.md'), 'utf-8')).toBe('旧=v1');
    // 当前版（v2）已入历史 → 再次回滚可恢复
    const again = rollback(skillsDir, 'demo-skill', r.ok ? r.backedUpAs : '');
    expect(again.ok).toBe(true);
    expect(readFileSync(join(skillsDir, 'demo-skill', 'SKILL.md'), 'utf-8')).toBe('当前=v2');

    // 路径穿越/不存在：拒绝
    const bad = rollback(skillsDir, 'demo-skill', '../outside.md');
    expect(bad.ok).toBe(false);
    expect(existsSync(join(skillsDir, 'outside.md'))).toBe(false);
  });
});
