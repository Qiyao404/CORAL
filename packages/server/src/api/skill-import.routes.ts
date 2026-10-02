import type { FastifyInstance } from 'fastify';
import { importSkills } from '../skill-runtime/skill-importer.js';
import { platformConfig } from '../services/config.js';
import type { FilesystemSkillRegistry } from '../skill-runtime/filesystem-registry.js';

/**
 * M1-6：技能导入 API — Anthropic Agent Skills 格式 → CORAL 技能库。
 * source：本地技能目录 / 含多技能的父目录 / git URL（支持 GitHub tree 子路径）。
 */
export function registerSkillImportRoutes(app: FastifyInstance, registry: FilesystemSkillRegistry): void {
  app.post('/api/skills/import', async (request, reply) => {
    const body = (request.body || {}) as { source?: string; overwrite?: boolean };
    if (typeof body.source !== 'string' || !body.source.trim()) {
      return reply.status(400).send({ error: '缺少 source（本地目录或 git URL）' });
    }

    const reports = await importSkills(body.source.trim(), {
      skillsDir: platformConfig.skillsDir,
      overwrite: Boolean(body.overwrite),
    });

    // 已导入的技能立即热加载
    for (const r of reports) {
      if (r.status === 'imported' && r.skillName) {
        await registry.reloadSkill(r.skillName);
      }
    }

    return {
      total: reports.length,
      imported: reports.filter(r => r.status === 'imported').length,
      skipped: reports.filter(r => r.status === 'skipped').length,
      failed: reports.filter(r => r.status === 'failed').length,
      reports,
    };
  });
}
