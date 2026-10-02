import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import matter from 'gray-matter';
import { importSkills, parseGitSource } from '../skill-importer.js';
import { parseSkillMd } from '../skill-resolver.js';

const tmp = mkdtempSync(join(tmpdir(), 'coral-import-'));
const srcRoot = join(tmp, 'src');
const skillsRoot = join(tmp, 'skills');
beforeAll(() => {
  mkdirSync(join(skillsRoot), { recursive: true });

  // Anthropic 标准格式：只有 name/description + 正文 + 附属文件
  const d1 = join(srcRoot, 'pdf-form-filler');
  mkdirSync(join(d1, 'scripts'), { recursive: true });
  writeFileSync(join(d1, 'SKILL.md'), [
    '---',
    'name: pdf-form-filler',
    'description: >-',
    '  Fill PDF forms automatically by detecting form fields and matching them',
    '  to provided data. Use when the user needs to complete PDF documents.',
    'allowed-content:',
    '  - read',
    'disable-model-invocation: false',
    '---',
    '',
    '# PDF Form Filler',
    '',
    'Detect form fields, then fill them.',
    'Reference: [field map](reference.md)',
  ].join('\n'), 'utf-8');
  writeFileSync(join(d1, 'reference.md'), '# 字段映射说明', 'utf-8');
  writeFileSync(join(d1, 'scripts', 'fill.mjs'), 'export {};', 'utf-8');

  // CORAL 原生格式（script 模式透传）
  const d2 = join(srcRoot, 'my-coral-skill');
  mkdirSync(d2, { recursive: true });
  writeFileSync(join(d2, 'SKILL.md'), [
    '---',
    'name: my-coral-skill',
    'version: "2.1.0"',
    'description: "原生格式"',
    'execution_mode: script',
    'script_entry: scripts/main.mjs',
    'script_runtime: node',
    'script_timeout_ms: 15000',
    'input_schema:',
    '  type: object',
    '  required: [x]',
    '  properties:',
    '    x: { type: string }',
    '---',
    '',
    '# native',
  ].join('\n'), 'utf-8');

  // 缺 description（应失败）
  const d3 = join(srcRoot, 'no-desc');
  mkdirSync(d3, { recursive: true });
  writeFileSync(join(d3, 'SKILL.md'), '---\nname: no-desc\n---\n\nbody', 'utf-8');

  // 非法名（应 slugify）
  const d4 = join(srcRoot, 'Bad_Skill_Name');
  mkdirSync(d4, { recursive: true });
  writeFileSync(join(d4, 'SKILL.md'), '---\nname: Bad_Skill_Name\ndescription: "名字不规范"\n---\n\nbody', 'utf-8');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('parseGitSource — git 源解析（M1-6，离线）', () => {
  it('GitHub tree 子路径 URL → 仓库 + ref + 子路径', () => {
    const r = parseGitSource('https://github.com/anthropics/skills/tree/main/document-skills/pdf')!;
    expect(r.repoUrl).toBe('https://github.com/anthropics/skills.git');
    expect(r.ref).toBe('main');
    expect(r.subPath).toBe('document-skills/pdf');
  });

  it('blob URL / 仓库根 / SSH 形式', () => {
    const blob = parseGitSource('https://github.com/a/b/blob/v1.2/path/to/s')!;
    expect(blob.ref).toBe('v1.2');
    expect(blob.subPath).toBe('path/to/s');

    const root = parseGitSource('https://github.com/anthropics/skills')!;
    expect(root.repoUrl).toBe('https://github.com/anthropics/skills.git');
    expect(root.subPath).toBe('');

    const ssh = parseGitSource('git@github.com:anthropics/skills.git')!;
    expect(ssh.repoUrl).toBe('git@github.com:anthropics/skills.git');

    expect(parseGitSource('D:/some/local/dir')).toBeNull();
    expect(parseGitSource('not a url at all')).toBeNull();
  });
});

describe('importSkills — Anthropic Agent Skills 导入（M1-6）', () => {
  it('父目录多技能扫描：全部导入并给出映射与警告', async () => {
    const reports = await importSkills(srcRoot, { skillsDir: skillsRoot });
    const byName = new Map(reports.map(r => [r.skillName, r]));

    // pdf-form-filler：Anthropic → llm_only 映射 + scripts/ 警告 + 未知字段保留
    const r1 = byName.get('pdf-form-filler')!;
    expect(r1.status).toBe('imported');
    expect(r1.mapped!.executionMode).toBe('llm_only');
    expect(r1.mapped!.version).toBe('1.0.0');
    expect(r1.copiedFiles).toContain('reference.md');
    expect(r1.copiedFiles).toContain('scripts/fill.mjs');
    expect(r1.warnings.join('\n')).toContain('llm_only');
    expect(r1.warnings.join('\n')).toContain('scripts/');
    expect(r1.warnings.join('\n')).toContain('allowed-content');

    // 落盘的 SKILL.md 可被 CORAL 解析器读取，未知字段保留、正文完整
    const manifest = parseSkillMd(join(skillsRoot, 'pdf-form-filler'))!;
    expect(manifest.executionMode).toBe('llm_only');
    expect(manifest.source).toBe('user');
    expect(manifest.tags).toEqual(['imported']);
    expect(manifest.promptContent).toContain('Detect form fields');
    const rawFm = matter(readFileSync(join(skillsRoot, 'pdf-form-filler', 'SKILL.md'), 'utf-8')).data;
    expect(rawFm['allowed-content']).toEqual(['read']);
    expect(rawFm.imported_at).toBeTruthy();

    // my-coral-skill：原生格式完全透传
    const r2 = byName.get('my-coral-skill')!;
    expect(r2.status).toBe('imported');
    expect(r2.mapped!.executionMode).toBe('script');
    expect(r2.mapped!.version).toBe('2.1.0');
    const m2 = parseSkillMd(join(skillsRoot, 'my-coral-skill'))!;
    expect(m2.scriptEntry).toBe('scripts/main.mjs');
    expect(m2.scriptTimeoutMs).toBe(15000);

    // no-desc：失败并说明原因
    expect(byName.get('(null)')?.status ?? byName.get(null as any)?.status, 'no-desc 应失败').toBeDefined();
    const failed = reports.find(r => r.status === 'failed')!;
    expect(failed.error).toContain('description');

    // Bad_Skill_Name → slugify 重命名 + 警告
    const r4 = byName.get('bad-skill-name')!;
    expect(r4.status).toBe('imported');
    expect(r4.warnings.join('\n')).toContain('重命名');
  });

  it('同名冲突：默认 skipped；overwrite 后替换且旧版进 .history', async () => {
    const first = await importSkills(join(srcRoot, 'pdf-form-filler'), { skillsDir: skillsRoot });
    expect(first[0].status).toBe('skipped');

    // 手动改一下源描述，覆盖导入后应生效，旧版备份存在
    const conflictSrc = join(tmp, 'conflict-src', 'pdf-form-filler');
    mkdirSync(conflictSrc, { recursive: true });
    writeFileSync(join(conflictSrc, 'SKILL.md'), '---\nname: pdf-form-filler\ndescription: "新版描述"\n---\n\nnew body', 'utf-8');
    const second = await importSkills(join(tmp, 'conflict-src'), { skillsDir: skillsRoot, overwrite: true });
    expect(second[0].status).toBe('imported');
    const m = parseSkillMd(join(skillsRoot, 'pdf-form-filler'))!;
    expect(m.description).toBe('新版描述');
    expect(existsSync(join(skillsRoot, '.history', 'pdf-form-filler'))).toBe(true);
  });

  it('源不存在 / 无 SKILL.md → 失败报告', async () => {
    const nope = await importSkills(join(tmp, 'ghost'), { skillsDir: skillsRoot });
    expect(nope[0].status).toBe('failed');
    expect(nope[0].error).toContain('不存在');

    const empty = mkdtempSync(join(tmpdir(), 'coral-empty-'));
    const noSkill = await importSkills(empty, { skillsDir: skillsRoot });
    expect(noSkill[0].status).toBe('failed');
    expect(noSkill[0].error).toContain('SKILL.md');
    rmSync(empty, { recursive: true, force: true });
  });

  it('.git/node_modules/__pycache__ 等目录不迁移', async () => {
    const src = join(tmp, 'dirty-src', 'clean-skill');
    mkdirSync(join(src, '.git', 'objects'), { recursive: true });
    mkdirSync(join(src, '__pycache__'), { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), '---\nname: clean-skill\ndescription: "d"\n---\n\nb', 'utf-8');
    writeFileSync(join(src, '.git', 'objects', 'x'), 'git internal', 'utf-8');
    writeFileSync(join(src, '__pycache__', 'x.pyc'), 'pyc', 'utf-8');
    writeFileSync(join(src, 'keep.txt'), 'keep', 'utf-8');

    const [report] = await importSkills(src, { skillsDir: skillsRoot });
    expect(report.status).toBe('imported');
    expect(report.copiedFiles).toEqual(['keep.txt']);
    expect(existsSync(join(skillsRoot, 'clean-skill', '.git'))).toBe(false);
    expect(existsSync(join(skillsRoot, 'clean-skill', '__pycache__'))).toBe(false);
  });
});
