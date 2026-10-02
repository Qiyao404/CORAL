import { isAbsolute, resolve, sep, dirname } from 'path';
import { existsSync, realpathSync } from 'fs';

/**
 * M1-2：workspace 路径守卫 — fs 类工具的根边界（V2_PLAN D11-D12 的安全件）。
 *
 * 三层防护：
 *  1. 未绑定工作区 → NO_WORKSPACE
 *  2. 词法穿越：解析后必须落在 workspaceDir 内（分隔符边界，防同前缀兄弟目录）
 *  3. 符号链接逃逸：已存在路径取 realpath 后必须仍在真实 workspace 根内；
 *     写入不存在的文件时，向上找最近的已存在祖先做同样检查（防经目录软链逃逸）
 */

export type WorkspacePathResult =
  | { ok: true; absPath: string }
  | { ok: false; code: 'NO_WORKSPACE' | 'PATH_ESCAPE' | 'SYMLINK_ESCAPE'; message: string };

export function resolveWorkspacePath(
  workspaceDir: string | undefined,
  relPath: string
): WorkspacePathResult {
  if (!workspaceDir) {
    return { ok: false, code: 'NO_WORKSPACE', message: '未绑定工作区（workspace）— fs 工具不可用' };
  }

  const raw = String(relPath ?? '');
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(workspaceDir, raw || '.');

  // 词法边界（分隔符边界，不允许恰好等于根之外的兄弟前缀）
  const root = resolve(workspaceDir);
  if (abs !== root && !abs.startsWith(root + sep)) {
    return { ok: false, code: 'PATH_ESCAPE', message: `路径越出工作区边界: ${raw}` };
  }

  // 符号链接边界：文件本身或最近已存在祖先的 realpath 必须在真实根内
  const realRoot = realPathOrNull(root);
  const checkFrom = existsSync(abs) ? abs : nearestExistingAncestor(abs);
  const realCheck = realPathOrNull(checkFrom);
  if (realRoot && realCheck && !isInside(realCheck, realRoot)) {
    return { ok: false, code: 'SYMLINK_ESCAPE', message: `符号链接越出工作区边界: ${raw}` };
  }

  return { ok: true, absPath: abs };
}

function realPathOrNull(p: string): string | null {
  try {
    return realpathSync(resolve(p));
  } catch {
    return null;
  }
}

function nearestExistingAncestor(p: string): string {
  let dir = dirname(resolve(p));
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}
