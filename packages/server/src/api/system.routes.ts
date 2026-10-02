import type { FastifyInstance } from 'fastify';
import { createRequire } from 'module';
import { platformConfig } from '../services/config.js';
import { taskStore, agentStore } from '../store/index.js';
import type { FilesystemSkillRegistry } from '../skill-runtime/filesystem-registry.js';
import { llmClient } from '../services/llm-client.js';

// P1-3：版本号从 package.json 读取 — 不再手写硬编码（修复 v1 的 1.0.0 漂移）
const require = createRequire(import.meta.url);
const SERVER_VERSION: string = (require('../../package.json') as { version: string }).version;
import {
  activateLlmConfig,
  deleteLlmConfig,
  getActiveLlmConfig,
  listLlmConfigs,
  saveLlmConfig,
} from '../services/llm-config-service.js';

export function registerSystemRoutes(
  app: FastifyInstance,
  registry: FilesystemSkillRegistry
) {
  // 健康检查
  app.get('/api/health', async () => {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: SERVER_VERSION,
      platform: 'CORAL',
    };
  });

  // 平台配置（敏感信息遮罩）
  app.get('/api/config', async () => {
    const activeConfig = getActiveLlmConfig();
    const runtime = llmClient.getCurrentConfig();
    return {
      port: platformConfig.port,
      llmBaseUrl: runtime.baseUrl,
      llmModel: runtime.model,
      llmApiKey: activeConfig.apiKey.replace(/.(?=.{4})/g, '*'),
      llmProfileId: activeConfig.profileId,
      llmProfileName: activeConfig.name,
      llmProvider: activeConfig.provider ?? 'openai-compat',
      demoMode: platformConfig.demoMode,
      skillsDir: platformConfig.skillsDir,
      sandboxMode: platformConfig.sandboxMode,
      maxConcurrentTasks: platformConfig.maxConcurrentTasks,
      maxConcurrentAgentsPerTask: platformConfig.maxConcurrentAgentsPerTask,
    };
  });

  // LLM 配置列表
  app.get('/api/llm/configs', async () => {
    const activeConfig = getActiveLlmConfig();
    return {
      activeProfileId: activeConfig.profileId,
      items: listLlmConfigs(),
    };
  });

  // 新增/更新 LLM 配置
  app.post('/api/llm/configs', async (request, reply) => {
    try {
      const body = request.body as {
        profileId?: string;
        name?: string;
        provider?: string;
        baseUrl?: string;
        model?: string;
        apiKey?: string;
        setActive?: boolean;
      };

      if (!body?.name || !body?.baseUrl || !body?.model) {
        return reply.status(400).send({ error: 'name/baseUrl/model 为必填字段' });
      }

      const provider = body.provider === 'anthropic' ? 'anthropic' : 'openai-compat';

      const saved = saveLlmConfig({
        profileId: body.profileId,
        name: body.name.trim(),
        provider,
        baseUrl: body.baseUrl.trim(),
        model: body.model.trim(),
        apiKey: body.apiKey,
        setActive: body.setActive,
      });

      if (saved.isActive) {
        llmClient.reconfigure({
          provider: saved.provider,
          baseUrl: saved.baseUrl,
          apiKey: saved.apiKey,
          model: saved.model,
        });
      }

      return {
        success: true,
        activeProfileId: getActiveLlmConfig().profileId,
        items: listLlmConfigs(),
      };
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message || '保存配置失败' });
    }
  });

  // 激活指定 LLM 配置
  app.post('/api/llm/configs/:profileId/activate', async (request, reply) => {
    try {
      const { profileId } = request.params as { profileId: string };
      const active = activateLlmConfig(profileId);
      llmClient.reconfigure({
        provider: active.provider,
        baseUrl: active.baseUrl,
        apiKey: active.apiKey,
        model: active.model,
      });
      return {
        success: true,
        activeProfileId: active.profileId,
        items: listLlmConfigs(),
      };
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message || '激活配置失败' });
    }
  });

  // 删除 LLM 配置
  app.delete('/api/llm/configs/:profileId', async (request, reply) => {
    try {
      const { profileId } = request.params as { profileId: string };
      const result = deleteLlmConfig(profileId);
      const active = getActiveLlmConfig();
      llmClient.reconfigure({
        provider: active.provider,
        baseUrl: active.baseUrl,
        apiKey: active.apiKey,
        model: active.model,
      });
      return {
        success: true,
        ...result,
        activeProfileId: active.profileId,
        items: listLlmConfigs(),
      };
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message || '删除配置失败' });
    }
  });

  // Dashboard 统计数据
  app.get('/api/stats', async () => {
    const tasks = taskStore.getAll();
    const agents = agentStore.getAll();
    const skills = registry.listAll();

    const tasksByStatus: Record<string, number> = {};
    for (const t of tasks) {
      tasksByStatus[t.status] = (tasksByStatus[t.status] || 0) + 1;
    }

    const agentsByStatus: Record<string, number> = {};
    for (const a of agents) {
      agentsByStatus[a.status] = (agentsByStatus[a.status] || 0) + 1;
    }

    const completedTasks = tasks.filter(t => t.status === 'completed');
    const failedTasks = tasks.filter(t => t.status === 'failed');
    const successRate = tasks.length > 0
      ? Math.round((completedTasks.length / tasks.length) * 100)
      : 0;

    return {
      tasks: {
        total: tasks.length,
        byStatus: tasksByStatus,
        successRate,
      },
      agents: {
        total: agents.length,
        byStatus: agentsByStatus,
      },
      skills: {
        total: skills.length,
        available: skills.filter(s => s.status !== 'deprecated').length,
        domains: [...new Set(skills.map(s => s.domain))],
      },
      system: {
        demoMode: platformConfig.demoMode,
        uptime: process.uptime(),
      },
    };
  });
}
