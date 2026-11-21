import type { FastifyInstance } from 'fastify';
import { MemoryService } from '../services/memory-service.js';
import { MemoryUsageService } from '../services/memory-usage-service.js';
import { MemoryEntityService } from '../services/memory-entity-service.js';
import { RunBudgetSettingsService } from '../services/run-budget-settings.js';
import { auditMemory } from '../services/dream.js';
import { platformConfig } from '../services/config.js';
import { dirname as pathDirname } from 'path';
import type { SearchStore } from '../store/search-store.js';
import type { EvolutionService } from '../services/evolution-service.js';

/**
 * 创新点③：记忆查看/编辑 API — 透明性卖点可视化（Settings 页记忆卡）。
 * GET /api/memory 附带使用统计（命中次数 / 疑似误导 / 陈旧度 — 只标记不处置）。
 * POST /api/memory/audit 离线对账：记忆库 ↔ 历史轨迹核对，矛盾生成改写提议（人审闸门）。
 */
// memory merge 互斥锁：合并期间（LLM 调用数秒）阻止并发 merge/edit 防数据丢失
let mergeLock = false;
// 对账互斥锁：审计是多文件 LLM 批处理，防止重复点击并发跑两轮
let auditLock = false;
// 实体补建互斥锁
let entityLock = false;

export function registerMemoryRoutes(
  app: FastifyInstance,
  deps: { getSearch: () => SearchStore; getEvolution: () => EvolutionService } = {
    getSearch: () => null as any,
    getEvolution: () => null as any,
  },
): void {
  const service = () => new MemoryService(platformConfig.memoryDir);
  const usage = () => new MemoryUsageService(platformConfig.memoryDir);

  app.get('/api/memory', async () => {
    const svc = service();
    const files = svc.list();
    const eff = new RunBudgetSettingsService(pathDirname(platformConfig.databasePath)).effective();
    const entitySvc = new MemoryEntityService(platformConfig.memoryDir);
    return {
      items: files,
      dir: platformConfig.memoryDir,
      usage: usage().stats(svc),
      entities: { ...entitySvc.summary(), active: entitySvc.active(svc, eff), threshold: eff.entityIndexThreshold, enabled: eff.entityIndexEnabled },
    };
  });

  // 实体索引存量补建（人工触发 — 中途启用时为已有记忆建索引）
  app.post('/api/memory/entities/backfill', async (_request, reply) => {
    if (entityLock) return reply.status(409).send({ error: '补建正在进行中，请稍后再试' });
    entityLock = true;
    try {
      const { llmClient } = await import('../services/llm-client.js');
      const svc = service();
      const entitySvc = new MemoryEntityService(platformConfig.memoryDir);
      const r = await entitySvc.backfill(svc, llmClient as any);
      return { ...r, summary: entitySvc.summary() };
    } catch (err: any) {
      return reply.status(502).send({ error: `补建失败: ${err?.message ?? err}` });
    } finally {
      entityLock = false;
    }
  });

  // 离线对账（Dreaming）：空闲时对照原始轨迹核对记忆条目 — 只提议，改写走人审
  app.post('/api/memory/audit', async (_request, reply) => {
    if (auditLock) return reply.status(409).send({ error: '对账正在进行中，请稍后再试' });
    auditLock = true;
    try {
      const { llmClient } = await import('../services/llm-client.js');
      const result = await auditMemory({
        svc: service(),
        llm: llmClient as any,
        search: deps.getSearch(),
        evolution: deps.getEvolution(),
      });
      return result;
    } catch (err: any) {
      return reply.status(502).send({ error: `对账失败: ${err?.message ?? err}` });
    } finally {
      auditLock = false;
    }
  });

  // 多文件合并为一（LLM 全保留整理）：内容一条不丢，仅按主题重组；被并入的原文件
  // 备份进 memory/.history/ 后移除——条目变少、信息不减
  app.post('/api/memory/merge', async (request, reply) => {
    if (mergeLock) return reply.status(409).send({ error: '合并正在进行中，请稍后再试' });
    mergeLock = true;
    try {
    const body = (request.body || {}) as { names?: string[]; target?: string };
    const svc = service();
    const names = Array.isArray(body.names) ? body.names.map(n => svc.sanitizeName(String(n))) : [];
    if (names.some(n => !n)) return reply.status(400).send({ error: '存在不合法的文件名' });
    const uniq = [...new Set(names as string[])];
    if (uniq.length < 2) return reply.status(400).send({ error: '至少选择 2 个文件才能合并' });
    if (uniq.length > 12) return reply.status(400).send({ error: '单次最多合并 12 个文件' });
    const target = body.target ? svc.sanitizeName(body.target) : uniq[0];
    if (!target) return reply.status(400).send({ error: '目标文件名不合法' });

    const contents: Array<{ name: string; content: string }> = [];
    for (const n of uniq) {
      const r = svc.read(n);
      if (!r) return reply.status(404).send({ error: `记忆文件不存在: ${n}` });
      contents.push({ name: n, content: r.content });
    }

    // LLM 全保留合并（仅整理结构，不丢事实）+ 长度兜底校验（疑似丢内容即拒绝落盘）
    const { llmClient } = await import('../services/llm-client.js');
    const prompt =
      `Merge the following memory note files into ONE well-organized Markdown document.\n` +
      `STRICT RULES: preserve EVERY fact, preference, date, name, and lesson — nothing may be dropped or summarized away; ` +
      `merge exact duplicates only; organize with clear topic headings (## level); keep each item's original language ` +
      `(Chinese stays Chinese, English stays English); keep source annotations like dates if present. ` +
      `Output ONLY the merged Markdown, no commentary.\n\n` +
      contents.map(c => `===== FILE: ${c.name} =====\n${c.content}`).join('\n\n');
    let merged: string;
    try {
      const res = await llmClient.chat({ messages: [{ role: 'user', content: prompt }], maxTokens: 8000 });
      merged = String(res.content ?? '').trim();
    } catch (err: any) {
      return reply.status(502).send({ error: `LLM 合并失败: ${err?.message ?? err}` });
    }
    if (merged.length < contents.reduce((n, c) => n + c.content.length, 0) * 0.3) {
      return reply.status(502).send({ error: '合并结果疑似丢内容（长度异常），已拒绝写盘——请重试或手动合并' });
    }

    // 落盘：目标写入合并体；其余原文件备份进 .history/ 后删除
    svc.write(target, merged);
    const { mkdirSync, copyFileSync, unlinkSync, existsSync } = await import('fs');
    const { join, resolve } = await import('path');
    const memRoot = resolve(platformConfig.memoryDir);
    const histDir = join(memRoot, '.history');
    mkdirSync(histDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backedUp: string[] = [];
    for (const n of uniq) {
      if (n === target) continue;
      const abs = join(memRoot, n);
      if (existsSync(abs)) {
        copyFileSync(abs, join(histDir, `${stamp}--${n}`));
        unlinkSync(abs);
        backedUp.push(n);
      }
    }
    return { merged: target, mergedChars: merged.length, removed: backedUp, backupDir: '.history/' };
    } finally {
      mergeLock = false;
    }
  });

  app.get('/api/memory/:name', async (request, reply) => {
    const { name } = request.params as any;
    const r = service().read(name);
    if (!r) return reply.status(404).send({ error: '记忆文件不存在' });
    return { name: service().sanitizeName(name), content: r.content, truncated: r.truncated, size: r.size };
  });

  app.put('/api/memory/:name', async (request, reply) => {
    const { name } = request.params as any;
    const body = (request.body || {}) as { content?: string };
    if (typeof body.content !== 'string') {
      return reply.status(400).send({ error: '缺少 content' });
    }
    try {
      const w = service().write(name, body.content);
      return { written: w.name, bytes: w.bytes, truncated: w.truncated };
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message ?? '写入失败' });
    }
  });

  app.delete('/api/memory/:name', async (request, reply) => {
    const { name } = request.params as any;
    const svc = service();
    const safe = svc.sanitizeName(name);
    const { unlinkSync, existsSync } = await import('fs');
    const { join } = await import('path');
    const abs = join(svc.dirPath, safe ?? '');
    if (!safe || !existsSync(abs)) return reply.status(404).send({ error: '记忆文件不存在' });
    unlinkSync(abs);
    return { success: true, deleted: safe };
  });
}
