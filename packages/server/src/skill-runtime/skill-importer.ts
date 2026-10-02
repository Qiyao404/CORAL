import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, copyFileSync, writeFileSync, readFileSync, renameSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve, basename, relative } from 'path';
import matter from 'gray-matter';
import { validateSkillName } from './skill-writer.js';
import type { SkillSource } from '../types/index.js';

const execFileAsync = promisify(execFile);

/**
 * M1-6：Anthropic Agent Skills 格式导入器。
 *
 * 把标准 Agent Skills 目录（SKILL.md + 任意附属文件）导入 CORAL 技能库：
 *  · frontmatter 映射：Anthropic 只强制 name/description（提示词技能）→
 *    CORAL 必填 execution_mode 缺省映射为 llm_only；未知字段原样保留（向前兼容）
 *  · 附属文件（scripts/ / 参考文档 / 任何资源）完整迁移，目录原子换入（.history 备份）
 *  · 兼容性报告：映射结果 + 警告（scripts/ 未接线等）+ 冲突跳过/覆盖
 *  · 源：本地技能目录 / 含多个技能的父目录 / git URL（支持 GitHub tree 子路径）
 */

export interface ImportOptions {
  /** CORAL skills 根目录（目标） */
  skillsDir: string;
  /** 同名已存在时覆盖（旧版备份进 skills/.history/） */
  overwrite?: boolean;
}

export interface ImportReport {
  source: string;
  skillName: string | null;
  status: 'imported' | 'skipped' | 'failed';
  mapped?: {
    name: string;
    version: string;
    executionMode: string;
    descriptionPreview: string;
  };
  warnings: string[];
  copiedFiles: string[];
  error?: string;
}

const MAX_SKILLS_PER_IMPORT = 50;
const MAX_AUX_FILES = 200;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const SKIP_ENTRIES = new Set(['.git', 'node_modules', '__pycache__', '.history']);

// ─── git 源解析（离线可测） ───────────────────────────────────────────

export interface GitSource {
  repoUrl: string;
  /** tree/blob URL 里的 ref（分支/tag/commit）；空 = 默认分支 */
  ref: string;
  /** 仓库内子路径（空 = 仓库根） */
  subPath: string;
}

export function parseGitSource(url: string): GitSource | null {
  const trimmed = url.trim();
  // https://github.com/<owner>/<repo>/tree/<ref>/<path...>（blob 同理）
  const m = trimmed.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)\/?(.*)$/);
  if (m) {
    return {
      repoUrl: `https://${m[1]}/${m[2]}/${m[3]}.git`,
      ref: m[4],
      subPath: m[5].replace(/\/+$/, ''),
    };
  }
  // 仓库根（.git 后缀可选）
  if (/^https?:\/\/[^/]+\/[^/]+\/[^/]+?(?:\.git)?\/?$/.test(trimmed)) {
    return { repoUrl: trimmed.replace(/\/+$/, '').endsWith('.git') ? trimmed.replace(/\/+$/, '') : trimmed.replace(/\/+$/, '') + '.git', ref: '', subPath: '' };
  }
  if (/^git@[^:]+:[^/]+\/[^/]+\.git$/.test(trimmed)) {
    return { repoUrl: trimmed, ref: '', subPath: '' };
  }
  return null;
}

// ─── 主入口 ─────────────────────────────────────────────────────────

export async function importSkills(source: string, options: ImportOptions): Promise<ImportReport[]> {
  const git = parseGitSource(source);
  if (git && !existsSync(source)) {
    // git 源（本地同路径不存在时优先按 git 处理）
    return importFromGit(git, options, source);
  }
  const localPath = resolve(source);
  if (!existsSync(localPath)) {
    return [{
      source,
      skillName: null,
      status: 'failed',
      warnings: [],
      copiedFiles: [],
      error: `源不存在: ${source}`,
    }];
  }
  return importFromDir(localPath, options, source);
}

async function importFromGit(git: GitSource, options: ImportOptions, originalSource: string): Promise<ImportReport[]> {
  const tmp = mkdtempSync(join(tmpdir(), 'coral-import-'));
  try {
    const args = ['clone', '--depth', '1'];
    if (git.ref) args.push('--branch', git.ref);
    args.push(git.repoUrl, tmp);
    await execFileAsync('git', args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });

    const root = git.subPath ? join(tmp, git.subPath) : tmp;
    if (!existsSync(root)) {
      return [{
        source: originalSource,
        skillName: null,
        status: 'failed',
        warnings: [],
        copiedFiles: [],
        error: `仓库中不存在子路径: ${git.subPath}`,
      }];
    }
    return importFromDir(root, options, originalSource);
  } catch (err: any) {
    return [{
      source: originalSource,
      skillName: null,
      status: 'failed',
      warnings: [],
      copiedFiles: [],
      error: `git clone 失败: ${err?.message ?? err}（网络受限时可设置 HTTPS_PROXY 环境变量后重试）`,
    }];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 本地目录：自身是技能 → 单导入；否则扫描一级子目录（多技能） */
function importFromDir(dir: string, options: ImportOptions, originalSource: string): ImportReport[] {
  const skillDirs: Array<{ dir: string; sub: string }> = [];
  if (existsSync(join(dir, 'SKILL.md'))) {
    skillDirs.push({ dir, sub: '' });
  } else {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue;
      if (existsSync(join(dir, entry.name, 'SKILL.md'))) {
        skillDirs.push({ dir: join(dir, entry.name), sub: entry.name });
      }
      if (skillDirs.length >= MAX_SKILLS_PER_IMPORT) break;
    }
  }

  if (skillDirs.length === 0) {
    return [{
      source: originalSource,
      skillName: null,
      status: 'failed',
      warnings: [],
      copiedFiles: [],
      error: `未找到任何 SKILL.md（目录: ${dir}；父目录导入时技能须位于一级子目录）`,
    }];
  }
  return skillDirs.map(({ dir: d }) => importOne(d, options, originalSource));
}

// ─── 单技能导入 ─────────────────────────────────────────────────────

/** Anthropic / CORAL 通用字段 → CORAL frontmatter；未知字段原样保留 */
function mapFrontmatter(raw: Record<string, any>, dirName: string, report: ImportReport): Record<string, any> | null {
  const warnings = report.warnings;

  // name：frontmatter 优先，回退目录名；仍不合法 → 尝试 slugify
  let name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : dirName;
  try {
    validateSkillName(name);
  } catch {
    const slug = slugify(name);
    try {
      validateSkillName(slug);
      warnings.push(`技能名 "${name}" 不符合 kebab-case 规范，已重命名为 "${slug}"`);
      name = slug;
    } catch {
      report.error = `无法生成合法技能名（原始: ${name}，目录: ${dirName}）`;
      return null;
    }
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!description) {
    report.error = '缺少必填字段 description';
    return null;
  }

  // execution_mode：源是 CORAL 格式则透传；Anthropic 提示词技能 → llm_only
  let executionMode = raw.execution_mode;
  if (executionMode !== 'llm_only' && executionMode !== 'script' && executionMode !== 'hybrid') {
    executionMode = 'llm_only';
    if (!raw.execution_mode) {
      warnings.push('源未声明 execution_mode，已按 Anthropic 提示词技能惯例映射为 llm_only');
    } else {
      warnings.push(`源 execution_mode="${raw.execution_mode}" 不被识别，回落为 llm_only`);
    }
  }
  if (executionMode !== 'llm_only' && !raw.script_entry) {
    warnings.push(`execution_mode=${executionMode} 但缺少 script_entry，运行前需补全`);
  }

  // 保留源的全部未知字段（allowed-content / metadata / license / disable-model-invocation 等），
  // CORAL 解析器会忽略它们；known 集合只用于报告"映射了哪些"
  const known = new Set([
    'name', 'version', 'description', 'execution_mode', 'script_entry', 'script_runtime',
    'script_timeout_ms', 'domain', 'capabilities', 'input_schema', 'output_schema',
    'human_gate', 'estimated_duration_ms', 'cost_level', 'status', 'tags', 'source',
  ]);
  const preserved = Object.keys(raw).filter(k => !known.has(k));
  if (preserved.length > 0) {
    warnings.push(`保留源的自有字段（CORAL 当前不解析）: ${preserved.join(', ')}`);
  }

  const fm: Record<string, any> = { ...raw }; // 未知字段原样保留
  fm.name = name;
  fm.version = typeof raw.version === 'string' && raw.version ? raw.version : '1.0.0';
  fm.description = description;
  fm.execution_mode = executionMode;
  fm.domain = raw.domain || 'imported';
  if (!Array.isArray(raw.tags) || raw.tags.length === 0) fm.tags = ['imported'];
  fm.status = raw.status || 'stable';
  fm.source = 'user' satisfies SkillSource;
  fm.imported_at = new Date().toISOString();
  return fm;
}

function importOne(skillDir: string, options: ImportOptions, originalSource: string): ImportReport {
  const report: ImportReport = {
    source: originalSource,
    skillName: null,
    status: 'failed',
    warnings: [],
    copiedFiles: [],
  };
  const dirName = basename(skillDir);

  let raw: Record<string, any>;
  let body: string;
  try {
    const parsed = matter(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8'));
    raw = parsed.data ?? {};
    body = parsed.content?.trim() ?? '';
  } catch (err: any) {
    report.error = `SKILL.md 解析失败: ${err?.message ?? err}`;
    return report;
  }
  if (!body) report.warnings.push('SKILL.md 正文为空（提示词为空的技能可能无法有效工作）');

  const fm = mapFrontmatter(raw, dirName, report);
  if (!fm) return report;
  const name = fm.name as string;
  report.skillName = name;
  report.mapped = {
    name,
    version: fm.version,
    executionMode: fm.execution_mode,
    descriptionPreview: (fm.description as string).slice(0, 80),
  };

  const skillsRoot = resolve(options.skillsDir);
  if (!existsSync(skillsRoot)) mkdirSync(skillsRoot, { recursive: true }); // mkdtemp 需父目录存在
  const targetDir = join(skillsRoot, name);
  if (existsSync(targetDir) && !options.overwrite) {
    report.status = 'skipped';
    report.warnings.push(`技能 "${name}" 已存在（overwrite=true 可覆盖）`);
    return report;
  }

  // 临时目录组装 → 原子换入（含 .history 备份，与 writeSkillAtomic 同约定）
  const tmp = mkdtempSync(join(skillsRoot, `.tmp.import.${name}.`));
  try {
    writeFileSync(join(tmp, 'SKILL.md'), matter.stringify(body + '\n', fm), 'utf-8');

    // 附属文件迁移（SKILL.md 之外的一切，跳过隐藏/垃圾目录，限额保护）
    let copied = 0;
    let totalBytes = 0;
    const walk = (src: string, dest: string) => {
      for (const entry of readdirSync(src, { withFileTypes: true })) {
        if (entry.name === 'SKILL.md') continue;
        if (SKIP_ENTRIES.has(entry.name) || entry.name.startsWith('.tmp.import.')) continue;
        const s = join(src, entry.name);
        const d = join(dest, entry.name);
        if (entry.isDirectory()) {
          mkdirSync(d, { recursive: true });
          walk(s, d);
        } else if (entry.isFile()) {
          if (copied >= MAX_AUX_FILES) {
            report.warnings.push(`附属文件超过 ${MAX_AUX_FILES} 个，余下跳过`);
            return;
          }
          const size = statSync(s).size;
          if (totalBytes + size > MAX_TOTAL_BYTES) {
            report.warnings.push(`附属文件总量超过 ${MAX_TOTAL_BYTES / 1024 / 1024}MB，余下跳过`);
            return;
          }
          mkdirSync(dest, { recursive: true });
          copyFileSync(s, d);
          report.copiedFiles.push(relative(tmp, d).replace(/\\/g, '/'));
          copied++;
          totalBytes += size;
        }
      }
    };
    walk(skillDir, tmp);

    if (existsSync(join(tmp, 'scripts')) && fm.execution_mode === 'llm_only') {
      report.warnings.push('检测到 scripts/ 目录但 execution_mode=llm_only（Anthropic 技能惯例为提示词技能）；如需执行脚本，请在技能编辑中配置 execution_mode: script + script_entry');
    }

    // 备份旧版 → 原子换入
    if (existsSync(targetDir)) {
      const histDir = join(skillsRoot, '.history', name, new Date().toISOString().replace(/[:.]/g, '-'));
      mkdirSync(histDir, { recursive: true });
      for (const f of readdirSync(targetDir)) {
        try {
          copyFileSync(join(targetDir, f), join(histDir, f));
        } catch { /* 备份尽力而为 */ }
      }
      rmSync(targetDir, { recursive: true, force: true });
    }
    // 原子换入（rename 同设备瞬时；跨设备失败回退逐文件复制）
    try {
      renameSync(tmp, targetDir);
    } catch {
      mkdirSync(targetDir, { recursive: true });
      copyTree(tmp, targetDir);
      rmSync(tmp, { recursive: true, force: true });
    }

    report.status = 'imported';
    return report;
  } catch (err: any) {
    rmSync(tmp, { recursive: true, force: true });
    report.error = `落盘失败: ${err?.message ?? err}`;
    return report;
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41) || 'imported-skill';
}

/** tmp → target 的递归复制（rename 跨设备失败时的回退路径） */
function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else if (entry.isFile()) copyFileSync(s, d);
  }
}
