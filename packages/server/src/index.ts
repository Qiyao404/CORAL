import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';

import { platformConfig, PROJECT_ROOT } from './services/config.js';
import { eventBus } from './event/event-bus.js';
import { FilesystemSkillRegistry } from './skill-runtime/filesystem-registry.js';
import { SkillWatcher } from './skill-runtime/skill-watcher.js';
import { SkillExecutor } from './skill-runtime/skill-executor.js';
import { PlanningEngine } from './planning/planning-engine.js';
import { DAGScheduler } from './scheduler/dag-scheduler.js';
import { SkillBuilderService } from './services/skill-builder-service.js';
import { RunEngine } from './kernel/run-engine.js';
import { RunStore } from './store/run-store.js';
import { RunEventStore } from './store/run-event-store.js';
import { CheckpointStore } from './store/checkpoint-store.js';
import { registerRunRoutes } from './api/run.routes.js';
import { ensureLlmConfigsInitialized } from './services/llm-config-service.js';
import { getCompanyProfile } from './services/company-profile-service.js';
import { registerTaskRoutes } from './api/task.routes.js';
import { registerSkillRoutes } from './api/skill.routes.js';
import { registerEventRoutes } from './api/event.routes.js';
import { registerSystemRoutes } from './api/system.routes.js';
import { registerSkillBuilderRoutes } from './api/skill-builder.routes.js';
import { registerSkillImportRoutes } from './api/skill-import.routes.js';
import { registerCompanyProfileRoutes } from './api/company-profile.routes.js';
import { closeDb } from './store/db.js';
import { abortAll } from './services/task-abort-registry.js';
import { llmClient } from './services/llm-client.js';

async function main() {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║        CORAL — 通用智能体运行时平台        ║');
  console.log('║        版本: 1.1.0                         ║');
  console.log('╚═══════════════════════════════════════════╝');

  // 确保必要目录存在
  const skillsDir = platformConfig.skillsDir;
  const dataDir = resolve(PROJECT_ROOT, 'data');
  for (const dir of [skillsDir, dataDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // 启动迁移（v1.1.0：检测旧 SiliconFlow 配置 → 自动加入新 dashscope coding 并设为 active）
  ensureLlmConfigsInitialized();
  // 初始化公司画像（不存在则写默认）
  getCompanyProfile();

  // 让 llm-client 拿到最新 active 配置
  const llmConfig = (await import('./services/llm-config-service.js')).getActiveLlmConfig();
  llmClient.reconfigure({
    provider: llmConfig.provider,
    baseUrl: llmConfig.baseUrl,
    apiKey: llmConfig.apiKey,
    model: llmConfig.model,
  });

  // 初始化 Skill 注册表
  const registry = new FilesystemSkillRegistry(skillsDir);
  await registry.reloadAll();

  // 启动文件监控
  const watcher = new SkillWatcher(registry, platformConfig.skillWatcherDebounceMs);
  watcher.start();

  // 初始化执行引擎
  const executor = new SkillExecutor(registry);
  const planningEngine = new PlanningEngine(registry);
  const dagScheduler = new DAGScheduler(executor, registry);
  const skillBuilderService = new SkillBuilderService(registry);

  // M1-5：Free 模式 run-engine（AgentLoop 接线到三表 + 事件总线）
  const runEngine = new RunEngine({
    llm: llmClient,
    skillRegistry: registry,
    skillExecutor: executor,
    runStore: new RunStore(),
    eventStore: new RunEventStore(),
    checkpointStore: new CheckpointStore(),
  });

  // 创建 Fastify 应用
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

  // 容忍空 JSON body（Fastify 默认对 Content-Type: application/json + 空 body 返回 415）
  // 影响所有"动作型 POST"如 commit/activate/cancel — 让它们在无 body 时也能正常通过
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body: any, done) => {
    if (body === '' || body == null) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // M0-6：CORS 白名单收敛（v1 为 origin: true 全放行）
  // 默认允许 Vite dev 源 + 服务自身源（同源部署/代理场景）；可用 CORS_ALLOWED_ORIGINS 追加
  const corsOrigins = [
    ...new Set([
      ...platformConfig.corsAllowedOrigins,
      `http://localhost:${platformConfig.port}`,
      `http://127.0.0.1:${platformConfig.port}`,
    ]),
  ];
  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
  });

  await app.register(websocket);

  // 注册 API 路由
  registerTaskRoutes(app, planningEngine, dagScheduler);
  registerSkillRoutes(app, registry, executor);
  registerEventRoutes(app);
  registerSystemRoutes(app, registry);
  registerSkillBuilderRoutes(app, skillBuilderService);
  registerSkillImportRoutes(app, registry);
  registerCompanyProfileRoutes(app);
  registerRunRoutes(app, runEngine);

  // WebSocket 事件推送
  app.get('/ws/events', { websocket: true }, (socket, _request) => {
    console.log('[WebSocket] 客户端已连接');

    const sender = (event: any) => {
      try {
        socket.send(JSON.stringify(event));
      } catch { /* 连接已关闭 */ }
    };

    eventBus.addWsClient(sender);

    socket.on('message', (msg: any) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'subscribe' && data.taskId) {
          console.log(`[WebSocket] 客户端订阅任务: ${data.taskId}`);
        }
      } catch { /* 忽略无效消息 */ }
    });

    socket.on('close', () => {
      eventBus.removeWsClient(sender);
      console.log('[WebSocket] 客户端已断开');
    });
  });

  try {
    const address = await app.listen({
      port: platformConfig.port,
      host: platformConfig.host,
    });
    console.log(`\n[服务启动] CORAL 后端服务已启动: ${address}`);
    console.log(`[服务启动] API 文档: http://localhost:${platformConfig.port}/api/health`);
    console.log(`[服务启动] Skill 目录: ${skillsDir}`);
    console.log(`[服务启动] 已注册 Skills: ${registry.listAll().length} 个`);
    console.log(`[服务启动] LLM 模型: ${llmClient.getCurrentConfig().model}`);
    console.log(`[服务启动] LLM Endpoint: ${llmClient.getCurrentConfig().baseUrl}`);
    if (platformConfig.demoMode) {
      console.warn('[演示模式] --demo 已启用：所有 LLM 调用返回模拟数据（结果带 mock: true 标记），不代表真实模型输出');
    }
  } catch (err) {
    console.error('[启动失败]', err);
    process.exit(1);
  }

  const shutdown = async () => {
    console.log('\n[关闭中] 正在保存数据...');
    // P1-2：先中止全部在跑任务 — 否则 Ctrl+C 会留下还在执行的脚本孤儿进程
    const aborted = abortAll();
    if (aborted > 0) {
      console.log(`[关闭中] 已中止 ${aborted} 个在跑任务（脚本子进程按进程树强杀）`);
      await new Promise(resolve => setTimeout(resolve, 200)); // 给强杀与事件落库留出时间
    }
    watcher.stop();
    await app.close();
    // SQLite WAL 下写即持久；close 放在 app.close 之后，避免关闭期间事件写入失败
    closeDb();
    console.log('[已关闭] CORAL 平台已停止');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[致命错误]', err);
  process.exit(1);
});
