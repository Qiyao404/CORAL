import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import matter from 'gray-matter';
import {
  validateSkillName,
  buildSkillMd,
  writeSkillAtomic,
  moveToTrash,
  SkillExistsError,
  SkillNameInvalidError,
  PathTraversalError,
} from '../skill-writer.js';

const tmp = mkdtempSync(join(tmpdir(), 'coral-writer-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function payload(name = 'my-skill') {
  return {
    frontmatter: {
      name,
      version: '1.0.0',
      description: '测试技能',
      execution_mode: 'llm_only',
    },
    promptContent: '# 我的技能\n\n你是一个专家。',
  };
}

describe('validateSkillName — kebab-case 与路径穿越守卫（M0-7）', () => {
  it('合法名称通过', () => {
    expect(() => validateSkillName('my-skill')).not.toThrow();
    expect(() => validateSkillName('a1')).not.toThrow();
    expect(() => validateSkillName('policy-scraper-2')).not.toThrow();
  });

  it('非法格式 → SkillNameInvalidError', () => {
    const cases = ['', 'A-UP', 'Upper', 'has_underscore', 'has space', '-start-dash', 'x', 'a'.repeat(50)];
    for (const name of cases) {
      expect(() => validateSkillName(name), `name="${name}"`).toThrow(SkillNameInvalidError);
    }
  });

  it('路径穿越攻击 → PathTraversalError', () => {
    for (const evil of ['../etc', 'a/b', 'a\\b', '..', '/abs/path', 'C:\\abs', 'my..skill']) {
      expect(() => validateSkillName(evil), `name="${evil}"`).toThrow(PathTraversalError);
    }
  });
});

describe('buildSkillMd / writeSkillAtomic — 落盘与回读', () => {
  it('buildSkillMd 产出可被 gray-matter 解析回的 SKILL.md', () => {
    const p = payload();
    const md = buildSkillMd(p);
    expect(md.startsWith('---')).toBe(true);

    const parsed = matter(md);
    expect(parsed.data.name).toBe('my-skill');
    expect(parsed.data.execution_mode).toBe('llm_only');
    expect(parsed.content.trim().startsWith('# 我的技能')).toBe(true);
  });

  it('缺必填字段 → 抛错不落盘', () => {
    expect(() => buildSkillMd({ frontmatter: { name: 'x' }, promptContent: 'p' })).toThrow(/必填/);
  });

  it('写入新技能 → 目录与文件存在；重名不覆盖 → SkillExistsError', () => {
    const dir = writeSkillAtomic(tmp, 'fresh-skill', payload('fresh-skill'));
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);

    expect(() => writeSkillAtomic(tmp, 'fresh-skill', payload('fresh-skill'))).toThrow(SkillExistsError);
  });

  it('overwrite: true → 替换并自动备份旧版到 skills/.history/<name>/<ts>/（目标目录之外）', () => {
    const dir = join(tmp, 'fresh-skill');
    const original = readFileSync(join(dir, 'SKILL.md'), 'utf-8');

    writeSkillAtomic(tmp, 'fresh-skill', { ...payload('fresh-skill'), promptContent: '# v2 内容' }, { overwrite: true });

    const updated = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
    expect(updated).not.toBe(original);
    expect(updated).toContain('# v2 内容');

    // v1 bug 修复验证：备份在目标目录之外的集中 .history 下，且不会被随后的目录替换删除
    const historyRoot = join(tmp, '.history', 'fresh-skill');
    expect(existsSync(historyRoot)).toBe(true);
    const tsDirs = readdirSync(historyRoot);
    expect(tsDirs.length).toBeGreaterThan(0);
    const backup = readFileSync(join(historyRoot, tsDirs[0], 'SKILL.md'), 'utf-8');
    expect(backup).toBe(original); // 备份的正是被替换前的版本
    // 技能目录内不再有 .history（避免触发 watcher）
    expect(existsSync(join(dir, '.history'))).toBe(false);
  });

  it('脚本模式同时落盘 scripts/ 入口', () => {
    const dir = writeSkillAtomic(tmp, 'scripted-skill', {
      frontmatter: {
        name: 'scripted-skill',
        version: '1.0.0',
        description: 'd',
        execution_mode: 'script',
      },
      promptContent: 'p',
      scriptContent: 'print("hi")',
      scriptEntry: 'scripts/main.py',
    });
    expect(existsSync(join(dir, 'scripts', 'main.py'))).toBe(true);
  });

  it('非法脚本入口路径（..）→ PathTraversalError', () => {
    expect(() =>
      writeSkillAtomic(tmp, 'evil-entry', {
        ...payload('evil-entry'),
        scriptContent: 'x',
        scriptEntry: '../evil.py',
      })
    ).toThrow(PathTraversalError);
  });
});

describe('moveToTrash — 物理删除走回收站', () => {
  it('目录被移动到 .trash/<name>-<ts>/ 下，原位置消失', () => {
    writeSkillAtomic(tmp, 'trash-me', payload('trash-me'));
    const trashedTo = moveToTrash(tmp, 'trash-me');

    expect(existsSync(join(tmp, 'trash-me'))).toBe(false);
    expect(trashedTo).toContain(join(tmp, '.trash'));
    expect(existsSync(trashedTo)).toBe(true);
  });

  it('不存在的技能 → 抛错', () => {
    expect(() => moveToTrash(tmp, 'never-exists')).toThrow(/不存在/);
  });
});
