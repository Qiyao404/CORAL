import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-llm-demo-'));
// 隔离真实库 + 显式开启 demo 模式（等价于 --demo 启动）
process.env.DATABASE_PATH = join(tmp, 'llm.db');
process.env.CORAL_DEMO_MODE = '1';

const { llmClient } = await import('../../services/llm-client.js');
const { closeDb } = await import('../../store/index.js');

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('llm-client 显式 demo 模式（M0-5 / M1-1 facade 结构）', () => {
  it('demo 模式生效：不触碰 provider（打桩为必炸）', async () => {
    (llmClient as any).provider = {
      id: 'openai-compat',
      complete: async () => { throw new Error('demo 模式不应调用 provider'); },
      stream: async () => { throw new Error('demo 模式不应调用 provider'); },
    };
    expect(llmClient.isDemoMode()).toBe(true);

    const r = await llmClient.complete([{ role: 'user', content: 'hi' }]);
    expect(r.mocked).toBe(true); // 显式标记
    expect(r.content).toContain('Demo');
  });

  it('chat() 在 demo 模式下返回无工具调用的 end 响应（带 mocked 语义）', async () => {
    (llmClient as any).provider = {
      id: 'openai-compat',
      complete: async () => { throw new Error('demo 模式不应调用 provider'); },
      stream: async () => { throw new Error('demo 模式不应调用 provider'); },
    };
    const r = await llmClient.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.stopReason).toBe('end');
    expect(r.toolCalls).toEqual([]);
    expect(r.content).toContain('Demo');
  });

  it('规划类 prompt → 返回预设两节点计划（带 mocked 标记）', async () => {
    const r = await llmClient.complete([
      { role: 'system', content: '你是规划引擎，输出 Agent DAG，含 agents 与 edges' },
      { role: 'user', content: '请为以下目标生成执行计划: 测试目标' },
    ]);

    expect(r.mocked).toBe(true);
    const parsed = JSON.parse(r.content);
    expect(parsed.agents).toHaveLength(2);
    expect(parsed.agents[0].agentId).toBe('demo-a1');
    expect(parsed.edges[0]).toEqual({ from: 'demo-a1', to: 'demo-a2', dataMapping: { summary: 'text' } });
  });

  it('completeStream：模拟流式分片下发，内容完整且带 mocked 标记', async () => {
    const chunks: string[] = [];
    const r = await llmClient.completeStream(
      [{ role: 'user', content: 'hi' }],
      (delta) => chunks.push(delta)
    );

    expect(r.mocked).toBe(true);
    expect(chunks.length).toBeGreaterThan(1); // 确实是分片流式
    expect(chunks.join('')).toBe(r.content);  // 分片拼回完整内容
    expect(() => JSON.parse(r.content)).not.toThrow(); // 仍是合法 JSON
  });

  it('demo 流式同样尊重取消信号', async () => {
    const controller = new AbortController();
    controller.abort();

    const chunks: string[] = [];
    await expect(
      llmClient.completeStream([{ role: 'user', content: 'hi' }], d => chunks.push(d), {
        signal: controller.signal,
      })
    ).rejects.toThrow();
    expect(chunks).toHaveLength(0);
  });
});
