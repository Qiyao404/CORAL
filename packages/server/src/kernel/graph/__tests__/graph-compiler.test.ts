import { describe, it, expect } from 'vitest';
import { compileGoalToGraph, extractYamlBlock, type SkillPlanningHint, type CompilerLLM } from '../graph-compiler.js';

const SKILLS: SkillPlanningHint[] = [
  { name: 'web-reader', description: '读取网页正文', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
  { name: 'summarize-document', description: '文档摘要', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  {
    name: 'policy-scraper',
    description: '政策采集',
    xPlanning: { site_aliases: { '广东工信厅': 'gd.miit.gov.cn' } },
  },
];

function llmWith(responses: string[]): CompilerLLM & { calls: any[] } {
  const calls: any[] = [];
  let i = 0;
  return {
    calls,
    async complete(messages: any, options?: any) {
      calls.push({ messages, options });
      const content = responses[Math.min(i++, responses.length - 1)];
      return { content };
    },
  };
}

const GOOD_YAML = '```yaml\nname: read-and-summarize\ndescription: 读取并总结\nnodes:\n  - id: read\n    type: skill\n    skill: web-reader\n    input:\n      url: "${{ input.url }}"\n  - id: summarize\n    type: skill\n    skill: summarize-document\n    input:\n      text: "${{ nodes.read.outputs.text }}"\nedges:\n  - { from: read, to: summarize }\n```';

describe('graph-compiler — goal→graph 编译（M2-3）', () => {
  it('合法输出：提取 YAML 块 → 校验通过 → 返回 graph + yaml', async () => {
    const llm = llmWith([GOOD_YAML]);
    const r = await compileGoalToGraph('总结这个网页', SKILLS, llm);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.graph.nodes).toHaveLength(2);
      expect(r.graph.nodes[0].skill).toBe('web-reader');
      expect(r.attempts).toBe(1);
      expect(r.yaml).toContain('read-and-summarize');
    }
    // x-planning 提示注入了目录
    const user = llm.calls[0].messages[1].content as string;
    expect(user).toContain('site_aliases');
    expect(user).toContain('广东工信厅');
  });

  it('校验失败 → 带错误反馈重试一次；第二次通过则成功（attempts=2）', async () => {
    const bad = '```yaml\nname: broken\nnodes:\n  - id: a\n    type: skill\n    skill: ghost-skill\nedges: []\n```';
    const llm = llmWith([bad, GOOD_YAML]);
    const r = await compileGoalToGraph('总结这个网页', SKILLS, llm);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attempts).toBe(2);
    // 第二次调用的提示包含第一次的错误反馈
    const retryUser = llm.calls[1].messages[1].content as string;
    expect(retryUser).toContain('ghost-skill');
  });

  it('两次都失败 → 报错（A8：不静默降级为兜底 graph）', async () => {
    const bad = 'not: even: valid: yaml: [';
    const llm = llmWith([bad, bad]);
    const r = await compileGoalToGraph('x', SKILLS, llm);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('编译失败');
  });

  it('LLM 异常 → 报错而非崩溃', async () => {
    const llm = {
      async complete() { throw new Error('boom'); },
    };
    const r = await compileGoalToGraph('x', SKILLS, llm);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('LLM 调用失败');
  });

  it('空 goal / 空技能清单直接拒绝', async () => {
    const llm = llmWith([GOOD_YAML]);
    expect((await compileGoalToGraph('  ', SKILLS, llm)).ok).toBe(false);
    expect((await compileGoalToGraph('x', [], llm)).ok).toBe(false);
  });

  it('extractYamlBlock：围栏/裸 YAML/带 prose 均可提取', () => {
    expect(extractYamlBlock('```yaml\na: 1\n```')).toBe('a: 1');
    expect(extractYamlBlock('好的，这是结果：\n```\nname: x\n```\n以上')).toBe('name: x');
    expect(extractYamlBlock('name: bare')).toBe('name: bare');
  });
});
