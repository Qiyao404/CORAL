import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getDb } from '../store/db.js';
import { nanoid } from 'nanoid';
import type { Tool, ToolResult } from '../tools/types.js';

/**
 * M3-2：McpClientService — 外部 MCP server 接入（双向桥的"入"方向）。
 *
 *  · mcp_servers 表（001 迁移预留）持久化：stdio（command+args+env）/ http（url）
 *  · 连接成功 → listTools → 每个工具包一层 CORAL Tool（命名 mcp_<server>_<tool>，
 *    非法字符归一为 _）进 listMcpTools()；RunEngine.buildTools 合并进 agent 工具集
 *  · 失败隔离：单个 server 连不上/挂掉只记 last_error 并跳过 — 不影响其余 server
 *    与平台自身工具；调用期错误按 TOOL_CRASHED 返回（不炸 loop）
 *  · 生命周期：add/connect 启动即连；断线不自动重连（enable/disable 或重启触发重连）
 */

export interface McpServerRow {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string | null;
  args_json?: string | null;
  url?: string | null;
  env_json?: string | null;
  enabled: number;
  tool_count?: number | null;
  last_error?: string | null;
  tools_preview?: string | null;
  created_at: string;
  updated_at: string;
}

interface ConnectedServer {
  row: McpServerRow;
  client: Client;
  tools: Tool[];
}

function nowIso() {
  return new Date().toISOString();
}

function stmt(sql: string) {
  return getDb().prepare(sql);
}

/** 工具名归一：MCP 工具名允许的点号等 → 下划线（CORAL TOOL_NAME_REGEX 兼容） */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class McpClientService {
  private connected = new Map<string, ConnectedServer>();

  // ─── CRUD（mcp_servers 表；001 迁移预留，args/tools_preview 由 004 补列）───

  listServers(): McpServerRow[] {
    this.ensureColumns();
    return stmt(`SELECT * FROM mcp_servers ORDER BY created_at DESC`).all() as McpServerRow[];
  }

  async addServer(input: {
    name: string;
    transport: 'stdio' | 'http';
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  }): Promise<{ ok: boolean; message: string; server?: McpServerRow; connectedTools?: number }> {
    this.ensureColumns();
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(input.name)) {
      return { ok: false, message: '名称须匹配 [a-zA-Z][a-zA-Z0-9_-]*（用于工具前缀 mcp_<name>_…）' };
    }
    const exists = stmt(`SELECT id FROM mcp_servers WHERE name = ?`).get(input.name);
    if (exists) return { ok: false, message: `同名 server 已存在: ${input.name}` };
    if (input.transport === 'stdio' && !input.command) return { ok: false, message: 'stdio 需要 command' };
    if (input.transport === 'http' && !input.url) return { ok: false, message: 'http 需要 url' };

    const id = `mcp_${nanoid(8)}`;
    const ts = nowIso();
    stmt(`INSERT INTO mcp_servers (id, name, transport, command, args_json, url, env_json, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
      id, input.name, input.transport, input.command ?? null,
      input.args ? JSON.stringify(input.args) : null,
      input.url ?? null, input.env ? JSON.stringify(input.env) : null, ts, ts
    );
    const server = this.getServer(id)!;
    // 添加即连接（失败不阻塞添加 — 记 last_error，可稍后重试）
    return { ...(await this.finishAdd(id, server)) };
  }

  private async finishAdd(id: string, server: McpServerRow): Promise<{ ok: boolean; message: string; server?: McpServerRow; connectedTools?: number }> {
    const connectResult = await this.connectOne(server);
    return {
      ok: true,
      message: connectResult.ok ? `已连接（${connectResult.tools} 个工具）` : `已保存但连接失败: ${connectResult.error}`,
      server: this.getServer(id) ?? undefined,
      connectedTools: connectResult.tools,
    };
  }

  getServer(id: string): McpServerRow | null {
    this.ensureColumns();
    return (stmt(`SELECT * FROM mcp_servers WHERE id = ?`).get(id) as McpServerRow) ?? null;
  }

  async setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; message: string }> {
    const server = this.getServer(id);
    if (!server) return { ok: false, message: 'server 不存在' };
    stmt(`UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?`).run(enabled ? 1 : 0, nowIso(), id);
    if (enabled) {
      const r = await this.connectOne(this.getServer(id)!);
      return { ok: true, message: r.ok ? `已启用并连接（${r.tools} 个工具）` : `已启用但连接失败: ${r.error}` };
    }
    await this.disconnectOne(id);
    return { ok: true, message: '已停用（连接已断开）' };
  }

  async removeServer(id: string): Promise<{ ok: boolean; message: string }> {
    const server = this.getServer(id);
    if (!server) return { ok: false, message: 'server 不存在' };
    await this.disconnectOne(id);
    stmt(`DELETE FROM mcp_servers WHERE id = ?`).run(id);
    return { ok: true, message: '已删除' };
  }

  /** 重连（管理页"重试"按钮） */
  async reconnect(id: string): Promise<{ ok: boolean; message: string }> {
    const server = this.getServer(id);
    if (!server) return { ok: false, message: 'server 不存在' };
    const r = await this.connectOne(server);
    return { ok: r.ok, message: r.ok ? `已连接（${r.tools} 个工具）` : `连接失败: ${r.error}` };
  }

  // ─── 工具暴露（RunEngine.buildTools 合并）───

  /** 全部已连接 server 的工具（扁平；禁用/未连上的自然缺席 = 失败隔离） */
  listMcpTools(): Tool[] {
    const tools: Tool[] = [];
    for (const [, cs] of this.connected) tools.push(...cs.tools);
    return tools;
  }

  /** 启动时批量连接全部 enabled server（单个失败继续下一个） */
  async connectAll(): Promise<number> {
    let n = 0;
    for (const server of this.listServers()) {
      if (!server.enabled) continue;
      if ((await this.connectOne(server)).ok) n++;
    }
    return n;
  }

  async closeAll(): Promise<void> {
    for (const [id] of this.connected) await this.disconnectOne(id);
  }

  // ─── 内部 ───

  private ensureColumns(): void {
    // 004 迁移补列（幂等 — SQL 若报错说明已存在）
    try {
      getDb().exec(`ALTER TABLE mcp_servers ADD COLUMN args_json TEXT`);
      getDb().exec(`ALTER TABLE mcp_servers ADD COLUMN tools_preview TEXT`);
    } catch { /* 已存在 */ }
  }

  /** 连接单个 server：connect + listTools 全程 await（成败真实返回；失败记 last_error） */
  private async connectOne(server: McpServerRow): Promise<{ ok: boolean; tools?: number; error?: string }> {
    try {
      const client = new Client({ name: 'coral-client', version: '2.0.0-m3' });
      const transport = server.transport === 'stdio'
        ? new StdioClientTransport({
            command: server.command!,
            args: server.args_json ? JSON.parse(server.args_json) : [],
            // SDK 默认只给最小 env — 显式继承宿主（否则 .env/路径变量到不了子进程）+ 用户覆盖
            env: { ...process.env, ...(server.env_json ? JSON.parse(server.env_json) : {}) } as any,
          })
        : new StreamableHTTPClientTransport(new URL(server.url!));

      // 审查 P1：重连/启停先断旧连接（否则 stdio 子进程泄漏）
      await this.disconnectOne(server.id);
      await client.connect(transport);
      const listed = await client.listTools().catch(async err => {
        await client.close().catch(() => {}); // 连接成功但列工具失败 → 也要释放子进程
        throw err;
      });
      const tools: Tool[] = listed.tools.map(t => this.wrapTool(server, client, t));
      this.connected.set(server.id, { row: server, client, tools });
      stmt(`UPDATE mcp_servers SET tool_count = ?, tools_preview = ?, last_error = NULL, updated_at = ? WHERE id = ?`)
        .run(
          tools.length,
          JSON.stringify(listed.tools.map(t => ({ name: t.name, description: (t.description ?? '').slice(0, 120) }))),
          nowIso(), server.id
        );
      return { ok: true, tools: tools.length };
    } catch (err: any) {
      this.markError(server.id, err);
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  private wrapTool(server: McpServerRow, client: Client, t: { name: string; description?: string; inputSchema?: any }): Tool {
    const fullName = `mcp_${sanitizeToolName(server.name)}_${sanitizeToolName(t.name)}`;
    const self = this;
    return {
      name: fullName,
      description: `[${server.name}] ${t.description ?? t.name}`,
      inputSchema: (t.inputSchema && typeof t.inputSchema === 'object' && t.inputSchema.type === 'object')
        ? t.inputSchema
        : { type: 'object' },
      source: 'mcp' as any,
      permission: 'auto',
      async invoke(input: any, ctx?: any): Promise<ToolResult> {
        try {
          // 审查 P2：MCP 调用接超时与取消（防对端挂起导致 run 永久卡在此工具）
          const TIMEOUT = 60_000;
          const timed = (ctx?.signal ? ctx.signal : undefined);
          const r = await Promise.race([
            client.callTool({ name: t.name, arguments: input ?? {} }),
            new Promise<never>((_, rej) => {
              const timer = setTimeout(() => rej(new Error(`MCP 工具 ${t.name} 超时（${TIMEOUT / 1000}s）`)), TIMEOUT);
              timed?.addEventListener('abort', () => { clearTimeout(timer); rej(new Error('已取消')); }, { once: true });
            }),
          ]);
          const text = Array.isArray(r.content)
            ? r.content.map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
            : JSON.stringify(r);
          return { ok: !r.isError, data: { text } };
        } catch (err: any) {
          // 失败隔离：单个工具调用错误不外溢（记错误并返回给模型可读的错误）
          self.markError(server.id, err);
          return { ok: false, error: { code: 'MCP_CALL_FAILED', message: `MCP 工具 ${t.name} 调用失败: ${err?.message ?? String(err)}`, retryable: false } };
        }
      },
    };
  }

  private markError(serverId: string, err: unknown): void {
    try {
      stmt(`UPDATE mcp_servers SET last_error = ?, updated_at = ? WHERE id = ?`)
        .run(String((err as any)?.message ?? err).slice(0, 500), nowIso(), serverId);
    } catch { /* ignore */ }
  }

  private async disconnectOne(id: string): Promise<void> {
    const cs = this.connected.get(id);
    if (!cs) return;
    this.connected.delete(id);
    try { await cs.client.close(); } catch { /* ignore */ }
  }
}
