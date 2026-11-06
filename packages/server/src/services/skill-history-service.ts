import { existsSync, readFileSync, readdirSync, copyFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, statSync } from 'fs';
import { join, resolve, basename } from 'path';
import { unifiedDiff } from '../tools/diff.js';

/**
 * 技能版本历史与回滚 — 演化提议"接受"之后的安全网：
 *  · listHistory：`.history/` 内每个历史版本 + 与当前 SKILL.md 的 unified diff
 *    （用户接受修订前能看"改了什么"，接受后随时能看"当时改了什么"）
 *  · rollback：恢复指定历史版本；当前版本先备份进 `.history/`（回滚本身可回滚）
 * 历史来源：演化管线接受时的自动备份、手动回滚时的当前版备份、技能包 --overwrite 替换备份。
 */

export interface SkillVersion {
  file: string;          // .history 内的文件名
  mtime: string;
  content: string;
  /** 与当前 SKILL.md 的 unified diff（- 旧 + 新） */
  diff: string;
}

const MAX_VERSIONS = 30;

export function listHistory(skillsDir: string, skillName: string): { versions: SkillVersion[]; current: string } {
  const skillDir = resolve(skillsDir, skillName);
  const currentPath = join(skillDir, 'SKILL.md');
  const current = existsSync(currentPath) ? readFileSync(currentPath, 'utf-8') : '';
  const histDir = join(skillDir, '.history');
  const versions: SkillVersion[] = [];
  if (existsSync(histDir)) {
    const files = readdirSync(histDir)
      .filter(f => f.endsWith('.md'))
      .sort((a, b) => statSync(join(histDir, b)).mtimeMs - statSync(join(histDir, a)).mtimeMs)
      .slice(0, MAX_VERSIONS);
    for (const f of files) {
      const content = readFileSync(join(histDir, f), 'utf-8');
      // diff 语义：历史版本 → 当前内容（"+" 行即"当前比那个版本多出/改成的样子"）
      const diff = unifiedDiff(content, current, `SKILL.md (${f} → current)`, 3);
      versions.push({
        file: f,
        mtime: new Date(statSync(join(histDir, f)).mtimeMs).toISOString(),
        content,
        diff: diff || '(与当前版本无差异)',
      });
    }
  }
  return { versions, current };
}

export function rollback(skillsDir: string, skillName: string, historyFile: string): { ok: true; restoredFrom: string; backedUpAs: string } | { ok: false; error: string } {
  const skillDir = resolve(skillsDir, skillName);
  const currentPath = join(skillDir, 'SKILL.md');
  const histDir = join(skillDir, '.history');
  const src = join(histDir, basename(historyFile));
  // 只允许 .history 内的 .md 文件（防路径穿越）
  if (!basename(historyFile).endsWith('.md') || !existsSync(src)) {
    return { ok: false, error: `历史版本不存在: ${historyFile}` };
  }
  const restoring = readFileSync(src, 'utf-8');
  // 当前版本先备份（回滚可回滚）
  let backedUpAs = '';
  mkdirSync(histDir, { recursive: true });
  if (existsSync(currentPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backedUpAs = `pre-rollback-${stamp}.md`;
    copyFileSync(currentPath, join(histDir, backedUpAs));
  }
  writeFileSync(currentPath, restoring, 'utf-8');
  return { ok: true, restoredFrom: basename(historyFile), backedUpAs };
}
