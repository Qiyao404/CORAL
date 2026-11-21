import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentLoop, type LoopEvent } from '../agent-loop.js';
import { generateCriteria, verifyDeliverable, appendCheck, readAccumulatedChecks, type LlmChat } from '../../services/verification-service.js';
import type { ChatResponse } from '../../providers/types.js';

/**
 * 验证工程（A1/B4/A2）：
 *  · 清单生成：累积 CHECKS.md 必须原样并入；歧义返回而不是猜
 *  · 判定：默认否（缺结果按 FAIL）、失败带证据、级别映射（4/3/2）
 *  · 循环验证门：失败打回重做（带失败行）→ 修正通过；2 次打回后强制放行+告警
 *  · 一错一规：appendCheck 持久化
 */

let dir: string;

function stubLlm(reply: () => any): LlmChat & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async chat(req) {
      calls.push(req.messages[0].content);
      const r = reply();
      return { content: typeof r === 'string' ? r : JSON.stringify(r) };
    },
  };
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'coral-verify-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('清单生成（B4 标准前置）', () => {
  it('累积 CHECKS.md 的行必须原样并入（用户历史标准优先）', async () => {
    appendCheck(dir, '所有数字必须与来源一致');
    appendCheck(dir, '交付物放在工作区根目录');
    const llm = stubLlm(() => ({ lines: ['榜单为 3 行'], ambiguities: [] }));
    const r = await generateCriteria({ llm, goal: '做榜单', workspaceDir: dir });
    const lines = r.lines.map(l => l.line);
    expect(lines).toContain('所有数字必须与来源一致');
    expect(lines).toContain('交付物放在工作区根目录');
    expect(lines).toContain('榜单为 3 行');
    expect(r.lines.find(l => l.line === '所有数字必须与来源一致')?.source).toBe('accumulated');
    expect(r.lines.find(l => l.line === '榜单为 3 行')?.source).toBe('generated');
  });

  it('歧义返回 ambiguities（而不是猜成清单行）', async () => {
    const llm = stubLlm(() => ({ lines: ['文件存在'], ambiguities: ['"一页"未定义是 A4 还是长页'] }));
    const r = await generateCriteria({ llm, goal: '一页文档', workspaceDir: dir });
    expect(r.ambiguities).toHaveLength(1);
    expect(r.ambiguities[0]).toContain('一页');
  });
});

describe('判定（A1 默认否）', () => {
  it('全过带证据 → level 4；有不可验 → 3；有失败 → 2；缺判定的行按 FAIL 补齐', async () => {
    const criteria = [
      { line: 'A', source: 'generated' as const },
      { line: 'B', source: 'generated' as const },
      { line: 'C', source: 'generated' as const },
    ];
    // 全过
    let llm = stubLlm(() => ({ results: [
      { line: 'A', pass: true, evidence: 'x' }, { line: 'B', pass: true, evidence: 'y' }, { line: 'C', pass: true, evidence: 'z' },
    ] }));
    let v = await verifyDeliverable({ llm, goal: 'g', criteria, finalContent: 'f', artifacts: [] });
    expect(v.level).toBe(4); expect(v.passed).toBe(true);
    // 一条不可验
    llm = stubLlm(() => ({ results: [
      { line: 'A', pass: true }, { line: 'B', pass: false, unverifiable: true, evidence: '需要开链接' }, { line: 'C', pass: true },
    ] }));
    v = await verifyDeliverable({ llm, goal: 'g', criteria, finalContent: 'f', artifacts: [] });
    expect(v.level).toBe(3); expect(v.passed).toBe(true); // 不可验不算失败（诚实而非猜 PASS）
    // 一条失败 + 一条缺判定（默认否补 FAIL）
    llm = stubLlm(() => ({ results: [ { line: 'A', pass: true }, { line: 'B', pass: false, evidence: '产物中没有 X' } ] }));
    v = await verifyDeliverable({ llm, goal: 'g', criteria, finalContent: 'f', artifacts: [] });
    expect(v.level).toBe(2); expect(v.passed).toBe(false);
    expect(v.results.find(r => r.line === 'C')?.pass).toBe(false); // 缺判定 → FAIL
    expect(v.results.find(r => r.line === 'B')?.evidence).toContain('产物中');
  });
});

describe('一错一规（CHECKS.md 累积）', () => {
  it('appendCheck 创建带表头文件并追加；readAccumulated 读回', () => {
    expect(readAccumulatedChecks(dir)).toBe('');
    const r1 = appendCheck(dir, '第一条检查');
    expect(r1.ok).toBe(true);
    const r2 = appendCheck(dir, '');
    expect(r2.ok).toBe(false); // 空行拒绝
    const text = readFileSync(join(dir, 'CHECKS.md'), 'utf-8');
    expect(text).toContain('CHECKS');
    expect(text).toContain('- 第一条检查');
    expect(readAccumulatedChecks(dir)).toContain('第一条检查');
  });
});

// ─── 循环验证门（agent-loop 集成）───────────────────────────────────────

class ScriptedLLM {
  calls = 0;
  constructor(private script: Array<(n: number) => Partial<ChatResponse> | null>) {}
  async chat(): Promise<ChatResponse> {
    const item = this.script[Math.min(this.calls, this.script.length - 1)](this.calls);
    this.calls++;
    const r = item ?? { content: '默认', stopReason: 'end' as const };
    return { content: r.content ?? '', toolCalls: (r as any).toolCalls ?? [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: r.stopReason ?? 'end' };
  }
  async complete(): Promise<{ content: string }> { return { content: 's' }; }
}

function loopOpts(over: any) {
  return {
    runId: 'r-v', agentId: 'main', goal: '任务',
    tools: [], budget: { maxSteps: 20, maxTokens: 1_000_000 },
    signal: new AbortController().signal,
    onEvent: () => {},
    ...over,
  };
}

describe('AgentLoop — 验证门', () => {
  it('首次失败 → 打回（事件+失败行入消息）→ 修正后通过 → 终答交付', async () => {
    const verdicts = [
      { passed: false, failedLines: [{ line: '榜单必须 3 行', evidence: '只有 2 行' }], passedCount: 2, totalCount: 3 },
      { passed: true, failedLines: [], passedCount: 3, totalCount: 3 },
    ];
    let vi = 0;
    const llm = new ScriptedLLM([
      () => ({ content: '第一次交付的榜单文档，当前只列出了两行内容，等待验证反馈。' }),
      () => ({ content: '修正后的榜单文档已经补齐第三行，现在完整包含三行内容与来源。' }),
    ]);
    const events: LoopEvent[] = [];
    const loop = new AgentLoop(llm as any, loopOpts({
      onEvent: e => events.push(e),
      verifyGate: async () => verdicts[Math.min(vi++, verdicts.length - 1)],
    }));
    const r = await loop.run();
    expect(r.status).toBe('completed');
    expect(r.finalContent).toContain('修正后');
    expect(events.some(e => e.type === 'loop.verification_rejected')).toBe(true);
    // 打回消息带失败行与证据
    const msgs = JSON.stringify(r.messages);
    expect(msgs).toContain('榜单必须 3 行');
    expect(msgs).toContain('只有 2 行');
  });

  it('连续失败 2 次打回后 → 第 3 次强制放行 + 告警事件（门防漏放不防交付）', async () => {
    const fail = { passed: false, failedLines: [{ line: 'X', evidence: 'e' }], passedCount: 0, totalCount: 1 };
    const llm = new ScriptedLLM([
      () => ({ content: '第一次尝试交付的内容版本一，长度足够触发验证门。' }), () => ({ content: '第二次尝试交付的内容版本二，仍然不满足检查要求。' }), () => ({ content: '第三次尝试交付的内容版本三，将被强制放行。' }),
    ]);
    const events: LoopEvent[] = [];
    const loop = new AgentLoop(llm as any, loopOpts({
      onEvent: e => events.push(e),
      verifyGate: async () => fail,
    }));
    const r = await loop.run();
    expect(r.status).toBe('completed');
    expect(r.finalContent).toContain('版本三');
    expect(events.filter(e => e.type === 'loop.verification_rejected')).toHaveLength(2);
    expect(events.some(e => e.type === 'loop.verification_forced_pass')).toBe(true);
  });

  it('验证器自身故障不拦交付（fail-open — 验证是增强不是依赖）', async () => {
    const llm = new ScriptedLLM([() => ({ content: '一次正常的交付内容，长度超过二十个字符以触发验证门。' })]);
    const loop = new AgentLoop(llm as any, loopOpts({
      verifyGate: async () => { throw new Error('verifier down'); },
    }));
    const r = await loop.run();
    expect(r.status).toBe('completed');
    expect(r.finalContent).toContain('正常的交付');
  });

  it('gate 返回 null（无清单）→ 零打扰', async () => {
    const llm = new ScriptedLLM([() => ({ content: '没有验收清单时的一次性直接交付内容，无需验证。' })]);
    const events: LoopEvent[] = [];
    const loop = new AgentLoop(llm as any, loopOpts({
      onEvent: e => events.push(e),
      verifyGate: async () => null,
    }));
    const r = await loop.run();
    expect(r.finalContent).toContain('直接交付');
    expect(events.some(e => e.type === 'loop.verification_rejected')).toBe(false);
  });
});
