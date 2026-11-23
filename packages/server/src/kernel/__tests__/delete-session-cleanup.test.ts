import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * REG-37：删除整个会话时，只对"列表接口返回的前 200 个 run"做了证据目录 / 检索文档的清理，
 * 而数据库删除是按会话全量的 —— 超过 200 个 run 的会话（评测会话实测 231 个）会在磁盘和
 * 全文索引里留下一批"幽灵"：run 已不存在，证据目录和检索文档还在。
 */

const tmp = mkdtempSync(join(tmpdir(), 'coral-del-sess-'));
process.env.DATABASE_PATH = join(tmp, 'fix.db');
process.env.MEMORY_DIR = join(tmp, 'memory');
process.env.SKILLS_DIR = join(tmp, 'skills');
mkdirSync(process.env.MEMORY_DIR!, { recursive: true });
mkdirSync(process.env.SKILLS_DIR!, { recursive: true });

const { RunEngine } = await import('../run-engine.js');
const { RunStore } = await import('../../store/run-store.js');
const { RunEventStore } = await import('../../store/run-event-store.js');
const { CheckpointStore } = await import('../../store/checkpoint-store.js');
const { FilesystemSkillRegistry } = await import('../../skill-runtime/filesystem-registry.js');
const { SkillExecutor } = await import('../../skill-runtime/skill-executor.js');
const { closeDb } = await import('../../store/index.js');

let engine: InstanceType<typeof RunEngine>;
const evidence = () => (engine as any).evidence as { save(runId: string, tool: string, content: string): { id: string }; list(runId: string): unknown[] };

beforeAll(async () => {
  const skillRegistry = new FilesystemSkillRegistry(process.env.SKILLS_DIR!);
  await skillRegistry.reloadAll();
  engine = new RunEngine({
    llm: { async chat() { return { content: 'x', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' }; }, async complete() { return { content: 'ok' }; }, isDemoMode: () => false } as any,
    skillRegistry, skillExecutor: new SkillExecutor(skillRegistry),
    runStore: new RunStore(), eventStore: new RunEventStore(), checkpointStore: new CheckpointStore(),
  });
});
afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

const idOf = (i: number) => `big-run-${String(i).padStart(4, '0')}`;

describe('REG-37 · 删除大会话：所有 run 的证据与检索文档都要清理', () => {
  it('205 个 run 的会话：删除后磁盘证据与全文索引不留幽灵', () => {
    const N = 205;
    for (let i = 0; i < N; i++) {
      engine.store.insert({ id: idOf(i), goal: '批量任务', mode: 'free', sessionId: 'sess_big' });
      evidence().save(idOf(i), 'fs_read', '{"payload":"证据内容"}');
      // 每个 run 一个独一无二的词 — 检索接口单次最多返回 20 条，按词逐个查才能查到边界两侧
      engine.searchStore.indexRun(idOf(i), '批量任务', `最终回答独有词QZ${i}`, []);
    }
    // 前提：边界两侧的 run 都能被检索到、都有证据
    for (const i of [0, 199, 200, N - 1]) {
      expect(engine.searchStore.search(`独有词QZ${i}`, 5).some(h => h.runId === idOf(i))).toBe(true);
      expect(evidence().list(idOf(i))).toHaveLength(1);
    }

    expect(engine.deleteSession('sess_big')).toBe(N);
    expect(engine.store.list({ sessionId: 'sess_big', limit: 200 }).total).toBe(0);

    const leftoverEvidence = Array.from({ length: N }, (_, i) => i).filter(i => evidence().list(idOf(i)).length > 0);
    expect(leftoverEvidence).toEqual([]); // 修复前：第 200～204 个 run 的证据目录残留
    const leftoverIndexed = Array.from({ length: N }, (_, i) => i).filter(i => engine.searchStore.search(`独有词QZ${i}`, 5).length > 0);
    expect(leftoverIndexed).toEqual([]); // 修复前：第 200～204 个 run 的检索文档残留（run 已删，却还能被搜到）
  });

  it('恰好 200 个 run 的会话（边界）：同样清理干净', () => {
    for (let i = 0; i < 200; i++) {
      engine.store.insert({ id: `edge-run-${i}`, goal: '边界', mode: 'free', sessionId: 'sess_edge' });
      evidence().save(`edge-run-${i}`, 'fs_read', '{}');
    }
    expect(engine.deleteSession('sess_edge')).toBe(200);
    expect(Array.from({ length: 200 }, (_, i) => i).filter(i => evidence().list(`edge-run-${i}`).length > 0)).toEqual([]);
  });
});
