import { describe, it, expect } from 'vitest';
import { resolveArtifactPath } from '../artifact-path.js';

describe('resolveArtifactPath — 产物路径校验（P1-1 前缀穿越修复）', () => {
  const base = '/w/skills/my-skill';

  it('相对路径 → join 到技能目录下', () => {
    const r = resolveArtifactPath(base, 'output/report.md')!;
    expect(r).toContain('my-skill');
    expect(r).toContain('output');
    expect(r).not.toBe('output/report.md'); // 不是原样放行
  });

  it('位于 base 内的绝对路径 → 放行', () => {
    const r = resolveArtifactPath(base, '/w/skills/my-skill/output/data.csv');
    expect(r).toBe('/w/skills/my-skill/output/data.csv');
  });

  it('同前缀兄弟目录攻击被阻断（/w/skills/my-skill2 ≠ /w/skills/my-skill）', () => {
    const attack = '/w/skills/my-skill2/secret.md';
    const r = resolveArtifactPath(base, attack)!;
    const norm = r.replace(/\\/g, '/');
    // 结果必须回退为 join(base, attack)，绝不能原样放行攻击目标
    expect(norm).not.toBe(attack);
    expect(norm.startsWith(base + '/')).toBe(true);
  });

  it('前缀以分隔符结尾的 base 也正确处理', () => {
    const r = resolveArtifactPath('/w/skills/my-skill/', '/w/skills/my-skill2/x');
    expect(r!.replace(/\\/g, '/')).not.toBe('/w/skills/my-skill2/x');
  });

  it('含 .. 的路径 → null（无论相对还是绝对）', () => {
    expect(resolveArtifactPath(base, '../../etc/passwd')).toBeNull();
    expect(resolveArtifactPath(base, '/w/skills/../secret')).toBeNull();
    expect(resolveArtifactPath(base, 'a\\..\\..\\b')).toBeNull();
  });

  it('空路径 → null', () => {
    expect(resolveArtifactPath(base, '')).toBeNull();
  });

  it('base 之外的绝对路径 → 回退为 join（不存在，最终被 existsSync 拒绝）', () => {
    const r = resolveArtifactPath(base, '/etc/passwd')!;
    const norm = r.replace(/\\/g, '/');
    expect(norm).not.toBe('/etc/passwd');
    expect(norm.startsWith(base + '/')).toBe(true);
  });
});
