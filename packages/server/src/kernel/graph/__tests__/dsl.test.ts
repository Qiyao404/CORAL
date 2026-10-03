import { describe, it, expect } from 'vitest';
import {
  parseAndValidateGraphYaml,
  validateGraph,
  expandTemplates,
  resolveDotPath,
  type GraphDefinition,
} from '../dsl.js';

const graph = (over: Partial<GraphDefinition> = {}): GraphDefinition => ({
  name: 'g',
  nodes: [
    { id: 'a', type: 'skill', skill: 's1' },
    { id: 'b', type: 'skill', skill: 's2' },
  ],
  edges: [{ from: 'a', to: 'b' }],
  ...over,
});

describe('Graph DSL — 结构校验（M2-2）', () => {
  it('合法最小 graph 通过，且产出拓扑序', () => {
    const r = validateGraph(graph());
    expect(r.ok).toBe(true);
    expect(r.topoOrder).toEqual(['a', 'b']);
  });

  it('菱形四节点拓扑序合法（多父节点 = A4 修复的基础场景）', () => {
    const r = validateGraph(graph({
      nodes: [
        { id: 'root', type: 'skill', skill: 's' },
        { id: 'l', type: 'skill', skill: 's' },
        { id: 'r', type: 'skill', skill: 's' },
        { id: 'join', type: 'skill', skill: 's' },
      ],
      edges: [
        { from: 'root', to: 'l' }, { from: 'root', to: 'r' },
        { from: 'l', to: 'join' }, { from: 'r', to: 'join' },
      ],
    }));
    expect(r.ok).toBe(true);
    expect(r.topoOrder![0]).toBe('root');
    expect(r.topoOrder!.slice(1, 3).sort()).toEqual(['l', 'r']);
    expect(r.topoOrder![3]).toBe('join');
  });

  it('非对象顶层 / 空 nodes / 缺 name 各自报 issue', () => {
    expect(validateGraph('just a string').ok).toBe(false);
    expect(validateGraph({ nodes: [] }).issues.map(i => i.path)).toContain('nodes');
    expect(validateGraph({ nodes: graph().nodes }).issues.some(i => i.path === 'name')).toBe(true);
  });

  it('节点 id 重复 / 非法 id 报 issue', () => {
    const r = validateGraph(graph({
      nodes: [
        { id: 'a', type: 'skill', skill: 's' },
        { id: 'a', type: 'skill', skill: 's' },
        { id: '9bad', type: 'skill', skill: 's' },
      ],
      edges: [],
    }));
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.message.includes('重复'))).toBe(true);
    expect(r.issues.some(i => i.path.includes('9bad') || i.message.includes('9bad'))).toBe(true);
  });

  it('未知 type / 缺 skill / 非法 on_empty / retries 越界 / 非法 permission 均拦截', () => {
    const r = validateGraph(graph({
      nodes: [
        { id: 'a', type: 'http' as any, skill: 's' },
        { id: 'b', type: 'skill', skill: '' },
        { id: 'c', type: 'skill', skill: 's', on_empty: 'explode' as any },
        { id: 'd', type: 'skill', skill: 's', retries: 99 },
        { id: 'e', type: 'skill', skill: 's', permission: 'maybe' as any },
        { id: 'f', type: 'skill', skill: 's', timeout_ms: 1 },
      ],
      edges: [],
    }));
    expect(r.ok).toBe(false);
    const msgs = r.issues.map(i => i.message).join('\n');
    expect(msgs).toContain('type');
    expect(msgs).toContain('skill 必填');
    expect(msgs).toContain('on_empty');
    expect(msgs).toContain('retries');
    expect(msgs).toContain('permission');
    expect(msgs).toContain('timeout_ms');
  });

  it('边引用不存在节点 / 自环 拦截', () => {
    const r = validateGraph(graph({
      edges: [
        { from: 'a', to: 'ghost' },
        { from: 'a', to: 'a' },
      ],
    }));
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.message.includes('ghost'))).toBe(true);
    expect(r.issues.some(i => i.message.includes('自环'))).toBe(true);
  });

  it('环检测：两节点互指报环且含节点名', () => {
    const r = validateGraph(graph({
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    }));
    expect(r.ok).toBe(false);
    expect(r.issues[0].message).toContain('环');
  });

  it('input 默认值写成 JSON Schema（AI 编排实测踩坑）→ 校验拦截并给出可读提示', () => {
    const r = validateGraph(graph({
      input: { urls: { type: 'array', items: { type: 'string' }, description: 'URL 列表' } },
    }));
    expect(r.ok).toBe(false);
    const issue = r.issues.find(i => i.path === 'input.urls')!;
    expect(issue.message).toContain('JSON Schema');
    // 正常对象默认值不受影响（无 items/properties 组合）
    const ok = validateGraph(graph({ input: { url: 'https://example.com', meta: { kind: 'x' } } }));
    expect(ok.ok).toBe(true);
  });

  it('YAML 文本入口：语法错误包装为 issue；合法文本返回 graph', () => {
    const bad = parseAndValidateGraphYaml('nodes: [unclosed');
    expect(bad.ok).toBe(false);
    expect(bad.issues[0].message).toContain('YAML 语法错误');

    const good = parseAndValidateGraphYaml(`
name: demo
nodes:
  - id: fetch
    type: skill
    skill: web-reader
    input:
      url: "\${{ input.url }}"
edges: []
`);
    expect(good.ok).toBe(true);
    expect(good.graph!.nodes[0].input!.url).toBe('${{ input.url }}');
  });
});

describe('Graph DSL — 模板展开', () => {
  it('整串引用保留原类型（对象/数组/数字不被字符串化）', () => {
    const r = expandTemplates('${{ nodes.a.outputs.list }}', {
      input: {},
      nodes: { a: { outputs: { list: [1, 2, 3] } } },
    });
    expect(r.value).toEqual([1, 2, 3]);
    expect(r.missing).toEqual([]);
  });

  it('字符串内嵌拼接；未解析引用记入 missing 并展开为空串', () => {
    const r = expandTemplates(
      { title: '报告: ${{ input.topic }}', ref: '${{ nodes.x.outputs.nope }}' },
      { input: { topic: '政策' }, nodes: { x: { outputs: {} } } },
    );
    expect((r.value as any).title).toBe('报告: 政策');
    expect((r.value as any).ref).toBeUndefined();
    expect(r.missing).toEqual(['nodes.x.outputs.nope']);
  });

  it('嵌套结构递归展开 + 点路径支持数组下标', () => {
    const r = expandTemplates(
      { files: ['${{ nodes.s.outputs.items.0.name }}'], meta: { deep: '${{ input.a.b }}' } },
      { input: { a: { b: 7 } }, nodes: { s: { outputs: { items: [{ name: 'f.md' }] } } } },
    );
    expect(r.value).toEqual({ files: ['f.md'], meta: { deep: 7 } });
  });

  it('resolveDotPath：越界/类型不匹配返回 undefined 而非抛错', () => {
    expect(resolveDotPath({ a: [1, 2] }, 'a.1')).toBe(2);
    expect(resolveDotPath({ a: [1, 2] }, 'a.5')).toBeUndefined();
    expect(resolveDotPath({ a: 'str' }, 'a.b')).toBeUndefined();
    expect(resolveDotPath(null, 'a')).toBeUndefined();
  });
});
