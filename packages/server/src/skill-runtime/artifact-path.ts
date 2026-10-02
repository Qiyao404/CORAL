import { join } from 'path';

/**
 * M0 后安全修复（P1-1）：artifact 下载路径的校验与解析。
 *
 * 修复内容：v1 原实现用 `startsWith(skillDirPath)` 做前缀判断，存在「同前缀兄弟目录」
 * 穿越漏洞 —— base 为 /skills/foo 时，/skills/foo-bar/x 也能通过前缀检查。
 * 现要求前缀匹配后必须紧跟路径分隔符；其余一律回退为 join(base, query)，
 * 不存在的路径最终由 existsSync 拒绝。
 *
 * @returns 可读文件路径；queryPath 含 `..` 或为空时返回 null（调用方返回 400）
 */
export function resolveArtifactPath(skillDirPath: string, queryPath: string): string | null {
  const normalized = String(queryPath).replace(/\\/g, '/');
  if (!normalized || normalized.includes('..')) return null;

  const base = skillDirPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const candidate = normalized.startsWith(base + '/')
    ? normalized
    : join(skillDirPath, normalized);
  return candidate;
}
