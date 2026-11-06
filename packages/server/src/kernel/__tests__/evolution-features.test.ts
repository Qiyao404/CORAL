import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

import { AgentLoop, type AgentLoopOptions } from '../agent-loop.js';
import { TeamService } from '../team-service.js';
import { SearchStore } from '../../store/search-store.js';
import { migrate } from '../../store/migrate.js';
import { buildTrajectoryLines } from '../trajectory.js';
import { EvolutionService } from '../../services/evolution-service.js';
import type { ChatRequest, ChatResponse } from '../../providers/types.js';
import type { Tool } from '../../tools/types.js';
import { toolOk, makeToolContext } from '../../tools/types.js';

/** 记忆 nudge / 会话检索 / 团队 Watchdog / 轨迹导出 / 演化管线 五件套 */

// ─── 测试基件 ───────────────────────────────────────────────

class ScriptedLLM {
  calls: ChatRequest[] = [];
  constructor(private script: Array<Partial<ChatResponse>>) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    const item = this.script[Math.min(this.calls.length - 1, this.script.length - 1)];
    return {
      content: item?.content ?? '',
      toolCalls: item?.toolCalls ?? [],
      usage: item?.usage ?? { inputTokens: 10, outputTokens: 5 },
      stopReason: item?.stopReason ?? 'end',
    };
  }
}

const call = (id: string, name: string, input: any) => ({ id, name, input });

function loopOptions(over: Partial<AgentLoopOptions>): AgentLoopOptions {
  return {
    runId: 'run-evo',
    agentId: 'main',
    goal: 'goal',
    tools: [],
    budget: { maxSteps: 10, maxTokens: 1_000_000 },
    signal: new AbortController().signal,
    onEvent: () => {},
    ...over,
  } as AgentLoopOptions;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coral-evo-'));
});
// afterEach 由各 describe 自理（evolution 服务的文件落在 dir 内）

// ─── ① 记忆 nudge ──────────────────────────────────────────

describe('记忆 nudge（事中持久化提醒）', () => {
  it('未写记忆时周期注入提醒（硬上限 2 次）', async () => {
    const echo: Tool = {
      name: 'echo', description: 'echo', inputSchema: { type: 'object' },
      source: 'builtin', permission: 'auto',
      invoke: async () => toolOk({ ok: true }),
    };
    const memWrite: Tool = {
      name: 'memory_write', description: 'write memory', inputSchema: { type: 'object' },
      source: 'builtin', permission: 'auto',
      invoke: async () => toolOk({ saved: true }),
    };
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [call('c1', 'echo', {})], content: '' },
      { stopReason: 'tool_use', toolCalls: [call('c2', 'echo', {})], content: '' },
      { stopReason: 'tool_use', toolCalls: [call('c3', 'echo', {})], content: '' },
      { content: 'done', stopReason: 'end' },
    ]);
    await new AgentLoop(llm, loopOptions({
      tools: [echo, memWrite],
      memoryNudgeEvery: 1,
    })).run();

    // 第 2 轮请求（第 1 步后）注入第一条；全程（含历史）不超过 2 条
    expect(llm.calls[1].messages.some(m => String(m.content).includes('Checkpoint reminder'))).toBe(true);
    const totalNudges = llm.calls[3].messages.filter(m => String(m.content).includes('Checkpoint reminder')).length;
    expect(totalNudges).toBe(2);
  });

  it('第一步就写了记忆 → 全程不提醒（写入门控）', async () => {
    const echo: Tool = {
      name: 'echo', description: 'echo', inputSchema: { type: 'object' },
      source: 'builtin', permission: 'auto',
      invoke: async () => toolOk({ ok: true }),
    };
    const memWrite: Tool = {
      name: 'memory_write', description: 'write memory', inputSchema: { type: 'object' },
      source: 'builtin', permission: 'auto',
      invoke: async () => toolOk({ saved: true }),
    };
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [call('c1', 'memory_write', { name: 'a.md', content: 'x' })], content: '' },
      { stopReason: 'tool_use', toolCalls: [call('c2', 'echo', {})], content: '' },
      { content: 'done', stopReason: 'end' },
    ]);
    await new AgentLoop(llm, loopOptions({ tools: [echo, memWrite], memoryNudgeEvery: 1 })).run();
    for (const req of llm.calls) {
      expect(req.messages.some(m => String(m.content).includes('Checkpoint reminder'))).toBe(false);
    }
  });

  it('工具集中没有 memory_write 时不提醒', async () => {
    const echo: Tool = {
      name: 'echo', description: 'echo', inputSchema: { type: 'object' },
      source: 'builtin', permission: 'auto',
      invoke: async () => toolOk({ ok: true }),
    };
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [call('c1', 'echo', {})], content: '' },
      { content: 'done', stopReason: 'end' },
    ]);
    await new AgentLoop(llm, loopOptions({ tools: [echo], memoryNudgeEvery: 1 })).run();
    expect(llm.calls[1].messages.some(m => String(m.content).includes('Checkpoint reminder'))).toBe(false);
  });
});

// ─── ② 会话全文检索 ────────────────────────────────────────

describe('会话全文检索（FTS5 trigram）', () => {
  it('中英混合索引与检索；run 级聚合；重索引幂等', () => {
    const db = new Database(':memory:');
    migrate(db);
    const store = new SearchStore(() => db as any);

    store.indexRun('r1', '排查线上部署问题', '结论：回滚 nginx 配置即可', [
      { role: 'user', content: '上次那个部署问题怎么解决的' } as any,
      { role: 'tool', content: 'deployment log says port conflict', toolName: 'shell_run' } as any,
    ]);
    store.indexRun('r2', 'weekly report generation', 'The report was generated.', [
      { role: 'user', content: '生成周报并发邮件' } as any,
    ]);

    // 中文子串命中
    let hits = store.search('部署问题');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(h => h.runId === 'r1')).toBe(true);
    // 英文子串命中
    hits = store.search('nginx');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some(h => h.runId === 'r1')).toBe(true);
    // 不相关词不命中
    expect(store.search('量子纠缠实验').length).toBe(0);
    // 重索引幂等：r1 重建后不产生重复命中 run
    store.indexRun('r1', '排查线上部署问题', '结论更新', []);
    const again = store.search('部署问题');
    expect(new Set(again.map(h => h.runId)).size).toBe(again.length >= 2 ? 2 : again.length);
    db.close();
  });
});

// ─── ③ 团队 Watchdog ───────────────────────────────────────

describe('团队 Watchdog（整队 token 预算）', () => {
  it('80% 一次性预警；100% 拒绝新 spawn；账本按终态累计', () => {
    const events: Array<{ type: string; payload?: any }> = [];
    const team = new TeamService('r-wd', ev => events.push(ev), 1000);

    expect(team.checkSpawnTokens().ok).toBe(true);
    team.claimName('a'); team.registerTeammate('a', 'mate-a');
    team.claimName('b'); team.registerTeammate('b', 'mate-b');

    team.settleTeammate('a', 'completed', { status: 'completed', finalContent: '', tokensIn: 850, tokensOut: 50 });
    expect(team.teamUsage().usedTokens).toBe(900);
    // 900/1000 = 90% → 允许但预警（一次性）
    const warn = team.checkSpawnTokens();
    expect(warn.ok).toBe(true);
    expect((warn as any).warn).toBe(true);
    expect(events.some(e => e.type === 'team.budget_warning')).toBe(true);
    // 第二次不再预警
    expect((team.checkSpawnTokens() as any).warn).toBeUndefined();

    team.settleTeammate('b', 'completed', { status: 'completed', finalContent: '', tokensIn: 60, tokensOut: 40 });
    expect(team.teamUsage().usedTokens).toBe(1000);
    const blocked = team.checkSpawnTokens();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain('预算已耗尽');
  });
});

// ─── ④ 轨迹导出 ────────────────────────────────────────────

describe('轨迹 JSONL 导出（训练数据口径）', () => {
  it('首行元信息（含 system/model），其后每消息一行，工具字段保留', () => {
    const lines = buildTrajectoryLines({
      runId: 'r-traj',
      goal: '目标',
      status: 'completed',
      system: 'SYS-PROMPT',
      model: { model: 'glm-5.3', profileId: 'p1' },
      messages: [
        { role: 'user', content: 'hi' } as any,
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'echo', input: {} }] } as any,
        { role: 'tool', content: '{"ok":true}', toolName: 'echo', toolCallId: 'c1' } as any,
      ],
    });
    const meta = JSON.parse(lines[0]);
    expect(meta.format).toBe('coral-trajectory/1');
    expect(meta.model.model).toBe('glm-5.3');
    expect(meta.system).toBe('SYS-PROMPT');
    expect(meta.messageCount).toBe(3);
    const toolLine = JSON.parse(lines[3]);
    expect(toolLine.role).toBe('tool');
    expect(toolLine.toolName).toBe('echo');
    const asst = JSON.parse(lines[2]);
    expect(asst.toolCalls[0].name).toBe('echo');
  });
});

// ─── ⑤ 演化管线（提议 → 人审 → 落地） ─────────────────────

function makeEvolution(llmChat: (req: any) => Promise<{ content: string }>, skillsDir: string) {
  const reloaded: string[] = [];
  const svc = new EvolutionService(
    { llm: { chat: llmChat }, skillsDir, registry: { listAll: () => [], reloadSkill: async (n: string) => { reloaded.push(n); } } as any },
    dir,
  );
  return { svc, reloaded };
}

describe('演化管线（技能修订 / 新技能 / 画像提议）', () => {
  it('① 技能修订：负信号足够 → LLM 起草 → 接受后写盘 + 旧版备份 + 热重载', async () => {
    const skillsDir = join(dir, 'skills');
    mkdirSync(join(skillsDir, 'my-skill'), { recursive: true });
    writeFileSync(join(skillsDir, 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: d\n---\n\n旧版内容', 'utf-8');

    const { svc, reloaded } = makeEvolution(async () => ({
      content: JSON.stringify({ rationale: '修复超时处理缺失', revisedSkillMd: '---\nname: my-skill\ndescription: d\n---\n\n新版内容（含超时处理）' }),
    }), skillsDir);

    await svc.considerRun({
      runId: 'r1', goal: '做某事', steps: 9, toolCalls: 8,
      skillsUsed: ['my-skill'],
      skillFailures: [{ tool: 'skill_my-skill', errorPreview: 'SKILL_TIMEOUT' }, { tool: 'skill_my-skill', errorPreview: 'RETRY' }],
      gateRejections: 0, subagentFailures: 0, transcriptTail: '...',
    });

    const pending = svc.list('pending');
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe('skill_revision');
    expect(pending[0].skillName).toBe('my-skill');

    const r = await svc.decide(pending[0].id, true);
    expect(r.ok).toBe(true);
    const updated = readFileSync(join(skillsDir, 'my-skill', 'SKILL.md'), 'utf-8');
    expect(updated).toContain('新版内容');
    // 旧版备份 + 热重载调用
    const histDir = join(skillsDir, 'my-skill', '.history');
    expect(existsSync(histDir)).toBe(true);
    expect(reloaded).toContain('my-skill');
  });

  it('② 新技能提议：复杂任务 → 草案 → 接受后创建并重载', async () => {
    const skillsDir = join(dir, 'skills2');
    mkdirSync(skillsDir, { recursive: true });
    const { svc, reloaded } = makeEvolution(async () => ({
      content: JSON.stringify({
        name: 'deploy-runbook',
        rationale: '部署排查流程可复用',
        skillMd: '---\nname: deploy-runbook\ndescription: 部署排查\nexecution_mode: llm_only\n---\n\n# 部署排查\n\n步骤...',
      }),
    }), skillsDir);

    await svc.considerRun({
      runId: 'r2', goal: '排查部署失败并修复', steps: 13, toolCalls: 16,
      skillsUsed: [], skillFailures: [], gateRejections: 0, subagentFailures: 0,
      transcriptTail: 'user: 排查部署\nassistant: 先看日志…',
    });

    const pending = svc.list('pending');
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe('skill_new');
    expect(pending[0].skillName).toBe('deploy-runbook');

    const r = await svc.decide(pending[0].id, true);
    expect(r.ok).toBe(true);
    expect(existsSync(join(skillsDir, 'deploy-runbook', 'SKILL.md'))).toBe(true);
    expect(reloaded).toContain('deploy-runbook');
  });

  it('③ 画像提议 + 拒绝路径；同一 run 只产生一类提议', async () => {
    const skillsDir = join(dir, 'skills3');
    mkdirSync(skillsDir, { recursive: true });
    let callCount = 0;
    const { svc } = makeEvolution(async () => {
      callCount++;
      return { content: JSON.stringify({ insights: [{ field: 'interest', value: '机器人学', reason: '多轮追问 SLAM 细节' }] }) };
    }, skillsDir);

    await svc.considerRun({
      runId: 'r3', goal: '聊聊我的研究', steps: 9, toolCalls: 6,
      skillsUsed: [], skillFailures: [], gateRejections: 0, subagentFailures: 0,
      transcriptTail: 'user: 我在做 SLAM 研究…',
    });

    const pending = svc.list('pending');
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe('profile_update');
    expect(String(pending[0].rationale)).toContain('机器人学');

    // 拒绝：状态归档，二次裁决报错
    const r = await svc.decide(pending[0].id, false);
    expect(r.ok).toBe(true);
    const again = await svc.decide(pending[0].id, false);
    expect(again.ok).toBe(false);
    expect(svc.list('pending').length).toBe(0);
    expect(callCount).toBe(1);
  });

  it('LLM 返回 skip 时不产生提议', async () => {
    const skillsDir = join(dir, 'skills4');
    mkdirSync(skillsDir, { recursive: true });
    const { svc } = makeEvolution(async () => ({ content: JSON.stringify({ rationale: 'skip' }) }), skillsDir);
    await svc.considerRun({
      runId: 'r4', goal: '一次性杂务', steps: 13, toolCalls: 16,
      skillsUsed: [], skillFailures: [], gateRejections: 0, subagentFailures: 0, transcriptTail: '...',
    });
    expect(svc.list('pending').length).toBe(0);
  });

  it('负信号不足且复杂度不够 → 不发起任何蒸馏', async () => {
    const skillsDir = join(dir, 'skills5');
    mkdirSync(skillsDir, { recursive: true });
    let called = false;
    const { svc } = makeEvolution(async () => { called = true; return { content: '{}' }; }, skillsDir);
    await svc.considerRun({
      runId: 'r5', goal: '小事', steps: 5, toolCalls: 4,
      skillsUsed: ['x'], skillFailures: [], gateRejections: 0, subagentFailures: 0, transcriptTail: '...',
    });
    expect(called).toBe(false);
    expect(svc.list('pending').length).toBe(0);
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
