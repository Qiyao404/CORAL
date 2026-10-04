import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { FilesystemSkillRegistry } from '../skill-runtime/filesystem-registry.js';
import { SkillExecutor } from '../skill-runtime/skill-executor.js';
import { RunEngine } from '../kernel/run-engine.js';
import { RunStore } from '../store/run-store.js';
import { RunEventStore } from '../store/run-event-store.js';
import { CheckpointStore } from '../store/checkpoint-store.js';
import { llmClient } from '../services/llm-client.js';
import { platformConfig } from '../services/config.js';

/**
 * M3-1：`coral mcp serve` — 把 CORAL 暴露为 MCP server（stdio transport）。
 *
 * Claude Desktop / 任何 MCP 客户端配置一条 JSON 即可：
 *   { "command": "npx", "args": ["tsx", "<repo>/packages/server/src/mcp/serve.ts"] }
 *
 * 暴露的工具：
 *  · coral_run        — 发起 Free 模式 run（goal），同步等待最终结果返回
 *  · coral_list_skills — 技能清单（名称 + 描述）
 *  · coral_skill_<name> — 每个技能一个工具（按其 input_schema 调用，同步返回结果）
 *
 * 设计取舍：
 *  · 复用平台全部执行链（SkillExecutor 沙箱/进度协议/事件）— 不另起炉灶
 *  · run 同步等待（MCP 工具调用语义即请求-响应；长任务由客户端超时控制）
 *  · 载入 .env 但不启动 HTTP 服务 — 纯 stdio 进程，随客户端生命周期
 */

export interface McpServeResult {
  tools: string[];
}

async function buildServer(): Promise<{ server: McpServer; tools: string[] }> {
  const registry = new FilesystemSkillRegistry(platformConfig.skillsDir);
  await registry.reloadAll();
  const executor = new SkillExecutor(registry);

  const runEngine = new RunEngine({
    llm: llmClient,
    skillRegistry: registry,
    skillExecutor: executor,
    runStore: new RunStore(),
    eventStore: new RunEventStore(),
    checkpointStore: new CheckpointStore(),
  });

  const server = new McpServer({ name: 'coral', version: '2.0.0-m3' });
  const tools: string[] = [];

  // ── coral_run：Free 模式目标执行（同步等待最终回答）──
  server.tool(
    'coral_run',
    'Run a CORAL agent goal autonomously (Free mode ReAct loop with tools). Returns the final answer. Use for open-ended tasks; use coral_skill_* tools for direct skill invocation.',
    { goal: z.string().describe('Natural-language goal for the agent') },
    async ({ goal }) => {
      const { runId } = runEngine.startRun({ goal });
      const final = await waitForRunFinal(runEngine, runId, 10 * 60 * 1000);
      return {
        content: [{ type: 'text' as const, text: final ?? `run ${runId} 仍在执行（超时返回）` }],
      };
    }
  );
  tools.push('coral_run');

  // ── coral_list_skills：技能清单 ──
  server.tool(
    'coral_list_skills',
    'List all available CORAL skills (name + description).',
    {},
    async () => {
      const list = registry.listAll().map(m => `- ${m.name}: ${m.description}`);
      return { content: [{ type: 'text' as const, text: list.join('\n') || '(无技能)' }] };
    }
  );
  tools.push('coral_list_skills');

  // ── 每技能一个工具：coral_skill_<name> ──
  for (const manifest of registry.listAll()) {
    const toolName = `coral_skill_${manifest.name}`;
    // input_schema → zod raw shape（MCP SDK 约定）；非法 schema 降级为空对象
    const shape = zodShapeFromSchema(manifest.inputSchema);
    server.tool(
      toolName,
      `${manifest.description}（execution_mode: ${manifest.executionMode}）`,
      shape,
      async (input: Record<string, any>) => {
        const result = await executor.execute({
          skillName: manifest.name,
          input,
          context: { taskId: `mcp-${Date.now()}`, agentId: 'mcp' },
        });
        const text = result.success
          ? JSON.stringify(result.data ?? {}, null, 2)
          : `技能执行失败: ${result.error?.code} ${result.error?.message}`;
        return {
          content: [{ type: 'text' as const, text }],
          isError: !result.success,
        };
      }
    );
    tools.push(toolName);
  }

  return { server, tools };
}

/** 等 run 到终态取 final_content（轮询事件表 — MCP 工具是同步语义，这里轮询是边界适配而非调度） */
function waitForRunFinal(engine: RunEngine, runId: string, timeoutMs: number): Promise<string | null> {
  return new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      const run = engine.store.get(runId);
      if (!run) { clearInterval(timer); resolve(null); return; }
      if (['completed', 'failed', 'cancelled'].includes(run.status)) {
        clearInterval(timer);
        resolve(run.final_content ?? `[${run.status}]`);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(null);
      }
    }, 1000);
  });
}

/** JSON Schema（对象）→ zod raw shape；仅支持平台技能用到的标量/数组层 */
function zodShapeFromSchema(schema: Record<string, any> | undefined): Record<string, any> {
  const props = schema?.properties as Record<string, any> | undefined;
  if (!props || typeof props !== 'object') return {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const shape: Record<string, any> = {};
  for (const [key, def] of Object.entries(props)) {
    let zod: any;
    switch (def?.type) {
      case 'number':
      case 'integer':
        zod = z.number().describe(String(def?.description ?? ''));
        break;
      case 'boolean':
        zod = z.boolean().describe(String(def?.description ?? ''));
        break;
      case 'array':
        zod = z.array(z.any()).describe(String(def?.description ?? ''));
        break;
      case 'object':
        zod = z.any().describe(String(def?.description ?? ''));
        break;
      default:
        zod = z.string().describe(String(def?.description ?? ''));
    }
    shape[key] = required.has(key) ? zod : zod.optional();
  }
  return shape;
}

/** 入口：`npx tsx packages/server/src/mcp/serve.ts`（供 MCP 客户端 stdio 拉起） */
export async function serveStdio(): Promise<McpServeResult> {
  // dotenv 由 platformConfig（services/config.ts）加载 — 这里只建 server
  const { server, tools } = await buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 摘要写给 stderr（stdout 是协议通道，绝不能污染）
  console.error(`[coral mcp serve] 已启动：${tools.length} 个工具（${tools.slice(0, 5).join(', ')}${tools.length > 5 ? '…' : ''}）`);
  return { tools };
}

// 直接运行本文件时启动（import 时不自动启动 — 测试需要）
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('mcp/serve.ts')) {
  serveStdio().catch(err => {
    console.error('[coral mcp serve] 启动失败:', err);
    process.exit(1);
  });
}
