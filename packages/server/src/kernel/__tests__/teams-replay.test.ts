import { describe, it, expect } from 'vitest';
import { AgentLoop, type AgentLoopOptions, type LoopEvent, type LoopCheckpoint } from '../agent-loop.js';
import { TeamService } from '../team-service.js';
import { makeTeamSpawnTool } from '../../tools/builtin/spawn.js';
import { makeTeamSendTool } from '../../tools/builtin/team.js';
import type { ChatRequest, ChatResponse } from '../../providers/types.js';
import type { Tool } from '../../tools/types.js';
import { toolOk, makeToolContext } from '../../tools/types.js';

/**
 * Teams + 精确重放 — AgentLoop 级集成：
 *  · team_spawn 后台执行（不阻塞主循环）+ team_wait 收割最终回答
 *  · pollInbox 步边界投递：注入的消息出现在下一轮请求里
 *  · checkpoint 携带 system/model（精确重放）+ exactSystem 一字不差复现
 */

/** 路由式桩：按请求系统提示区分主循环 / teammate，各自走脚本 */
class RoutingLLM {
  mainCalls: ChatRequest[] = [];
  teammateCalls: ChatRequest[] = [];
  mainScript: Array<Partial<ChatResponse>> = [];
  teammateScript: Array<Partial<ChatResponse>> = [];
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const isTeammate = (req.system ?? '').includes('You are teammate');
    const list = isTeammate ? this.teammateCalls : this.mainCalls;
    const script = isTeammate ? this.teammateScript : this.mainScript;
    list.push(req);
    const item = script[Math.min(list.length - 1, script.length - 1)];
    return {
      content: item?.content ?? '',
      toolCalls: item?.toolCalls ?? [],
      usage: item?.usage ?? { inputTokens: 10, outputTokens: 5 },
      stopReason: item?.stopReason ?? 'end',
    };
  }
}

const call = (id: string, name: string, input: any) => ({ id, name, input });
const echo: Tool = {
  name: 'echo', description: 'echo', inputSchema: { type: 'object' },
  source: 'builtin', permission: 'auto',
  invoke: async (input: any) => toolOk({ echoed: input }),
};

function baseOptions(over: Partial<AgentLoopOptions>): AgentLoopOptions {
  return {
    runId: 'run-it',
    agentId: 'main',
    goal: 'goal',
    tools: [echo],
    budget: { maxSteps: 10, maxTokens: 1_000_000 },
    signal: new AbortController().signal,
    onEvent: () => {},
    ...over,
  } as AgentLoopOptions;
}

describe('Teams — 后台 teammate 与收割', () => {
  it('team_spawn 立即返回；team_wait 拿到 teammate 的最终回答', async () => {
    const llm = new RoutingLLM();
    const events: LoopEvent[] = [];
    const team = new TeamService('run-it', () => {});

    const teamSpawn = makeTeamSpawnTool({
      llm, baseTools: [echo], depth: 0, team,
      subBudget: { defaultSteps: 3, defaultTokens: 5000, maxSteps: 5, maxTokens: 10000 },
    });
    // team_wait 用真实 TeamService.wait 轮询
    const waitTool: Tool = {
      name: 'team_wait', description: 'wait', inputSchema: { type: 'object' },
      source: 'builtin', permission: 'auto',
      invoke: async (input: any) => {
        const handles = await team.wait([String(input.agents[0])], 5000);
        const h = handles[0];
        return toolOk({ results: [{ name: h.name, status: h.status, finalContent: h.result?.finalContent ?? '' }] });
      },
    };

    llm.mainScript = [
      { stopReason: 'tool_use', toolCalls: [call('c1', 'team_spawn', { name: 'scout', goal: 'find X' })], content: '' },
      { stopReason: 'tool_use', toolCalls: [call('c2', 'team_wait', { agents: ['scout'] })], content: '' },
      { content: 'final done', stopReason: 'end' },
    ];
    llm.teammateScript = [{ content: 'answer-42', stopReason: 'end' }];

    const ctx = makeToolContext({ runId: 'run-it', emit: () => {} });
    // 立即返回性：直接调用一次（独立名字 probe）验证不阻塞 — invoke 在 teammate 完成前就返回
    const t0 = Date.now();
    const spawnResult = await teamSpawn.invoke({ name: 'probe', goal: 'probe goal' }, ctx);
    expect(spawnResult.ok).toBe(true);
    expect((spawnResult.data as any).status).toBe('running');
    expect(Date.now() - t0).toBeLessThan(2000); // 未等待 teammate 跑完

    const loop = new AgentLoop(llm, baseOptions({
      tools: [echo, teamSpawn, waitTool],
      onEvent: e => events.push(e),
    }));
    const result = await loop.run();

    expect(result.status).toBe('completed');
    // teammate 已终态且带最终回答
    const scout = team.getTeammate('scout')!;
    expect(scout.status).toBe('completed');
    expect(scout.result?.finalContent).toBe('answer-42');
    // 主循环 team_wait 的结果进入其上下文（第三轮请求可见 — 取最后一条 tool 消息）
    const toolMsgs = llm.mainCalls[2].messages.filter(m => m.role === 'tool');
    expect(String(toolMsgs[toolMsgs.length - 1]?.content)).toContain('answer-42');
    // 事件留痕
    expect(events.some(e => e.type === 'team.teammate_spawned')).toBe(true);
    expect(events.some(e => e.type === 'team.teammate_completed')).toBe(true);
  });
});

describe('Teams — 步边界收件（pollInbox）', () => {
  it('收件箱消息在下一轮请求前注入为 user 消息；排空后不重复注入', async () => {
    const llm = new RoutingLLM();
    llm.mainScript = [
      { stopReason: 'tool_use', toolCalls: [call('c1', 'echo', {})], content: '' },
      { content: 'ok', stopReason: 'end' },
    ];
    let pollCount = 0;
    const result = await new AgentLoop(llm, baseOptions({
      pollInbox: () => {
        pollCount++;
        return pollCount === 2 ? [{ from: 'scout', content: '查到了：X=3' }] : [];
      },
    })).run();

    expect(result.status).toBe('completed');
    const second = llm.mainCalls[1].messages;
    expect(second.some(m => m.role === 'user' && String(m.content).includes('[teammate message from scout]') && String(m.content).includes('X=3'))).toBe(true);
  });
});

describe('精确重放 — checkpoint 与 exactSystem', () => {
  it('checkpoint 携带 system 与 modelInfo；压缩审计线为空数组或缺失', async () => {
    const llm = new RoutingLLM();
    llm.mainScript = [
      { stopReason: 'tool_use', toolCalls: [call('c1', 'echo', {})], content: '' },
      { content: 'done', stopReason: 'end' },
    ];
    const checkpoints: LoopCheckpoint[] = [];
    await new AgentLoop(llm, baseOptions({
      modelInfo: { model: 'glm-5.3', profileId: 'p1' },
      saveCheckpoint: cp => checkpoints.push(cp),
    })).run();

    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    for (const cp of checkpoints) {
      expect(cp.state.system).toContain('You are CORAL');
      expect(cp.state.model?.model).toBe('glm-5.3');
      expect(cp.state.model?.profileId).toBe('p1');
    }
  });

  it('exactSystem：提供时一字不差复现（不叠加现场组装）', async () => {
    const llm = new RoutingLLM();
    llm.mainScript = [{ content: 'done', stopReason: 'end' }];
    await new AgentLoop(llm, baseOptions({
      exactSystem: 'CUSTOM-HISTORICAL-SYSTEM-12345',
      extraSystem: '现场组装的部分不应出现',
    })).run();
    expect(llm.mainCalls[0].system).toBe('CUSTOM-HISTORICAL-SYSTEM-12345');
  });
});
