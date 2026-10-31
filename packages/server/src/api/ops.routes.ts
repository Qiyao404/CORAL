import type { FastifyInstance } from 'fastify';
import { dirname } from 'path';
import type { RunEngine } from '../kernel/run-engine.js';
import type { LLMClient } from '../services/llm-client.js';
import { platformConfig } from '../services/config.js';
import { ConfigGcService } from '../services/config-gc-service.js';
import { RunBudgetSettingsService } from '../services/run-budget-settings.js';
import { PersonalizationService } from '../services/personalization-service.js';
import { writeSkillAtomic } from '../skill-runtime/skill-writer.js';
import { evaluateDeterministic, evaluateWithLlm } from '../kernel/self-eval.js';

/**
 * 运维路由：习惯学习 / 证据记录 / 五轴自评 / 配置自清理。
 * 共同点：全部是本地数据上的只读或软删除操作，不触碰运行中的 run。
 */
export function registerOpsRoutes(app: FastifyInstance, runEngine: RunEngine, llm: LLMClient): void {
  const habits = () => runEngine.habitService;
  const dataDir = dirname(platformConfig.databasePath);
  const gc = () => new ConfigGcService(dataDir, platformConfig.skillsDir, runEngine.store);

  // ─── 习惯学习 ───────────────────────────────────────────────────────────

  app.get('/api/habits', async () => {
    const list = habits().list();
    return {
      items: list.map(h => ({ ...h, promotionReady: habits().promotionReady(h) })),
      observationsSinceDistill: habits().observationsSinceLastDistill(),
    };
  });

  app.post('/api/habits/distill', async () => {
    const r = await habits().distill(llm);
    return r;
  });

  app.post('/api/habits/:id/promote', async (request, reply) => {
    const { id } = request.params as any;
    try {
      const r = habits().promote(id, platformConfig.skillsDir, {
        write: (dir, name, payload, opts) => writeSkillAtomic(dir, name, payload, opts),
      });
      return { success: true, skillName: r.skillName };
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message ?? '晋升失败' });
    }
  });

  app.post('/api/habits/:id/adjust', async (request, reply) => {
    const { id } = request.params as any;
    const body = (request.body || {}) as { delta?: number };
    const delta = Number(body.delta);
    if (!Number.isFinite(delta) || delta < -0.5 || delta > 0.5) {
      return reply.status(400).send({ error: 'delta 需在 [-0.5, 0.5]' });
    }
    const h = habits().adjustConfidence(id, delta);
    if (!h) return reply.status(404).send({ error: '习惯不存在' });
    return h;
  });

  // ─── 证据记录（run 大结果的存档读取）──────────────────────────────────

  app.get('/api/runs/:runId/evidence', async (request, reply) => {
    const { runId } = request.params as any;
    const engine = runEngine as any;
    const items = engine.evidence.list(runId);
    return { items };
  });

  app.get('/api/runs/:runId/evidence/:id', async (request, reply) => {
    const { runId, id } = request.params as any;
    const q = request.query as any;
    const engine = runEngine as any;
    const r = engine.evidence.read(runId, id, Number(q.offset) || 0, Math.min(Number(q.limit) || 8000, 60_000));
    if (!r) return reply.status(404).send({ error: '证据记录不存在' });
    return r;
  });

  // ─── 五轴自评 ───────────────────────────────────────────────────────────

  app.post('/api/runs/:runId/self-eval', async (request, reply) => {
    const { runId } = request.params as any;
    const run = runEngine.store.get(runId);
    if (!run) return reply.status(404).send({ error: 'run 不存在' });
    if (!run.final_content) return reply.status(400).send({ error: 'run 无最终回答（未完成）' });
    const base = evaluateDeterministic(run.goal, run.final_content);
    const body = (request.body || {}) as { withLlm?: boolean };
    if (body.withLlm === false) return base;
    const result = await evaluateWithLlm(llm, run.goal, run.final_content, base);
    return result;
  });

  // ─── 运行预算（用户设置 — 设置页数据源，新 run 立即生效）────────────────

  app.get('/api/settings/run-budget', async () => {
    const svc = new RunBudgetSettingsService(dataDir);
    return { ...svc.get(), effective: svc.effective() };
  });

  app.put('/api/settings/run-budget', async (request, reply) => {
    const body = (request.body || {}) as { maxTokens?: number | null; maxSteps?: number | null };
    const svc = new RunBudgetSettingsService(dataDir);
    const saved = svc.set(body);
    return { ...saved, effective: svc.effective() };
  });

  // ─── 个性化（6 维度"越用越懂你"，默认全关，设置页开关）──────────────────

  const pSvc = () => runEngine.personalizationService;

  app.get('/api/personalization', async () => {
    const svc = pSvc();
    return {
      settings: svc.getSettings(),
      interestTags: svc.getTopTags(10),
      styleProfile: svc.getSettings().styleAdaptive ? svc.stylePrompt() : null,
      rhythm: svc.getSettings().rhythmAware ? svc.rhythmPrompt() : null,
      knowledgeNodes: svc.getSettings().knowledgeGraph ? svc.getTopTags(5) : [],
      implicitPrefs: svc.getSettings().implicitPrefs ? svc.implicitPrompt() : null,
    };
  });

  app.put('/api/personalization', async (request) => {
    const body = (request.body || {}) as Record<string, boolean>;
    const svc = pSvc();
    const patch: Record<string, boolean> = {};
    for (const k of ['interestTags', 'styleAdaptive', 'rhythmAware', 'knowledgeGraph', 'proactive', 'implicitPrefs']) {
      if (typeof body[k] === 'boolean') patch[k] = body[k];
    }
    return { settings: svc.updateSettings(patch) };
  });

  app.post('/api/personalization/reset', async () => {
    pSvc().resetAll();
    return { success: true };
  });

  // ─── 提示词优化（输入框的 ✨ 按钮）────────────────────────────────────

  app.post('/api/prompt-optimize', async (request, reply) => {
    const body = (request.body || {}) as { text?: string };
    const text = String(body.text ?? '').trim();
    if (!text) return reply.status(400).send({ error: '缺少 text' });
    if (text.length > 4000) return reply.status(400).send({ error: '文本过长（上限 4000 字符）' });
    try {
      const r = await llm.complete(
        [
          {
            role: 'system',
            content:
              'You improve short task prompts for a personal agent runtime. First infer what the user actually wants (deliverable, scope, constraints). Then rewrite the prompt so the agent can complete it better: make the goal and expected deliverable explicit, add measurable/specific criteria, mention desired output format (file name / structure / language) when inferable, remove ambiguity and filler — but NEVER invent requirements the user did not imply, and keep it in the SAME language as the input. Keep @file references intact if present. Output ONLY the rewritten prompt, no explanations, no quotes.',
          },
          { role: 'user', content: text },
        ],
        { temperature: 0.3, maxTokens: 1200 }
      );
      const optimized = r.content.trim().replace(/^["“](.*)["”]$/s, '$1');
      return { optimized: optimized || text };
    } catch (err: any) {
      return reply.status(500).send({ error: `优化失败: ${err?.message ?? err}` });
    }
  });

  // ─── 斜杠命令 / 具名子代理（用户快捷面）────────────────────────────────

  app.get('/api/commands', async () => {
    const engine = runEngine as any;
    return { items: engine.slashCommands.list() };
  });

  app.get('/api/agents', async () => {
    const engine = runEngine as any;
    return { items: engine.agentPresets.list() };
  });

  // ─── 配置自清理 ─────────────────────────────────────────────────────────

  app.get('/api/system/gc', async () => {
    return gc().scan();
  });

  app.post('/api/system/gc', async (request, reply) => {
    const body = (request.body || {}) as { ids?: string[] };
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return reply.status(400).send({ error: '缺少 ids（逐项确认 — 请传入要清理的 ID 列表）' });
    }
    const r = gc().clean(body.ids);
    return { ...r, cleanedCount: r.cleaned.length, skippedCount: r.skipped.length };
  });
}
