import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryService } from '../memory-service.js';
import { EvolutionService } from '../evolution-service.js';
import { auditMemory } from '../dream.js';
import type { SearchStore } from '../../store/search-store.js';

/**
 * REG-35：离线对账每次只核对"最新的 8 个文件"。
 *
 * 文件列表按修改时间倒序，直接 slice(0, 8) → 永远是同一批；库里超过 8 个文件时，
 * 其余文件无论点多少次"离线对账"都不会被检查（实测 16 个文件时 8 个从未被核对）。
 * 修法：记住每个文件上次被核对的时间，每次取"最久没核对"的 8 个 → 多点几次就轮完全库。
 */

let dir: string;
let memDir: string;
let svc: MemoryService;

const noHits: SearchStore = { search: () => [] } as any;

function makeEvolution(reply: (prompt: string) => any) {
  return new EvolutionService(
    {
      llm: {
        chat: async (req: any) => ({ content: JSON.stringify(reply(req.messages[0].content)) }),
        isDemoMode: () => false,
      },
      skillsDir: join(dir, 'skills'),
      registry: { listAll: () => [], reloadSkill: async () => {} } as any,
      memoryDir: memDir,
    },
    dir,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coral-dream-rot-'));
  memDir = join(dir, 'memory');
  mkdirSync(memDir, { recursive: true });
  svc = new MemoryService(memDir);
  // 16 个文件：note-01 最早、note-16 最新。修改时间显式设置成递增的固定值 —
  //（同一毫秒内连续写入时修改时间相同，"最新在前"的顺序不确定，断言就没法写死）
  for (let i = 1; i <= 16; i++) {
    const name = `note-${String(i).padStart(2, '0')}.md`;
    svc.write(name, `# 笔记 ${i}\n- 第 ${i} 条记录`);
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
    utimesSync(join(memDir, name), at, at);
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('auditMemory · 轮转覆盖全部文件', () => {
  it('连点三次：第一次核最新的 8 个，第二次核剩下的 8 个，第三次回到开头', async () => {
    const evolution = makeEvolution(() => ({ verdict: 'consistent' }));
    const deps = { svc, evolution, llm: (evolution as any).deps.llm, search: noHits };
    const seen: string[][] = [];
    for (let round = 0; round < 3; round++) {
      const r = await auditMemory(deps);
      expect(r.audited).toBe(8);
      seen.push(r.auditedFiles ?? []);
    }
    const newestEight = Array.from({ length: 8 }, (_, i) => `note-${String(16 - i).padStart(2, '0')}.md`);
    const oldestEight = Array.from({ length: 8 }, (_, i) => `note-${String(8 - i).padStart(2, '0')}.md`);
    expect(seen[0]).toEqual(newestEight); // 从没核对过的优先；同为零时保持列表顺序（最新在前）
    expect(seen[1]).toEqual(oldestEight); // 修复前：仍然是最新 8 个
    expect(seen[2]).toEqual(newestEight); // 全库轮完一遍后回到最久没核的那批
  });

  it('新写入的文件下一轮优先被核对；已删除的文件不再占轮转名额', async () => {
    const evolution = makeEvolution(() => ({ verdict: 'consistent' }));
    const deps = { svc, evolution, llm: (evolution as any).deps.llm, search: noHits };
    await auditMemory(deps); // 核了 16..09
    svc.write('note-17.md', '# 新笔记\n- 刚写入'); // 新文件：从未核对 → 下一轮最优先
    const r = await auditMemory(deps);
    expect(r.auditedFiles?.[0]).toBe('note-17.md');
    expect(r.auditedFiles).toContain('note-08.md'); // 其余仍是"最久没核"的那批
    expect(r.auditedFiles).toHaveLength(8);
  });

  it('某个文件核对时出错，不会卡住轮转（下一轮换下一批）', async () => {
    const evolution = makeEvolution((prompt: string) => {
      if (prompt.includes('note-16.md')) throw new Error('模型超时');
      return { verdict: 'consistent' };
    });
    const llm = { ...((evolution as any).deps.llm as any), isDemoMode: () => false };
    const deps = { svc, evolution, llm, search: noHits };
    const first = await auditMemory(deps);
    expect(first.audited).toBe(8);
    const second = await auditMemory(deps);
    expect(second.auditedFiles?.slice(0, 8)).not.toContain('note-16.md'); // 出错的那个不会一直占着首位
    expect(second.auditedFiles?.[0]).toBe('note-08.md');
  });

  it('轮转状态存在记忆目录的隐藏文件里，不混入记忆文件列表', async () => {
    const evolution = makeEvolution(() => ({ verdict: 'consistent' }));
    await auditMemory({ svc, evolution, llm: (evolution as any).deps.llm, search: noHits });
    expect(existsSync(join(memDir, '.audit-state.json'))).toBe(true);
    expect(svc.list().map(f => f.name).filter(n => !n.endsWith('.md'))).toEqual([]);
    expect(svc.list()).toHaveLength(16);
  });
});
