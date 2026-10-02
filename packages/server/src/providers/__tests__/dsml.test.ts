import { describe, it, expect } from 'vitest';
import { parseDsmlToolCalls, OpenAICompatProvider } from '../openai-compat.js';
import type { ProviderConfig } from '../types.js';

/** 真实故障样本（2026-10-03 DeepSeek deepseek-chat 实测输出，含截断的收尾标记） */
const REAL_DSML = `I'll fetch the page content and summarize it.

<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="memory_search">
<｜｜DSML｜｜ parameter name="query" string="true">example.com 网页 摘要 任务</｜｜DSML｜｜ parameter>
</｜｜DSML`;

describe('parseDsmlToolCalls — DeepSeek 工具调用退化归一化', () => {
  it('真实样本：解析出工具名与字符串参数，剩余正文为前置语句', () => {
    const r = parseDsmlToolCalls(REAL_DSML)!;
    expect(r).not.toBeNull();
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].name).toBe('memory_search');
    expect(r.toolCalls[0].input).toEqual({ query: 'example.com 网页 摘要 任务' });
    expect(r.remaining).toBe("I'll fetch the page content and summarize it.");
  });

  it('JSON 型参数值被解析为对象/数字', () => {
    const dsml = `<｜｜DSML｜｜ invoke name="http_fetch">` +
      `<｜｜DSML｜｜ parameter name="url" string="true">https://x.com</｜｜DSML｜｜ parameter>` +
      `<｜｜DSML｜｜ parameter name="timeout_ms" string="true">5000</｜｜DSML｜｜ parameter>` +
      `</｜｜DSML｜｜ calls>`;
    const r = parseDsmlToolCalls(dsml)!;
    expect(r.toolCalls[0].input).toEqual({ url: 'https://x.com', timeout_ms: 5000 });
    expect(r.remaining).toBe('');
  });

  it('多次 invoke 全部解析', () => {
    const dsml = `<｜｜DSML｜｜ invoke name="a_tool">` +
      `<｜｜DSML｜｜ parameter name="p" string="true">1</｜｜DSML｜｜ parameter>` +
      `<｜｜DSML｜｜ invoke name="b_tool">` +
      `<｜｜DSML｜｜ parameter name="q" string="true">2</｜｜DSML｜｜ parameter>`;
    const r = parseDsmlToolCalls(dsml)!;
    expect(r.toolCalls.map(t => t.name)).toEqual(['a_tool', 'b_tool']);
  });

  it('无 DSML / 无 invoke → null（正常内容不受影响）', () => {
    expect(parseDsmlToolCalls('普通最终回答')).toBeNull();
    expect(parseDsmlToolCalls('内容里提到 DSML 这个词但没有调用')).toBeNull();
  });

  it('provider 集成：退化响应被转正（stub 返回 DSML content）', async () => {
    const stub = {
      chat: { completions: { create: async () => ({
        choices: [{ message: { content: REAL_DSML }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }) } },
    };
    const config: ProviderConfig = { provider: 'openai-compat', baseUrl: '', apiKey: 't', model: 'm', clientOverride: stub };
    const p = new OpenAICompatProvider(config, { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 });

    const r = await p.complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'memory_search', description: 'd', inputSchema: { type: 'object' } }],
    });
    expect(r.degraded).toBe(true);
    expect(r.stopReason).toBe('tool_use');
    expect(r.toolCalls[0].name).toBe('memory_search');
    expect(r.content).toBe("I'll fetch the page content and summarize it.");
  });
});
