import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryService } from '../memory-service.js';
import { MemoryEntityService } from '../memory-entity-service.js';

/**
 * A3 混合检索排序 + B5 实体索引：
 *  · 新近度：文件尾部"近期小节"的命中排前（问现状取最新条）
 *  · 统计特异性在 AND 行内匹配下不设信号（分布恒同 — 诚实移除）
 *  · 实体索引：LLM 抽取 → boostMap 加成；阈值自动启用；重索引更新；关闭保留
 */

let dir: string;
let svc: MemoryService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coral-memrank-'));
  svc = new MemoryService(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('A3 — 混合检索排序', () => {
  it('新近度：同一文件内，尾部近期小节的命中排在旧条目之前', () => {
    svc.write('topic.md', [
      '## 2024-01-01 · 旧记录',
      '服务器端口是 3000',
      ...(Array.from({ length: 45 }, (_, i) => `填充行 ${i}`)), // 把旧记录推出"近期窗口"
      '## 2026-11-22 · 新记录',
      '服务器端口是 3001',
    ].join('\n'));
    const r = svc.search('服务器 端口');
    expect(r.matches.length).toBe(2);
    expect(r.matches[0].text).toContain('3001'); // 新条目排前
    expect(r.matches[1].text).toContain('3000');
  });

  it('AND 行内匹配下统计特异性不设信号（诚实回归：全部词必在匹配行 → 分布恒同）', () => {
    svc.write('a.md', '模型 qwen 配置');
    svc.write('b.md', '模型 k8s 配置');
    // '模型 配置' 在两文件都命中 — 排序仅由新近度/实体决定，不因"特异性"翻转
    const r = svc.search('模型 配置');
    expect(r.matches).toHaveLength(2);
    expect(r.matches.every(m => typeof m.score === 'number')).toBe(true);
  });

  it('实体索引加成：命中已知实体的行排前', () => {
    svc.write('x.md', Array.from({ length: 50 }, () => '配置说明').join('\n') + '\nGLM 配置要点');
    svc.write('y.md', Array.from({ length: 50 }, () => '配置说明').join('\n') + '\n其他配置要点');
    const plain = svc.search('glm 配置');
    // 无索引：两行同分（顺序按文件）
    // 有索引：GLM 是实体且出现在 x.md → x.md 的行加成
    const boosted = svc.search('glm 配置', 50, { entityIndex: { glm: ['x.md'] } });
    expect(boosted.matches[0].file).toBe('x.md');
    expect(boosted.matches[0].text).toContain('GLM');
  });
});

describe('B5 — 实体索引服务', () => {
  const stubLlm = (entities: string[]) => ({
    async chat() { return { content: JSON.stringify({ entities }) }; },
    isDemoMode: () => false,
  });

  it('indexFile 抽取入索引；boostMap 提供加成视图；summary 汇总', async () => {
    svc.write('api.md', 'GLM-5.3 的调用注意超时；agent-reach 需要 PATH');
    const es = new MemoryEntityService(dir);
    const n = await es.indexFile(svc, stubLlm(['GLM-5.3', 'agent-reach']) as any, 'api.md');
    expect(n).toBe(2);
    const bm = es.boostMap();
    expect(bm['glm-5.3']).toEqual(['api.md']);
    expect(bm['agent-reach']).toEqual(['api.md']);
    expect(es.summary().entityCount).toBe(2);
  });

  it('重索引：内容变更后旧实体被替换（不留脏条目）', async () => {
    svc.write('f.md', '用 GLM-5.3');
    const es = new MemoryEntityService(dir);
    await es.indexFile(svc, stubLlm(['GLM-5.3']) as any, 'f.md');
    svc.write('f.md', '改用 DeepSeek');
    await es.indexFile(svc, stubLlm(['DeepSeek']) as any, 'f.md');
    const bm = es.boostMap();
    expect(bm['glm-5.3']).toBeUndefined();
    expect(bm['deepseek']).toEqual(['f.md']);
  });

  it('阈值自动启用：文件数 < 阈值不生效，≥ 阈值生效；关闭永不生效', async () => {
    svc.write('one.md', 'a'); svc.write('two.md', 'b');
    const es = new MemoryEntityService(dir);
    expect(es.active(svc, { entityIndexEnabled: true, entityIndexThreshold: 3 })).toBe(false); // 2 < 3
    svc.write('three.md', 'c');
    expect(es.active(svc, { entityIndexEnabled: true, entityIndexThreshold: 3 })).toBe(true); // 3 >= 3
    expect(es.active(svc, { entityIndexEnabled: false, entityIndexThreshold: 1 })).toBe(false); // 关闭永不
  });

  it('backfill 全量入索引（单文件失败不中断）', async () => {
    svc.write('a.md', '内容 A'); svc.write('b.md', '内容 B');
    const es = new MemoryEntityService(dir);
    let call = 0;
    const llm = {
      async chat() { call++; if (call === 1) throw new Error('boom'); return { content: JSON.stringify({ entities: ['E' + call] }) }; },
      isDemoMode: () => false,
    };
    const r = await es.backfill(svc, llm as any);
    expect(r.files).toBe(2);      // 两个文件都处理了
    expect(r.entities).toBe(1);   // 一个失败一个成功
  });
});
