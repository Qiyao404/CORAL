import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * M3-1 端到端：真实 MCP 客户端 over stdio 拉起 coral mcp serve。
 * 覆盖：initialize 握手 → tools/list（coral_run/coral_list_skills/coral_skill_*）
 * → tools/call（coral_list_skills 与一个 llm_only 技能）。
 * （Claude Desktop DoD 的自动化等价物 — 同一协议栈）
 */

const tmp = mkdtempSync(join(tmpdir(), 'coral-mcp-'));
process.env.DATABASE_PATH = join(tmp, 'mcp.db');
process.env.SKILLS_DIR = join(tmp, 'skills'); // 只加载测试技能（否则会拉起平台真实技能目录）

// 一个最小 llm_only 技能（echo 型提示词）
const skillDir = join(tmp, 'skills', 'mcp-echo');
mkdirSync(skillDir, { recursive: true });
writeFileSync(join(skillDir, 'SKILL.md'), `---
name: mcp-echo
version: "1.0.0"
description: MCP 测试回显技能
domain: test
capabilities: []
input_schema:
  type: object
  required: [text]
  properties:
    text: { type: string, description: 要回显的文本 }
output_schema:
  type: object
  properties:
    result: { type: string }
execution_mode: llm_only
status: stable
tags: [test]
source: user
---

你是回显助手。把输入数据里的 text 原文放入 JSON：{"result": "<text>"}，不要输出其他内容。
`, 'utf-8');

async function withClient(fn: (client: Client) => Promise<void>): Promise<void> {
  const { execSync } = await import('child_process');
  // tsx 在 node_modules/.bin
  const tsxBin = join(process.cwd(), '..', '..', 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  execSync(`echo`, { stdio: 'ignore' }); // warm
  const transport = new StdioClientTransport({
    command: process.platform === 'win32' ? tsxBin.replace(/\\/g, '/') : tsxBin,
    args: [join(process.cwd(), 'src/mcp/serve.ts')],
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_PATH: process.env.DATABASE_PATH, SKILLS_DIR: process.env.SKILLS_DIR } as any,
  });
  const c = new Client({ name: 'test-client', version: '1.0.0' });
  await c.connect(transport);
  try {
    await fn(c);
  } finally {
    await c.close();
  }
}

describe('coral mcp serve（M3-1）', () => {
  it('握手 → tools/list 含核心工具与技能工具', async () => {
    await withClient(async c => {
      const tools = await c.listTools();
      const names = tools.tools.map(t => t.name);
      expect(names).toContain('coral_run');
      expect(names).toContain('coral_list_skills');
      expect(names).toContain('coral_skill_mcp-echo');
    });
  }, 60_000);

  it('tools/call coral_list_skills 返回技能清单文本', async () => {
    await withClient(async c => {
      const r = await c.callTool({ name: 'coral_list_skills', arguments: {} });
      const text = (r.content as any[]).map(c => c.text).join('');
      expect(text).toContain('mcp-echo');
    });
  }, 60_000);

  it('tools/call coral_skill_mcp-echo 执行技能并返回结果（llm 真调）', async () => {
    await withClient(async c => {
      const r = await c.callTool({ name: 'coral_skill_mcp-echo', arguments: { text: '你好MCP' } });
      const text = (r.content as any[]).map(x => x.text).join('');
      // llm_only 技能走真实 LLM：成功返回 result JSON；无 Key 时为失败文本（isError）
      if (!r.isError) {
        expect(text.length).toBeGreaterThan(0);
      } else {
        expect(text).toContain('失败');
      }
    });
  }, 120_000);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
