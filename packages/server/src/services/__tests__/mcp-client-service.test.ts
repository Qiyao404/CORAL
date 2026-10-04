import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-mcpc-'));
process.env.DATABASE_PATH = join(tmp, 'mcp.db');
process.env.SKILLS_DIR = join(tmp, 'skills');

const skillDir = join(tmp, 'skills', 'mcp-echo');
mkdirSync(skillDir, { recursive: true });
writeFileSync(join(skillDir, 'SKILL.md'), `---
name: mcp-echo
version: "1.0.0"
description: MCP 双向桥测试技能
domain: test
capabilities: []
input_schema:
  type: object
  properties:
    text: { type: string, description: 文本 }
output_schema:
  type: object
  properties:
    result: { type: string }
execution_mode: llm_only
status: stable
tags: [test]
source: user
---

你是回显助手。
`, 'utf-8');

const { McpClientService } = await import('../mcp-client-service.js');
const { getDb, closeDb } = await import('../../store/db.js');

let svc: McpClientService;

beforeAll(() => {
  svc = new McpClientService();
});
afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('McpClientService — 外部 server 接入（M3-2，DoD：挂一个 server 后工具可用）', () => {
  it('添加 stdio server（CORAL 自己的 mcp serve — 双向桥自环）→ 工具进 listMcpTools', async () => {
    const tsxBin = join(process.cwd(), '..', '..', 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
    const r = await svc.addServer({
      name: 'coralself',
      transport: 'stdio',
      command: tsxBin.replace(/\\/g, '/'),
      args: [join(process.cwd(), 'src/mcp/serve.ts')],
    });
    expect(r.ok).toBe(true);
    expect(r.connectedTools ?? 0).toBeGreaterThanOrEqual(3); // coral_run + list_skills + skill 工具

    // 异步连接完成需要一点时间
    await new Promise(res => setTimeout(res, 1500));
    const tools = svc.listMcpTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('mcp_coralself_coral_run');
    expect(names).toContain('mcp_coralself_coral_list_skills');
    expect(names).toContain('mcp_coralself_coral_skill_mcp-echo');

    // 表里 tool_count/tools_preview 已更新
    const row = svc.getServer(r.server!.id)!;
    expect(row.tool_count ?? 0).toBeGreaterThanOrEqual(3);
    expect(row.last_error).toBeNull();
  }, 60_000);

  it('调用包装后的 MCP 工具（coral_list_skills）→ 返回清单文本', async () => {
    await new Promise(res => setTimeout(res, 500));
    const tool = svc.listMcpTools().find(t => t.name === 'mcp_coralself_coral_list_skills')!;
    expect(tool).toBeTruthy();
    const r = await tool.invoke({}, { runId: 't', agentId: 't', signal: new AbortController().signal, emit: () => {} } as any);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.data)).toContain('mcp-echo');
  }, 60_000);

  it('失败隔离：连不上的 server 记 last_error，不影响其他 server 的工具', async () => {
    const bad = await svc.addServer({
      name: 'badserver',
      transport: 'stdio',
      command: 'this-command-does-not-exist-xyz',
      args: [],
    });
    expect(bad.ok).toBe(true); // 添加成功但连接失败
    expect(bad.message).toContain('连接失败');
    const row = svc.getServer(bad.server!.id)!;
    expect(row.last_error).toBeTruthy();

    // 好的 server 工具照常在
    const names = svc.listMcpTools().map(t => t.name);
    expect(names).toContain('mcp_coralself_coral_list_skills');
    expect(names.some(n => n.startsWith('mcp_badserver_'))).toBe(false);
  }, 60_000);

  it('启停：disable 后工具消失，enable 后回来', async () => {
    const servers = svc.listServers();
    const coralRow = servers.find(s => s.name === 'coralself')!;
    await svc.setEnabled(coralRow.id, false);
    expect(svc.listMcpTools().some(t => t.name.startsWith('mcp_coralself_'))).toBe(false);

    const re = await svc.setEnabled(coralRow.id, true);
    expect(re.ok).toBe(true);
    await new Promise(res => setTimeout(res, 2000));
    expect(svc.listMcpTools().some(t => t.name.startsWith('mcp_coralself_'))).toBe(true);
  }, 90_000);
});
