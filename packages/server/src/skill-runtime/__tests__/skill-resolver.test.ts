import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseSkillMd } from '../skill-resolver.js';

const tmp = mkdtempSync(join(tmpdir(), 'coral-resolver-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function writeSkill(name: string, frontmatter: string, body = '# prompt\n\n正文。', reference?: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf-8');
  if (reference !== undefined) writeFileSync(join(dir, 'reference.md'), reference, 'utf-8');
  return dir;
}

describe('parseSkillMd — SKILL.md 解析（M0-7）', () => {
  it('完整 frontmatter → 全字段映射（snake_case → camelCase）', () => {
    const dir = writeSkill('full-skill', [
      'name: full-skill',
      'version: "1.2.0"',
      'description: "完整技能"',
      'domain: data-processing',
      'capabilities:',
      '  - web_scraping',
      '  - table_extraction',
      'input_schema:',
      '  type: object',
      '  required: [url]',
      '  properties:',
      '    url: { type: string }',
      'output_schema:',
      '  type: object',
      '  properties:',
      '    tables: { type: array }',
      'execution_mode: script',
      'script_entry: scripts/main.py',
      'script_runtime: python3',
      'script_timeout_ms: 45000',
      'human_gate: true',
      'estimated_duration_ms: 9000',
      'cost_level: medium',
      'status: experimental',
      'tags: [采集, 表格]',
      'source: user',
      'consumes_company_profile: true',
      'empty_when:',
      '  - { field: count, op: eq, value: 0 }',
      'default:',
      '  month: 3',
      'input_keys: [year, month, sites]',
    ].join('\n'), '# full\n\nprompt body', '参考资料内容');

    const m = parseSkillMd(dir)!;
    expect(m).not.toBeNull();
    expect(m.name).toBe('full-skill');
    expect(m.version).toBe('1.2.0');
    expect(m.capabilities).toEqual(['web_scraping', 'table_extraction']);
    expect(m.inputSchema.required).toEqual(['url']);
    expect(m.executionMode).toBe('script');
    expect(m.scriptEntry).toBe('scripts/main.py');
    expect(m.scriptRuntime).toBe('python3');
    expect(m.scriptTimeoutMs).toBe(45000);
    expect(m.humanGate).toBe(true);
    expect(m.estimatedDurationMs).toBe(9000);
    expect(m.costLevel).toBe('medium');
    expect(m.status).toBe('experimental');
    expect(m.tags).toEqual(['采集', '表格']);
    expect(m.source).toBe('user');
    expect(m.consumesCompanyProfile).toBe(true);
    expect(m.emptyWhen).toEqual([{ field: 'count', op: 'eq', value: 0 }]);
    expect(m.defaultInput).toEqual({ month: 3 });
    expect(m.inputKeys).toEqual(['year', 'month', 'sites']);
    expect(m.promptContent.startsWith('# full')).toBe(true);
    expect(m.referenceContent).toBe('参考资料内容');
    expect(m.fileHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('缺必填字段（name/version/description/execution_mode 任一）→ null', () => {
    const noMode = writeSkill('no-mode', ['name: x', 'version: "1.0.0"', 'description: "d"'].join('\n'));
    expect(parseSkillMd(noMode)).toBeNull();

    const noName = writeSkill('no-name', ['version: "1.0.0"', 'description: "d"', 'execution_mode: llm_only'].join('\n'));
    expect(parseSkillMd(noName)).toBeNull();
  });

  it('v1.0.0 兼容：无 source 字段 → builtin；可选字段有缺省', () => {
    const dir = writeSkill('legacy-skill', [
      'name: legacy-skill',
      'version: "1.0.0"',
      'description: "旧技能"',
      'execution_mode: llm_only',
    ].join('\n'));

    const m = parseSkillMd(dir)!;
    expect(m.source).toBe('builtin');
    expect(m.domain).toBe('general');
    expect(m.capabilities).toEqual([]);
    expect(m.costLevel).toBe('low');
    expect(m.status).toBe('stable');
    expect(m.humanGate).toBe(false);
    expect(m.referenceContent).toBeUndefined();
    expect(m.emptyWhen).toBeUndefined();
    expect(m.defaultInput).toBeUndefined();
  });

  it('目录无 SKILL.md → null', () => {
    const dir = join(tmp, 'empty-dir');
    mkdirSync(dir, { recursive: true });
    expect(parseSkillMd(dir)).toBeNull();
  });

  it('fileHash 随内容变化（用于热重载去重）', () => {
    const dir = writeSkill('hash-skill', ['name: hash-skill', 'version: "1.0.0"', 'description: "h"', 'execution_mode: llm_only'].join('\n'));
    const h1 = parseSkillMd(dir)!.fileHash;
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: hash-skill\nversion: "1.0.1"\ndescription: "h"\nexecution_mode: llm_only\n---\n\nchanged\n', 'utf-8');
    const h2 = parseSkillMd(dir)!.fileHash;
    expect(h1).not.toBe(h2);
  });
});
