import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryService } from '../../services/memory-service.js';
import { routeNewMemory, appendToMemory, autoConsolidate, type LlmChat } from '../../services/memory-router.js';

/** 记忆自动归档：写入路由（并入/新建/兜底）、追加保留原文、超量全保留整理 */

let dir: string;
let svc: MemoryService;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coral-memroute-'));
  svc = new MemoryService(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stubLlm(reply: () => string, demo = false): LlmChat & { calls: number } {
  const obj: any = {
    calls: 0,
    isDemoMode: () => demo,
    async chat(req: any) {
      obj.calls++;
      return { content: reply() };
    },
  };
  return obj;
}

describe('routeNewMemory — 写入路由', () => {
  it('主题匹配 → 并入既有文件；追加保留原文', async () => {
    svc.write('user-preferences.md', '# 用户偏好\n- 报告一律 Markdown');
    const llm = stubLlm(() => JSON.stringify({ action: 'append', target: 'user-preferences.md', reason: '同类偏好' }));
    const d = await routeNewMemory(svc, llm, 'report-format.md', '用户不要 Word 输出');
    expect(d.action).toBe('append');
    expect(d.target).toBe('user-preferences.md');

    appendToMemory(svc, d.target, '用户不要 Word 输出', 'report-format.md');
    const merged = svc.read('user-preferences.md')!.content;
    expect(merged).toContain('报告一律 Markdown');       // 原文保留
    expect(merged).toContain('用户不要 Word 输出');        // 新内容进来了
    expect(merged).toContain('归档自 report-format.md');   // 来源可溯
    expect(existsSync(join(dir, 'report-format.md'))).toBe(false); // 不产生碎片文件
  });

  it('LLM 判定新主题 → 用路由给出的新名创建', async () => {
    svc.write('user-preferences.md', 'x');
    const llm = stubLlm(() => JSON.stringify({ action: 'create', target: 'travel-plans.md', reason: '全新主题' }));
    const d = await routeNewMemory(svc, llm, 'tmp-name.md', '想去冰岛看极光');
    expect(d.action).toBe('create');
    expect(d.target).toBe('travel-plans.md');
  });

  it('兜底三连：LLM 失败 / 演示模式 / 空库 → 按原名新建', async () => {
    const bad = stubLlm(() => { throw new Error('boom'); });
    expect((await routeNewMemory(svc, bad, 'a.md', 'c')).target).toBe('a.md');
    const demo = stubLlm(() => '{}', true);
    expect((await routeNewMemory(svc, demo, 'b.md', 'c')).action).toBe('create');
    const empty = stubLlm(() => '{}');
    svc.write('only.md', '1'); // 非空库走 LLM；先清空场景单独验证：直接空库
    const svc2 = new MemoryService(mkdtempSync(join(tmpdir(), 'coral-memroute2-')));
    expect((await routeNewMemory(svc2, empty, 'first.md', 'c')).target).toBe('first.md');
    rmSync(svc2['dirPath' as keyof typeof svc2] as unknown as string, { recursive: true, force: true });
  });
});

describe('autoConsolidate — 超量全保留整理', () => {
  it('文件数超限 → 分组决策 + 组内全保留合并 + 原文件备份移除', async () => {
    svc.write('prefs-a.md', '偏好A1：表格化');
    svc.write('prefs-b.md', '偏好B1：中文回复');
    svc.write('travel.md', '想去冰岛');
    // 12 个文件（> 10 触发）
    for (let i = 1; i <= 9; i++) svc.write(`misc-${i}.md`, `杂项${i}：事实${i}`);

    // 桩按调用次序应答：第 1 次=分组决策，其后=各组的全保留合并结果
    let call = 0;
    const llm = stubLlm(() => {
      call++;
      if (call === 1) return JSON.stringify({
        groups: [
          { target: 'prefs-a.md', sources: ['prefs-a.md', 'prefs-b.md'] },
          { target: 'travel.md', sources: ['travel.md'] },
        ],
      });
      return '# 合并后的偏好\n- 偏好A1：表格化\n- 偏好B1：中文回复';
    });
    const r = await autoConsolidate(svc, llm, 10);
    expect(r.ran).toBe(true);
    expect(svc.exists('prefs-b.md')).toBe(false);                    // 被并入
    const merged = svc.read('prefs-a.md')!.content;
    expect(merged).toContain('表格化');
    expect(merged).toContain('中文回复');                             // 一条不丢
    expect(svc.exists('travel.md')).toBe(true);                       // 单文件组不动
    // 备份存在
    const hist = join(dir, '.history');
    expect(existsSync(hist)).toBe(true);
  });

  it('未超限 / 节流中 → 不跑', async () => {
    svc.write('one.md', '1');
    const llm = stubLlm(() => '{}');
    expect((await autoConsolidate(svc, llm, 10)).ran).toBe(false);
  });
});
