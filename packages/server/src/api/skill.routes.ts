import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'fs';
import type { FilesystemSkillRegistry } from '../skill-runtime/filesystem-registry.js';
import type { SkillExecutor } from '../skill-runtime/skill-executor.js';
import { resolveArtifactPath } from '../skill-runtime/artifact-path.js';
import {
  writeSkillAtomic,
  moveToTrash,
  validateSkillName,
  SkillExistsError,
  SkillNameInvalidError,
  PathTraversalError,
  manifestToFrontmatter,
} from '../skill-runtime/skill-writer.js';

const CONFIRM_HEADER = 'x-confirm-builtin';

export function registerSkillRoutes(
  app: FastifyInstance,
  registry: FilesystemSkillRegistry,
  executor: SkillExecutor
) {
  // 列表
  app.get('/api/skills', async (request) => {
    const { domain, status, tag, source } = request.query as any;
    let skills = registry.listAll();

    if (domain) skills = skills.filter(s => s.domain === domain);
    if (status) skills = skills.filter(s => s.status === status);
    if (tag) skills = skills.filter(s => s.tags.includes(tag));
    if (source) skills = skills.filter(s => s.source === source);

    return {
      total: skills.length,
      items: skills.map(s => ({
        name: s.name,
        version: s.version,
        description: s.description,
        domain: s.domain,
        capabilities: s.capabilities,
        executionMode: s.executionMode,
        status: s.status,
        costLevel: s.costLevel,
        tags: s.tags,
        humanGate: s.humanGate,
        estimatedDurationMs: s.estimatedDurationMs,
        loadedAt: s.loadedAt,
        source: s.source,
        createdBy: s.createdBy,
        consumesCompanyProfile: s.consumesCompanyProfile || false,
      })),
    };
  });

  // 详情（v1.1.0：返回完整 promptContent + frontmatter，便于前端编辑）
  app.get('/api/skills/:name', async (request, reply) => {
    const { name } = request.params as any;
    const { full } = request.query as any;
    const skill = registry.getByName(name);

    if (!skill) {
      return reply.status(404).send({ error: `Skill "${name}" 未找到` });
    }

    const wantFull = String(full || '') === '1' || String(full || '') === 'true';
    const promptContent = wantFull
      ? skill.promptContent
      : skill.promptContent.substring(0, 500) + (skill.promptContent.length > 500 ? '...' : '');

    return {
      ...skill,
      promptContent,
      frontmatter: manifestToFrontmatter(skill),
    };
  });

  // 测试执行 Skill
  app.post('/api/skills/:name/test', async (request, reply) => {
    const { name } = request.params as any;
    const { input, companyProfileOverride } = (request.body || {}) as any;

    const skill = registry.getByName(name);
    if (!skill) {
      return reply.status(404).send({ error: `Skill "${name}" 未找到` });
    }

    const result = await executor.execute({
      skillName: name,
      input: input || {},
      context: {
        taskId: 'test-' + Date.now(),
        agentId: 'test-agent',
        userId: 'tester',
        companyProfileOverride,
      },
    });

    return result;
  });

  // ─── v1.1.0 CRUD ────────────────────────────────────────

  // PUT 编辑（含 builtin 二次确认守卫）
  app.put('/api/skills/:name', async (request, reply) => {
    const { name } = request.params as any;
    const body = (request.body || {}) as any;

    try {
      validateSkillName(name);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message, code: err.code });
    }

    const existing = registry.getByName(name);
    if (!existing) {
      return reply.status(404).send({ error: `Skill "${name}" 不存在` });
    }

    if (existing.source === 'builtin') {
      const headerVal = (request.headers[CONFIRM_HEADER] as string) || '';
      if (headerVal !== name) {
        return reply.status(403).send({
          error: `内置 Skill 编辑需要二次确认，请在请求头 ${CONFIRM_HEADER} 写入 "${name}"`,
          code: 'BUILTIN_GUARD',
        });
      }
    }

    if (!body.frontmatter || typeof body.frontmatter !== 'object') {
      return reply.status(400).send({ error: '缺少 frontmatter 字段' });
    }
    if (typeof body.promptContent !== 'string') {
      return reply.status(400).send({ error: '缺少 promptContent 字段' });
    }

    // 强制 frontmatter.name 与 URL 参数一致
    body.frontmatter.name = name;
    if (existing.source === 'user' && !body.frontmatter.source) {
      body.frontmatter.source = 'user';
    }

    try {
      writeSkillAtomic(registry.getSkillsDir(), name, {
        frontmatter: body.frontmatter,
        promptContent: body.promptContent,
        referenceContent: body.referenceContent,
        scriptContent: body.scriptContent,
        scriptEntry: body.frontmatter.script_entry,
      }, { overwrite: true, keepHistory: true });

      await registry.reloadSkill(name);
      const updated = registry.getByName(name);
      return { success: true, skill: updated };
    } catch (err: any) {
      if (err instanceof PathTraversalError) {
        return reply.status(400).send({ error: err.message, code: err.code });
      }
      if (err instanceof SkillNameInvalidError) {
        return reply.status(400).send({ error: err.message, code: err.code });
      }
      return reply.status(500).send({ error: `保存失败: ${err.message}` });
    }
  });

  // DELETE
  app.delete('/api/skills/:name', async (request, reply) => {
    const { name } = request.params as any;
    const { physical } = request.query as any;
    const wantPhysical = String(physical || '') === 'true' || String(physical || '') === '1';

    try {
      validateSkillName(name);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message, code: err.code });
    }

    const existing = registry.getByName(name);
    if (!existing) {
      return reply.status(404).send({ error: `Skill "${name}" 不存在` });
    }

    if (existing.source === 'builtin') {
      const headerVal = (request.headers[CONFIRM_HEADER] as string) || '';
      if (headerVal !== name) {
        return reply.status(403).send({
          error: `内置 Skill 删除需要二次确认，请在请求头 ${CONFIRM_HEADER} 写入 "${name}"`,
          code: 'BUILTIN_GUARD',
        });
      }
    }

    try {
      registry.removeSkill(name);
      let trashedTo: string | undefined;
      if (wantPhysical) {
        trashedTo = moveToTrash(registry.getSkillsDir(), name);
      }
      return { success: true, name, physical: wantPhysical, trashedTo };
    } catch (err: any) {
      return reply.status(500).send({ error: `删除失败: ${err.message}` });
    }
  });

  // 产物下载（FR-C8）：路径经 resolveArtifactPath 校验（防同前缀兄弟目录穿越）
  app.get('/api/skills/:name/artifacts', async (request, reply) => {
    const { name } = request.params as any;
    const { path: queryPath } = request.query as any;
    const skill = registry.getByName(name);
    if (!skill) return reply.status(404).send({ error: 'Skill 不存在' });
    if (!queryPath || typeof queryPath !== 'string') {
      return reply.status(400).send({ error: '缺少 path 参数' });
    }
    const candidate = resolveArtifactPath(skill.skillDirPath, queryPath);
    if (!candidate) {
      return reply.status(400).send({ error: '路径非法' });
    }
    if (!existsSync(candidate)) {
      return reply.status(404).send({ error: '文件不存在' });
    }
    const buf = readFileSync(candidate);
    const lower = candidate.toLowerCase();
    if (lower.endsWith('.md')) reply.header('Content-Type', 'text/markdown; charset=utf-8');
    else if (lower.endsWith('.csv')) reply.header('Content-Type', 'text/csv; charset=utf-8');
    else if (lower.endsWith('.json')) reply.header('Content-Type', 'application/json; charset=utf-8');
    else reply.header('Content-Type', 'application/octet-stream');
    return reply.send(buf);
  });
}
