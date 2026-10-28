import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigGcService } from '../config-gc-service.js';

let dataDir: string;
let skillsDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'coral-gc-data-'));
  skillsDir = mkdtempSync(join(tmpdir(), 'coral-gc-skills-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(skillsDir, { recursive: true, force: true });
});

const storeWith = (sessionIds: string[]) => ({
  list: (opts: { sessionId?: string; limit: number }) =>
    ({ items: sessionIds.includes(opts.sessionId ?? '') ? [{ id: 'run-x', sessionId: opts.sessionId }] : [] }),
});

describe('ConfigGcService — 扫描与软删除', () => {
  it('scan 识别四类目标：过期证据/孤儿会话/损坏技能/回收站膨胀', () => {
    // 过期证据（mtime 拨回 30 天前）
    mkdirSync(join(dataDir, 'evidence', 'run-old'), { recursive: true });
    writeFileSync(join(dataDir, 'evidence', 'run-old', 'ev-1.json'), '{}', 'utf-8');
    const old = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(join(dataDir, 'evidence', 'run-old'), old, old);
    // 新鲜证据（不扫）
    mkdirSync(join(dataDir, 'evidence', 'run-new'), { recursive: true });
    writeFileSync(join(dataDir, 'evidence', 'run-new', 'ev-2.json'), '{}', 'utf-8');
    // 孤儿会话 vs 存活会话
    mkdirSync(join(dataDir, 'sessions', 'orphan-1'), { recursive: true });
    writeFileSync(join(dataDir, 'sessions', 'orphan-1', 'context.json'), '{}', 'utf-8');
    mkdirSync(join(dataDir, 'sessions', 'alive-1'), { recursive: true });
    // 损坏技能：缺 frontmatter
    mkdirSync(join(skillsDir, 'broken-skill'), { recursive: true });
    writeFileSync(join(skillsDir, 'broken-skill', 'SKILL.md'), 'no frontmatter here', 'utf-8');
    // 正常技能（不扫）
    mkdirSync(join(skillsDir, 'good-skill'), { recursive: true });
    writeFileSync(join(skillsDir, 'good-skill', 'SKILL.md'), '---\nname: good-skill\ndescription: ok\n---\nbody', 'utf-8');
    // 回收站膨胀
    mkdirSync(join(skillsDir, '.trash'), { recursive: true });
    writeFileSync(join(skillsDir, '.trash', 'big.bin'), 'B'.repeat(51 * 1024 * 1024), 'utf-8');

    const svc = new ConfigGcService(dataDir, skillsDir, storeWith(['alive-1']));
    const { items } = svc.scan();
    const ids = items.map(i => i.id);
    expect(ids).toContain('evidence:run-old');
    expect(ids).not.toContain('evidence:run-new');
    expect(ids).toContain('session:orphan-1');
    expect(ids).not.toContain('session:alive-1');
    expect(ids).toContain('skill:broken-skill');
    expect(ids).not.toContain('skill:good-skill');
    expect(ids).toContain('trash:skills');
  });

  it('clean 只处理选中项：源移入回收站 + gc_log 可追溯 + 原路径消失', () => {
    mkdirSync(join(dataDir, 'sessions', 'orphan-2'), { recursive: true });
    writeFileSync(join(dataDir, 'sessions', 'orphan-2', 'context.json'), '{"decisions":[]}', 'utf-8');
    const svc = new ConfigGcService(dataDir, skillsDir, storeWith([]));

    const before = svc.scan();
    expect(before.items.map(i => i.id)).toContain('session:orphan-2');

    const r = svc.clean(['session:orphan-2', 'session:does-not-exist']);
    expect(r.cleaned).toHaveLength(1);
    expect(r.cleaned[0].id).toBe('session:orphan-2');
    expect(r.skipped).toHaveLength(1); // 不存在的 ID 跳过并说明原因
    expect(existsSync(join(dataDir, 'sessions', 'orphan-2'))).toBe(false);
    expect(r.cleaned[0].movedTo).toContain('.gc_trash');
    expect(existsSync(r.cleaned[0].movedTo)).toBe(true);

    const log = readFileSync(join(dataDir, '.gc_trash', 'gc_log.md'), 'utf-8');
    expect(log).toContain('session:orphan-2');
    expect(log).toContain('撤销');
  });

  it('每轮上限 20 条（GC 是周期性的，不是一次性的）', () => {
    for (let i = 0; i < 30; i++) {
      mkdirSync(join(dataDir, 'sessions', `o-${i}`), { recursive: true });
    }
    const svc = new ConfigGcService(dataDir, skillsDir, storeWith([]));
    const all = svc.scan().items.map(i => i.id);
    const r = svc.clean(all); // 传 30 个也只处理 20 个
    expect(r.cleaned.length).toBeLessThanOrEqual(20);
  });
});
