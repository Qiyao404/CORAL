import type { FastifyInstance } from 'fastify';
import type { McpClientService } from '../services/mcp-client-service.js';

/**
 * M3-2/M3-4：MCP 管理 API。
 *  · GET    /api/mcp/servers              列表（含 tool_count/tools_preview/last_error）
 *  · POST   /api/mcp/servers              添加并连接（stdio: command+args+env / http: url）
 *  · PATCH  /api/mcp/servers/:id          启停 { enabled }
 *  · POST   /api/mcp/servers/:id/reconnect 重连（重试）
 *  · DELETE /api/mcp/servers/:id          删除（断开连接）
 *  · GET    /api/mcp/claude-desktop-config 生成 Claude Desktop 接入 CORAL 的 JSON 片段（DoD 助手）
 */
export function registerMcpRoutes(app: FastifyInstance, mcpClient: McpClientService): void {
  app.get('/api/mcp/servers', async () => {
    return { items: mcpClient.listServers() };
  });

  app.post('/api/mcp/servers', async (request, reply) => {
    const body = (request.body || {}) as {
      name?: string;
      transport?: 'stdio' | 'http';
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
    };
    if (typeof body.name !== 'string' || (body.transport !== 'stdio' && body.transport !== 'http')) {
      return reply.status(400).send({ error: '需要 name 和 transport（stdio/http）' });
    }
    const r = await mcpClient.addServer({
      name: body.name,
      transport: body.transport,
      command: body.command,
      args: body.args,
      url: body.url,
      env: body.env,
    });
    if (!r.ok) return reply.status(400).send({ error: r.message });
    return reply.status(201).send(r);
  });

  app.patch('/api/mcp/servers/:id', async (request, reply) => {
    const { id } = request.params as any;
    const body = (request.body || {}) as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') {
      return reply.status(400).send({ error: '需要 enabled（boolean）' });
    }
    const r = await mcpClient.setEnabled(id, body.enabled);
    if (!r.ok) return reply.status(404).send({ error: r.message });
    return r;
  });

  app.post('/api/mcp/servers/:id/reconnect', async (request, reply) => {
    const { id } = request.params as any;
    const r = await mcpClient.reconnect(id);
    if (!r.ok) return reply.status(400).send({ error: r.message });
    return r;
  });

  app.delete('/api/mcp/servers/:id', async (request, reply) => {
    const { id } = request.params as any;
    const r = await mcpClient.removeServer(id);
    if (!r.ok) return reply.status(404).send({ error: r.message });
    return r;
  });

  // DoD 助手：生成 Claude Desktop 配置片段（指向本机 CORAL 的 mcp serve 入口）
  app.get('/api/mcp/claude-desktop-config', async () => {
    const { platform } = await import('os');
    const repo = process.cwd().replace(/\\/g, '/');
    const isWin = platform() === 'win32';
    return {
      hint: '把下面的 coral 条目合并进 Claude Desktop 的 claude_desktop_config.json（mcpServers 字段）',
      config: {
        coral: {
          command: 'npx',
          args: ['tsx', `${repo}/src/mcp/serve.ts`],
          ...(isWin ? { note: 'Windows 下若 npx 不可用，改为 node 与 tsx 的绝对路径' } : {}),
        },
      },
    };
  });
}
