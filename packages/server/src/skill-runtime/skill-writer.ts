import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, statSync, cpSync } from 'fs';
import { dirname, join, resolve, isAbsolute } from 'path';
import matter from 'gray-matter';
import type { ParsedSkillManifest } from '../types/index.js';

/** 合法 Skill 名（DESIGN §5.5）：kebab-case，2-41 字符 */
const NAME_REGEX = /^[a-z][a-z0-9-]{1,40}$/;

export interface SkillWritePayload {
  /** SKILL.md frontmatter 字段（已是 snake_case 的 yaml object） */
  frontmatter: Record<string, any>;
  /** Markdown 正文（提示词） */
  promptContent: string;
  /** 可选 reference.md */
  referenceContent?: string;
  /** 可选 scripts/<entry> 内容（脚本 / 混合模式才有） */
  scriptContent?: string;
  /** 脚本入口文件名（默认 scripts/main.py 或按 frontmatter.script_entry） */
  scriptEntry?: string;
}

export class SkillNameInvalidError extends Error {
  code = 'SKILL_NAME_INVALID';
}
export class SkillExistsError extends Error {
  code = 'SKILL_EXISTS';
}
export class PathTraversalError extends Error {
  code = 'PATH_TRAVERSAL';
}

export interface WriteOptions {
  /** 已存在时是否覆盖（false 默认 → 抛 SkillExistsError） */
  overwrite?: boolean;
  /** 是否在覆盖前把旧 SKILL.md 拷贝到 .history/ 下，便于回滚（P2，默认开启） */
  keepHistory?: boolean;
}

/**
 * 把 frontmatter + promptContent 拼装成 SKILL.md 文本
 */
export function buildSkillMd(payload: SkillWritePayload): string {
  const fm = { ...payload.frontmatter };
  // 确保必填字段
  if (!fm.name || !fm.version || !fm.description || !fm.execution_mode) {
    throw new Error('SKILL.md 缺少必填字段 name/version/description/execution_mode');
  }
  const stringified = matter.stringify(payload.promptContent || '', fm);
  return stringified;
}

/**
 * 校验 Skill 名（kebab-case + 防路径穿越）
 */
export function validateSkillName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new SkillNameInvalidError('Skill 名不能为空');
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\') || isAbsolute(name)) {
    throw new PathTraversalError(`Skill 名包含非法字符: ${name}`);
  }
  if (!NAME_REGEX.test(name)) {
    throw new SkillNameInvalidError(`Skill 名必须满足 kebab-case 格式（2-41 字符，小写字母开头）: ${name}`);
  }
}

/**
 * 在 skillsDir 下原子写入一个 Skill（先写 .tmp.<name>/ → fs.rename → skills/<name>/）
 * 返回新的 skill 目录绝对路径
 */
export function writeSkillAtomic(
  skillsDir: string,
  name: string,
  payload: SkillWritePayload,
  options: WriteOptions = {}
): string {
  validateSkillName(name);

  const targetDir = join(skillsDir, name);
  const tmpDir = join(skillsDir, `.tmp.${name}.${Date.now()}`);

  if (existsSync(targetDir) && !options.overwrite) {
    throw new SkillExistsError(`Skill "${name}" 已存在`);
  }

  // 1. 先在 tmp 目录构建完整的 Skill 内容
  if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  // SKILL.md
  const skillMdContent = buildSkillMd(payload);
  writeFileSync(join(tmpDir, 'SKILL.md'), skillMdContent, 'utf-8');

  // reference.md（可选）
  if (payload.referenceContent && payload.referenceContent.trim()) {
    writeFileSync(join(tmpDir, 'reference.md'), payload.referenceContent, 'utf-8');
  }

  // scripts/main.py（如果是 script / hybrid 模式）
  if (payload.scriptContent && payload.scriptContent.trim()) {
    const entry = payload.scriptEntry || 'scripts/main.py';
    if (entry.includes('..')) {
      throw new PathTraversalError(`脚本入口路径非法: ${entry}`);
    }
    const scriptAbs = join(tmpDir, entry);
    mkdirSync(dirname(scriptAbs), { recursive: true });
    writeFileSync(scriptAbs, payload.scriptContent, 'utf-8');
  }

  // 2. 备份历史 → skillsDir/.history/<name>/<timestamp>/
  //    注意必须放在目标目录之外：v1 曾备份进 targetDir/.history/，随后第 3 步删除整个
  //    targetDir 时把备份一起删掉了（备份从未生效）；集中式 .history 也避免触发 watcher
  if (existsSync(targetDir) && options.keepHistory !== false) {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const historyDir = join(skillsDir, '.history', name, ts);
      mkdirSync(historyDir, { recursive: true });
      const oldMd = join(targetDir, 'SKILL.md');
      if (existsSync(oldMd)) cpSync(oldMd, join(historyDir, 'SKILL.md'));
      const oldRef = join(targetDir, 'reference.md');
      if (existsSync(oldRef)) cpSync(oldRef, join(historyDir, 'reference.md'));
    } catch (err) {
      console.warn(`[Skill 写盘] 备份历史失败（不影响主流程）: ${err}`);
    }
  }

  // 3. 原子搬迁：删旧 → rename
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  renameSync(tmpDir, targetDir);

  return resolve(targetDir);
}

/**
 * 把 Skill 目录移到回收站 skills/.trash/<name>-<ts>/
 */
export function moveToTrash(skillsDir: string, name: string): string {
  validateSkillName(name);
  const sourceDir = join(skillsDir, name);
  if (!existsSync(sourceDir)) {
    throw new Error(`Skill 目录不存在: ${name}`);
  }
  const trashRoot = join(skillsDir, '.trash');
  if (!existsSync(trashRoot)) mkdirSync(trashRoot, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const targetDir = join(trashRoot, `${name}-${ts}`);
  renameSync(sourceDir, targetDir);
  return targetDir;
}

/** 把 ParsedSkillManifest 反序列化回 frontmatter 对象（用于编辑预览） */
export function manifestToFrontmatter(m: ParsedSkillManifest): Record<string, any> {
  const fm: Record<string, any> = {
    name: m.name,
    version: m.version,
    description: m.description,
    domain: m.domain,
    capabilities: m.capabilities,
    input_schema: m.inputSchema,
    output_schema: m.outputSchema,
    execution_mode: m.executionMode,
    human_gate: m.humanGate,
    estimated_duration_ms: m.estimatedDurationMs,
    cost_level: m.costLevel,
    status: m.status,
    tags: m.tags,
  };
  if (m.scriptEntry) fm.script_entry = m.scriptEntry;
  if (m.scriptRuntime) fm.script_runtime = m.scriptRuntime;
  if (m.scriptTimeoutMs) fm.script_timeout_ms = m.scriptTimeoutMs;
  if (m.source && m.source !== 'builtin') fm.source = m.source;
  if (m.createdBy) fm.created_by = m.createdBy;
  if (m.creatorSessionId) fm.creator_session_id = m.creatorSessionId;
  if (m.consumesCompanyProfile) fm.consumes_company_profile = true;
  if (m.emptyWhen) fm.empty_when = m.emptyWhen;
  if (m.defaultInput) fm.default = m.defaultInput;
  if (m.inputKeys) fm.input_keys = m.inputKeys;
  return fm;
}

/** 用于尝试探测一个目录是否还存在（避免 statSync 抛错） */
export function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
