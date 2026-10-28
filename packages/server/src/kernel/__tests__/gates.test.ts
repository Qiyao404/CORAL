import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectRationalization, shouldGate, gatePushback } from '../quality-gate.js';
import { FactGate, factsRequiredError } from '../fact-gate.js';
import { usageLevel, shelveOldToolResults } from '../context-window.js';
import { EvidenceStore, summarizeForEvidence, DEFAULT_EVIDENCE_THRESHOLD } from '../evidence.js';
import { evaluateDeterministic } from '../self-eval.js';
import type { ChatMessage } from '../../providers/types.js';
import type { Tool } from '../../tools/types.js';

// ─── 收工门：合理化话术检测 ───────────────────────────────────────────────

describe('quality-gate — 合理化话术检测', () => {
  it('命中英文话术：pre-existing / skip tests / fix later', () => {
    const hits = detectRationalization(
      'Done. Note: this is a pre-existing issue and the tests are failing but we will fix it later.'
    );
    const ids = hits.map(h => h.id);
    expect(ids).toContain('pre-existing');
    expect(ids).toContain('tests-failing-later');
    expect(ids).toContain('fix-later');
    expect(hits.every(h => h.quote.length > 0)).toBe(true);
  });

  it('命中中文话术：历史遗留 / 跳过测试 / 后续再修 / 不在本次范围', () => {
    const hits = detectRationalization('交付完成。这是历史遗留问题，测试暂时跳过，后续再修复，深度重构不在本次范围内。');
    const ids = hits.map(h => h.id);
    expect(ids).toContain('pre-existing-zh');
    expect(ids).toContain('skip-tests-zh');
    expect(ids).toContain('fix-later-zh');
    expect(ids).toContain('out-of-scope-zh');
  });

  it('诚实声明的未完成事项不算话术（"未完成事项"章节是鼓励的诚实行为）', () => {
    const hits = detectRationalization('任务完成主体。## 未完成事项\n- 测试未覆盖边界 X，建议下轮补充。');
    expect(hits).toHaveLength(0);
  });

  it('正常回答零命中', () => {
    expect(detectRationalization('已生成对比表格并保存为 report.docx，共 3 列 12 行。')).toHaveLength(0);
  });

  it('shouldGate：≥3 写操作或 ≥5 工具调用才设门（轻任务零打扰）', () => {
    expect(shouldGate({ writeOps: 0, toolCalls: 4 })).toBe(false);
    expect(shouldGate({ writeOps: 2, toolCalls: 4 })).toBe(false);
    expect(shouldGate({ writeOps: 3, toolCalls: 0 })).toBe(true);
    expect(shouldGate({ writeOps: 0, toolCalls: 5 })).toBe(true);
  });

  it('gatePushback 包含命中原文与两个出口（做完 or 如实列出）', () => {
    const hits = detectRationalization('we will fix it later');
    const msg = gatePushback(hits, 1);
    expect(msg).toContain('FIX IT LATER'.length > 0 ? 'fix' : '');
    expect(msg).toContain('未完成事项');
    expect(msg).toContain('1 chance');
  });
});

// ─── 事实门：写前必读 ─────────────────────────────────────────────────────

describe('fact-gate — 写类工具的盲改拦截', () => {
  const writeTool = (name: string): Tool => ({
    name,
    description: '',
    inputSchema: { type: 'object' },
    source: 'builtin',
    permission: 'auto',
    effects: { writesFilesystem: true },
    invoke: async () => ({ ok: true, data: {} }),
  });

  const toolMsg = (toolName: string, content: string, callId = 'c'): ChatMessage =>
    ({ role: 'tool', toolCallId: callId, toolName, content });

  it('fs_edit 未先读 → 拒绝并给出调查指令；读过同路径后放行', () => {
    const gate = new FactGate();
    const edit = writeTool('fs_edit');
    const d1 = gate.check(edit, { path: 'a.md', old_text: 'x', new_text: 'y' }, []);
    expect(d1.pass).toBe(false);
    expect(d1.instruction).toContain('fs_read');
    expect(d1.instruction).toContain('a.md');

    // 读过（消息历史里有成功的 fs_read 且内容包含该路径）
    const history: ChatMessage[] = [toolMsg('fs_read', JSON.stringify({ path: 'a.md', content: 'hello' }), 'c0')];
    const d2 = gate.check(edit, { path: 'a.md' }, history);
    expect(d2.pass).toBe(true);
  });

  it('新建文件直接放行（权限档把关，事实门只管"改已有的东西"）', () => {
    const gate = new FactGate();
    const write = writeTool('fs_write');
    const d = gate.check(write, { path: 'brand-new.md', content: 'x' }, [], undefined);
    expect(d.pass).toBe(true);
  });

  it('覆盖已存在文件（workspaceDir 指向真实目录）→ 未读先拒，读过放行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-'));
    try {
      writeFileSync(join(dir, 'old.md'), 'x', 'utf-8');
      const gate = new FactGate();
      const write = writeTool('fs_write');
      const d1 = gate.check(write, { path: 'old.md', content: 'y' }, [], dir);
      expect(d1.pass).toBe(false);
      expect(d1.instruction).toContain('old.md');

      const history: ChatMessage[] = [toolMsg('fs_read', JSON.stringify({ path: 'old.md', content: 'x' }), 'c0')];
      const d2 = gate.check(write, { path: 'old.md' }, history, dir);
      expect(d2.pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('防死锁：同一工具+路径第 3 次拦截时放行（bypass）', () => {
    const gate = new FactGate();
    const edit = writeTool('fs_edit');
    const d1 = gate.check(edit, { path: 'x.md' }, []);
    const d2 = gate.check(edit, { path: 'x.md' }, []);
    const d3 = gate.check(edit, { path: 'x.md' }, []);
    expect(d1.pass).toBe(false);
    expect(d2.pass).toBe(false);
    expect(d3.pass).toBe(true);
    expect(d3.reason).toContain('bypassed');
  });

  it('无写效果的工具直接放行（只读工具不设门）', () => {
    const gate = new FactGate();
    const read: Tool = { ...writeTool('fs_read'), effects: undefined };
    expect(gate.check(read, { path: 'a' }, []).pass).toBe(true);
  });

  it('factsRequiredError 是 retryable（补调查后重试是预期路径）', () => {
    const e = factsRequiredError('[runtime fact-gate] 先读后写');
    expect(e.code).toBe('FACTS_REQUIRED');
    expect(e.retryable).toBe(true);
  });
});

// ─── 上下文档位与收纳 ─────────────────────────────────────────────────────

describe('context-window — 4 档用量与旧结果收纳', () => {
  it('usageLevel 档位边界：60% / 85% / 100%', () => {
    expect(usageLevel(50, 100)).toBe('ok');
    expect(usageLevel(59.9, 100)).toBe('ok');
    expect(usageLevel(60, 100)).toBe('warning');
    expect(usageLevel(84.9, 100)).toBe('warning');
    expect(usageLevel(85, 100)).toBe('critical');
    expect(usageLevel(99.9, 100)).toBe('critical');
    expect(usageLevel(100, 100)).toBe('blocked');
  });

  const mk = (n: number): ChatMessage[] => {
    const out: ChatMessage[] = [{ role: 'user', content: 'goal' }];
    for (let i = 0; i < n; i++) {
      out.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'big', input: {} }] });
      out.push({ role: 'tool', toolCallId: `c${i}`, toolName: 'big', content: 'X'.repeat(5000) });
    }
    return out;
  };

  it('软水位以下不收纳；超过后只动较早结果、保留最近 4 条原样', () => {
    const under = shelveOldToolResults(mk(4), 100_000);
    expect(under.shelved).toBe(0);

    const msgs = mk(7); // 7 条 5k 的工具结果，总量 ~35k
    const over = shelveOldToolResults(msgs, 10_000); // 触发水位 6k
    expect(over.shelved).toBe(3); // 前 3 条被收纳，最近 4 条原样
    expect(over.reclaimedChars).toBeGreaterThan(10_000);
    // 消息结构合法：toolCallId 保留
    const toolMsgs = over.messages.filter(m => m.role === 'tool');
    expect(toolMsgs).toHaveLength(7);
    expect(toolMsgs[0].toolCallId).toBe('c0');
    expect(toolMsgs[6].content).toBe('X'.repeat(5000)); // 最近一条原封不动
  });

  it('收纳前经 archive 回调归档，占位符携带归档 ID', () => {
    const msgs = mk(6);
    const archived: string[] = [];
    const r = shelveOldToolResults(msgs, 10_000, {
      archive: (_tool, content) => {
        const id = `ev-${archived.length}`;
        archived.push(content.slice(0, 10));
        return id;
      },
    });
    expect(r.shelved).toBe(2);
    expect(archived.length).toBe(2);
    const stubbed = r.messages.filter(m => m.role === 'tool' && m.content.includes('旧工具结果已收纳'));
    expect(stubbed).toHaveLength(2);
    expect(stubbed.some(m => m.content.includes('ev-0'))).toBe(true);
    expect(stubbed.some(m => m.content.includes('ev-1'))).toBe(true);
  });

  it('已是证据摘要的结果不重复收纳', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'goal' },
      ...Array.from({ length: 6 }, (_, i) => ({
        role: 'tool' as const,
        toolCallId: `c${i}`,
        toolName: 'big',
        content: i < 2 ? JSON.stringify({ note: '已归档', evidenceId: 'ev-1', preview: 'X'.repeat(4000) }) : 'Y'.repeat(5000),
      })),
    ];
    const r = shelveOldToolResults(msgs, 10_000);
    expect(r.shelved).toBe(0); // 前两条是摘要态 → 无可收纳目标（后四条是最近 4 条）
  });
});

// ─── 证据记录层 ───────────────────────────────────────────────────────────

describe('evidence — 大结果不可变存档', () => {
  it('save/read/list：分页读取与 hasMore；不可变（同 ID 不覆盖）', () => {
    const store = new EvidenceStore('./.tmp-evidence-test');
    const big = 'A'.repeat(20_000);
    const rec = store.save('run-1', 'http_fetch', big);
    expect(rec.chars).toBe(20_000);

    const page1 = store.read('run-1', rec.id, 0, 8000)!;
    expect(page1.page.length).toBe(8000);
    expect(page1.hasMore).toBe(true);
    const page3 = store.read('run-1', rec.id, 16_000, 8000)!;
    expect(page3.page.length).toBe(4000);
    expect(page3.hasMore).toBe(false);

    const list = store.list('run-1');
    expect(list).toHaveLength(1);
    expect(list[0].tool).toBe('http_fetch');

    // runId 消毒：路径注入尝试被清成安全字符
    expect(store.list('../evil')).toHaveLength(0);
    store.deleteRun('run-1');
    expect(store.list('run-1')).toHaveLength(0);
  });

  it('summarizeForEvidence：摘要携带 ID/总量/头尾预览', () => {
    const rec = { id: 'ev-x', runId: 'r', tool: 't', content: 'B'.repeat(50_000), chars: 50_000, createdAt: '' };
    const s = summarizeForEvidence(rec);
    const parsed = JSON.parse(s);
    expect(parsed.evidenceId).toBe('ev-x');
    expect(parsed.totalChars).toBe(50_000);
    expect(parsed.preview.length).toBeLessThan(2000);
    expect(parsed.note).toContain('evidence_read');
  });

  it('默认阈值常量存在（工具级预算的回退值）', () => {
    expect(DEFAULT_EVIDENCE_THRESHOLD).toBeGreaterThan(4000);
  });
});

// ─── 五轴自评（确定性启发式层）────────────────────────────────────────────

describe('self-eval — 确定性启发式评分', () => {
  it('含话术的回答 accuracy 扣分并引用证据', () => {
    const r = evaluateDeterministic('修好登录页并跑通测试', '修好了。这是 pre-existing issue，测试 skip，will fix it later。');
    const acc = r.axes.find(a => a.axis === 'accuracy')!;
    expect(acc.score).toBeLessThanOrEqual(1);
    expect(acc.evidence).toBeTruthy();
  });

  it('过短回答 completeness 低分', () => {
    const r = evaluateDeterministic('请分析这份 3000 字的文档并给出改进建议、风险清单、时间表和负责人分配', '好的。');
    const comp = r.axes.find(a => a.axis === 'completeness')!;
    expect(comp.score).toBeLessThanOrEqual(3);
  });

  it('墙式文本 clarity 扣分；结构化回答满分', () => {
    const wall = '字'.repeat(1500);
    const r1 = evaluateDeterministic('总结', wall);
    expect(r1.axes.find(a => a.axis === 'clarity')!.score).toBe(3);

    const structured = `## 结论\n完成。\n\n- 要点一\n- 要点二\n\n| A | B |\n|---|---|\n| 1 | 2 |`;
    const r2 = evaluateDeterministic('总结', structured);
    expect(r2.axes.find(a => a.axis === 'clarity')!.score).toBe(5);
  });

  it('高对冲密度 actionability 扣分', () => {
    const hedgy = Array.from({ length: 30 }, () => 'maybe this works').join('. ') + '.';
    const r = evaluateDeterministic('给出明确结论', hedgy);
    expect(r.axes.find(a => a.axis === 'actionability')!.score).toBeLessThan(5);
  });

  it('干净回答五轴全 5 分', () => {
    const clean = [
      '## 结果',
      '- 已完成事项 A 的整理与归档，文件保存在 workspace/output-a.md',
      '- 已完成事项 B 的核对，确认与需求文档逐条对应无遗漏',
      '',
      '全部验证通过，两处产出均可直接使用。',
      '',
      '| 事项 | 状态 | 产出 |',
      '|---|---|---|',
      '| A | 完成 | output-a.md |',
      '| B | 完成 | 核对清单 |',
    ].join('\n');
    const r = evaluateDeterministic('列出到手事项并给出状态与产出', clean);
    expect(r.axes.every(a => a.score === 5)).toBe(true);
    expect(r.overall).toBe(5);
  });
});
