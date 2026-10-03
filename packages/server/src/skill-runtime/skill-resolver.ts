import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { createHash } from 'crypto';
import matter from 'gray-matter';
import type { ParsedSkillManifest, SkillSource } from '../types/index.js';

/**
 * 解析 SKILL.md 文件，提取 Frontmatter 元数据和 Prompt 正文
 * v1.1.0：新增 source / created_by / creator_session_id /
 *         consumes_company_profile / empty_when / default / input_keys 字段。
 * 缺省 source 视为 builtin（兼容 v1.0.0 无 source 字段的 SKILL.md）。
 */
export function parseSkillMd(skillDir: string): ParsedSkillManifest | null {
  const skillMdPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMdPath)) return null;

  try {
    const raw = readFileSync(skillMdPath, 'utf-8');
    const { data: fm, content: prompt } = matter(raw);

    if (!fm.name || !fm.version || !fm.description || !fm.execution_mode) {
      console.warn(`[Skill 解析] 缺少必填字段: ${skillDir}`);
      return null;
    }

    const fileHash = createHash('sha256').update(raw).digest('hex');

    let referenceContent: string | undefined;
    const refPath = join(skillDir, 'reference.md');
    if (existsSync(refPath)) {
      referenceContent = readFileSync(refPath, 'utf-8');
    }

    const source: SkillSource = (fm.source === 'user') ? 'user' : 'builtin';

    return {
      name: fm.name,
      version: fm.version || '1.0.0',
      description: fm.description,
      domain: fm.domain || 'general',
      capabilities: fm.capabilities || [],
      inputSchema: fm.input_schema || { type: 'object', properties: {} },
      outputSchema: fm.output_schema || { type: 'object', properties: {} },
      executionMode: fm.execution_mode,
      scriptEntry: fm.script_entry,
      scriptRuntime: fm.script_runtime,
      scriptTimeoutMs: fm.script_timeout_ms,
      humanGate: fm.human_gate ?? false,
      xPlanning: (fm as any)['x-planning'],
      estimatedDurationMs: fm.estimated_duration_ms || 10000,
      costLevel: fm.cost_level || 'low',
      status: fm.status || 'stable',
      tags: fm.tags || [],
      skillDirPath: resolve(skillDir),
      promptContent: prompt.trim(),
      referenceContent,
      loadedAt: new Date().toISOString(),
      fileHash,
      source,
      createdBy: fm.created_by,
      creatorSessionId: fm.creator_session_id,
      consumesCompanyProfile: Boolean(fm.consumes_company_profile),
      emptyWhen: Array.isArray(fm.empty_when) ? fm.empty_when : undefined,
      defaultInput: typeof fm.default === 'object' && fm.default !== null ? fm.default : undefined,
      inputKeys: Array.isArray(fm.input_keys) ? fm.input_keys : undefined,
    };
  } catch (err) {
    console.error(`[Skill 解析] 解析失败: ${skillDir}`, err);
    return null;
  }
}
