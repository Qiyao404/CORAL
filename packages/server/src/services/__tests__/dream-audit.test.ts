import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryService } from '../memory-service.js';
import { EvolutionService } from '../evolution-service.js';
import { auditMemory, searchTerms } from '../dream.js';
import type { SearchStore } from '../../store/search-store.js';

/**
 * 离线对账（Dreaming，B5）：记忆库 ↔ 历史轨迹核对。
 * 纪律：只提议不落盘（人审闸门）；同文件最多一条未决；判定必须引用证据。
 */

let dir: string;
let memDir: string;
let svc: MemoryService;
let evolution: EvolutionService;

/** 桩检索库：预置片段，按关键词命中 */
function stubSearch(hits: Array<{ term: string; snippet: string }>): SearchStore {
  return {
    search(query: string, limit?: number) {
      return hits
        .filter(h => h.term === query)
        .map(h => ({ runId: 'run-proof0001', kind: 'answer', snippet: h.snippet }))
        .slice(0, limit ?? 6);
    },
  } as any;
}

function makeEvolution(llmReply: (prompt: string) => any, demo = false) {
  return new EvolutionService(
    {
      llm: { chat: async (req: any) => ({ content: JSON.stringify(llmReply(req.messages[0].content)) }), isDemoMode: () => demo },
      skillsDir: join(dir, 'skills'),
      registry: { listAll: () => [], reloadSkill: async () => {} } as any,
      memoryDir: memDir,
    },
    dir,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coral-dream-'));
  memDir = join(dir, 'memory');
  mkdirSync(memDir, { recursive: true });
  svc = new MemoryService(memDir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('auditMemory — 对账判定与提议', () => {
  it('矛盾 → 生成 memory_rewrite 提议（携带证据引用与改写稿）；文件未被改动（只提议不落盘）', async () => {
    svc.write('api-notes.md', '# API 笔记\n端口是 3000，去年已验证');
    evolution = makeEvolution(() => ({
      verdict: 'contradictory',
      contradictedClaim: '端口是 3000',
      evidenceQuote: '[run run-proof00 / answer] 迁移后服务端口改为 3001',
      correctedMarkdown: '# API 笔记\n\n## 服务端口\n迁移后服务端口为 3001（原 3000 已废弃，见历史轨迹核证）。',
    }));
    const r = await auditMemory({
      svc, evolution,
      llm: (evolution as any).deps.llm,
      search: stubSearch([{ term: 'api', snippet: '迁移后服务端口改为 3001' }]),
    });
    expect(r.audited).toBe(1);
    expect(r.contradictory).toBe(1);
    expect(r.proposals).toBe(1);
    // 纪律：只提议 — 原文件未被审计改动
    expect(svc.read('api-notes.md')!.content).toContain('3000');
    const pending = evolution.list('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe('memory_rewrite');
    expect(pending[0].skillName).toBe('api-notes.md');
    expect(pending[0].experience?.evidence).toContain('3001');
  });

  it('一致 → 不产生提议', async () => {
    svc.write('ok.md', '# 正常记忆\n内容无冲突');
    evolution = makeEvolution(() => ({ verdict: 'consistent' }));
    const r = await auditMemory({
      svc, evolution, llm: (evolution as any).deps.llm,
      search: stubSearch([{ term: '正常记忆', snippet: '与之一致的轨迹' }]),
    });
    expect(r.consistent).toBe(1);
    expect(r.proposals).toBe(0);
    expect(evolution.list('pending')).toHaveLength(0);
  });

  it('同文件已有未决提议 → 不重复入队（proposals 计 0）', async () => {
    svc.write('dup.md', '# 待审\n冲突内容');
    evolution = makeEvolution(() => ({
      verdict: 'contradictory', contradictedClaim: 'x', evidenceQuote: 'y',
      correctedMarkdown: '# 待审\n\n修正后的完整内容：这里是一段足够长的改写稿，超过三十字符的下限以证明它是完整文件而非片段。',
    }));
    const llm = (evolution as any).deps.llm;
    const search = stubSearch([{ term: '待审', snippet: '证据' }]);
    await auditMemory({ svc, evolution, llm, search });
    const r2 = await auditMemory({ svc, evolution, llm, search });
    expect(r2.contradictory).toBe(1);
    expect(r2.proposals).toBe(0); // 第二轮不重复
    expect(evolution.list('pending')).toHaveLength(1);
  });

  it('demo 模式 → 整轮跳过（skipped 返回）', async () => {
    svc.write('a.md', 'x');
    evolution = makeEvolution(() => ({}), true);
    const r = await auditMemory({ svc, evolution, llm: (evolution as any).deps.llm, search: stubSearch([]) });
    expect(r.audited).toBe(0);
    expect(r.skipped).toContain('演示模式');
  });
});

describe('memory_rewrite 落地（人审接受）', () => {
  it('接受 → 原文件备份 .history/ 后改写；拒绝 → 原样', async () => {
    svc.write('fix.md', '旧内容：端口 3000');
    evolution = makeEvolution(() => ({ verdict: 'skip' }));
    const p = evolution.proposeMemoryRewrite({
      file: 'fix.md', current: '旧内容：端口 3000',
      proposed: '新内容：端口 3001', evidence: '轨迹证明', rationale: '对账矛盾',
    });
    expect(p).toBeTruthy();
    const r = await evolution.decide(p!.id, true);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('改写');
    // 改写生效 + 备份存在
    expect(svc.read('fix.md')!.content).toContain('3001');
    const histDir = join(memDir, '.history');
    expect(existsSync(histDir)).toBe(true);
    // 拒绝路径
    const p2 = evolution.proposeMemoryRewrite({
      file: 'fix.md', current: 'x', proposed: '不会生效的内容', evidence: 'e', rationale: 'r',
    });
    await evolution.decide(p2!.id, false);
    expect(svc.read('fix.md')!.content).toContain('3001');
  });

  it('文件已不存在（被整理/删除）→ 提议作废不落盘', async () => {
    svc.write('gone.md', '内容');
    evolution = makeEvolution(() => ({ verdict: 'skip' }));
    const p = evolution.proposeMemoryRewrite({
      file: 'gone.md', current: '内容', proposed: '改写', evidence: 'e', rationale: 'r',
    });
    rmSync(join(memDir, 'gone.md'));
    const r = await evolution.decide(p!.id, true);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('不存在');
  });
});

describe('searchTerms — 检索词提取', () => {
  it('从标题与高频实词提取，去停用词', () => {
    const terms = searchTerms('# Docker 修复笔记\ndocker 端口冲突用 docker-compose 修复\nthe and for');
    expect(terms[0]).toBe('docker 修复笔记');
    expect(terms.some(t => t === 'docker')).toBe(true);
    expect(terms.some(t => t === 'the')).toBe(false);
  });
});
