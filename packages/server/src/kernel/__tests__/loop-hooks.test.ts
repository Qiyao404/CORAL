import { describe, it, expect } from 'vitest';
import { AgentLoop, type AgentLoopOptions, type LoopHooks, type LoopEvent } from '../agent-loop.js';
import type { ChatRequest, ChatResponse } from '../../providers/types.js';
import type { Tool } from '../../tools/types.js';
import { SlashCommandService, seedSlashCommands } from '../../services/slash-commands.js';
import { AgentPresetService, seedAgentPresets } from '../../services/agent-presets.js';
import { makeSpawnTool } from '../../tools/builtin/spawn.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

class ScriptedLLM {
  calls: ChatRequest[] = [];
  constructor(public script: Array<Partial<ChatResponse>>) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    const item = this.script[this.calls.length - 1] ?? {};
    return {
      content: item.content ?? '',
      toolCalls: item.toolCalls ?? [],
      usage: item.usage ?? { inputTokens: 100, outputTokens: 50 },
      stopReason: item.stopReason ?? 'end',
    };
  }
}

const toolCall = (id: string, name: string, input: any = {}) => ({ id, name, input });

/** 一次性守卫桩：按事件脚本回放裁决 */
function stubHooks(script: Record<string, any | ((p: any) => any)>): LoopHooks {
  return {
    run: async (event, payload) => {
      const entry = script[event];
      const out = typeof entry === 'function' ? entry(payload) : entry;
      return {
        decision: out?.decision ?? 'allow',
        ...(out?.reason ? { reason: out.reason } : {}),
        ...(out?.updatedInput ? { updatedInput: out.updatedInput } : {}),
        ...(out?.additionalContext ? { additionalContext: out.additionalContext } : {}),
        matched: 1,
        failed: 0,
      };
    },
  };
}

function harness(hooks: LoopHooks, llm: ScriptedLLM, tools: Tool[], over: Partial<AgentLoopOptions> = {}) {
  const events: LoopEvent[] = [];
  const loop = new AgentLoop(llm, {
    runId: 'run-h', agentId: 'main', goal: '目标',
    tools, budget: { maxSteps: 10, maxTokens: 1e9 },
    signal: new AbortController().signal,
    onEvent: e => events.push(e),
    hooks,
    ...over,
  });
  return { loop, events };
}

const echo = (name = 'echo'): Tool => ({
  name, description: '', inputSchema: { type: 'object' }, source: 'builtin', permission: 'auto',
  invoke: async (input: any) => ({ ok: true, data: { got: input } }),
});

describe('AgentLoop × hooks（结构化桩）', () => {
  it('pre_tool_use deny → HOOK_DENIED 工具结果 + 事件留痕', async () => {
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c1', 'echo', { x: 1 })], content: '' },
      { stopReason: 'end', content: 'done' },
    ]);
    const { loop, events } = harness(
      stubHooks({ pre_tool_use: { decision: 'deny', reason: '测试拒绝' } }),
      llm, [echo()]
    );
    const r = await loop.run();
    const toolMsg = r.messages.find(m => m.role === 'tool')!;
    expect(JSON.parse(toolMsg.content).error.code).toBe('HOOK_DENIED');
    expect(JSON.parse(toolMsg.content).error.message).toContain('测试拒绝');
    expect(events.some(e => e.type === 'tool.hook_denied')).toBe(true);
  });

  it('pre_tool_use updatedInput → 改写后的入参进入工具', async () => {
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c1', 'echo', { x: 1 })], content: '' },
      { stopReason: 'end', content: 'done' },
    ]);
    const { loop, events } = harness(
      stubHooks({ pre_tool_use: { decision: 'allow', updatedInput: { x: 999 } } }),
      llm, [echo()]
    );
    const r = await loop.run();
    const toolMsg = r.messages.find(m => m.role === 'tool')!;
    expect(JSON.parse(toolMsg.content).got).toEqual({ x: 999 });
    expect(events.some(e => e.type === 'tool.hook_input_rewritten')).toBe(true);
  });

  it('stop block 一次 → 打回重写；第二次 allow → 交付', async () => {
    const llm = new ScriptedLLM([
      { stopReason: 'end', content: '第一版回答' },
      { stopReason: 'end', content: '修订后的回答' },
    ]);
    let stopCalls = 0;
    const { loop, events } = harness(
      stubHooks({
        stop: () => (stopCalls++ === 0 ? { decision: 'block', reason: '缺少数据来源' } : { decision: 'allow' }),
      }),
      llm, [echo()]
    );
    const r = await loop.run();
    expect(r.finalContent).toBe('修订后的回答');
    expect(events.some(e => e.type === 'loop.hook_stop_rejected')).toBe(true);
    expect(llm.calls[1].messages.some(m => m.content?.includes('external reviewer hook') && m.content?.includes('缺少数据来源'))).toBe(true);
  });

  it('user_prompt_submit deny → run 直接失败（外部守卫拦下任务）；additionalContext 注入', async () => {
    const llmDenied = new ScriptedLLM([]);
    const { loop: l1, events: e1 } = harness(
      stubHooks({ user_prompt_submit: { decision: 'deny', reason: '涉密主题禁止' } }),
      llmDenied, [echo()]
    );
    const r1 = await l1.run();
    expect(r1.status).toBe('failed');
    expect(r1.error).toContain('涉密主题禁止');
    expect(e1.some(e => e.type === 'loop.hook_denied')).toBe(true);

    const llm2 = new ScriptedLLM([{ stopReason: 'end', content: 'ok' }]);
    const { loop: l2 } = harness(
      stubHooks({ user_prompt_submit: { decision: 'allow', additionalContext: '今天是周四' } }),
      llm2, [echo()]
    );
    const r2 = await l2.run();
    expect(llm2.calls[0].messages[0].content).toContain('今天是周四');
    expect(r2.status).toBe('completed');
  });

  it('pre_compact block → 跳过本次压缩（事件留痕）', async () => {
    const big = (name: string): Tool => ({
      name, description: '', inputSchema: { type: 'object' }, source: 'builtin', permission: 'auto',
      invoke: async () => ({ ok: true, data: { blob: 'W'.repeat(40_000) } }),
    });
    const llm = new ScriptedLLM([
      { stopReason: 'tool_use', toolCalls: [toolCall('c1', 'big')], content: '' },
      { stopReason: 'tool_use', toolCalls: [toolCall('c2', 'big')], content: '' },
      { stopReason: 'tool_use', toolCalls: [toolCall('c3', 'big')], content: '' },
      { stopReason: 'end', content: 'done' },
    ]);
    let summarizeCalls = 0;
    const { loop, events } = harness(
      stubHooks({ pre_compact: { decision: 'block', reason: '保持完整历史' } }),
      llm, [big('big')], {
        maxTotalChars: 20_000,
        keepRecent: 2,
        summarize: async () => { summarizeCalls++; return '摘要'; },
      }
    );
    const r = await loop.run();
    expect(r.status).toBe('completed');
    expect(summarizeCalls).toBe(0); // 压缩全被守卫拦下
    expect(events.some(e => e.type === 'loop.compact_skipped_by_hook')).toBe(true);
  });
});

describe('斜杠命令 — 展开契约', () => {
  let dir: string;
  const withDir = (fn: () => void) => {
    dir = mkdtempSync(join(tmpdir(), 'coral-slash-'));
    try { fn(); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it('播种 + $ARGUMENTS/$1 展开 + 未命中返回 null', () => {
    withDir(() => {
      expect(seedSlashCommands(dir)).toBe(4);
      const svc = new SlashCommandService(dir);
      const list = svc.list();
      expect(list.map(c => c.name).sort()).toEqual(['brief', 'plan', 'research', 'review']);

      const hit = svc.expand('/research 量子计算 最新进展');
      expect(hit).not.toBeNull();
      expect(hit!.goal).toContain('量子计算 最新进展');
      expect(hit!.command.name).toBe('research');

      const positional = svc.expand('/plan 迁移数据库');
      expect(positional!.goal).toContain('迁移数据库');

      expect(svc.expand('/不存在')).toBeNull();
      expect(svc.expand('普通输入')).toBeNull();

      // 二次播种幂等
      expect(seedSlashCommands(dir)).toBe(0);
    });
  });
});

describe('具名子代理预设 — spawn 集成', () => {
  it('agent 参数加载预设 prompt + 工具白名单；未知预设报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coral-agents-'));
    try {
      seedAgentPresets(dir);
      const presets = new AgentPresetService(dir);
      expect(presets.list().length).toBeGreaterThanOrEqual(4);
      expect(presets.toPromptText()).toContain('research-analyst');
      expect(presets.toPromptText()).toContain('e.g.');

      // spawn 集成：预设 prompt 进入子代理系统提示；白名单生效
      const llm = new ScriptedLLM([{ stopReason: 'end', content: '子任务完成' }]);
      const allowed = echo('fs_read');
      const webTool = echo('http_fetch');
      const outOfWhitelist = echo('shell_run'); // 不在 research-analyst 白名单内
      const spawn = makeSpawnTool({
        llm: llm as any,
        baseTools: [allowed, webTool, outOfWhitelist],
        subBudget: { defaultSteps: 3, defaultTokens: 5000, maxSteps: 6, maxTokens: 10000 },
        presets,
        depth: 0,
        spawnCounter: { count: 0 },
      });
      const r = await spawn.invoke(
        { goal: '调研 X', agent: 'research-analyst' },
        { runId: 'r', agentId: 'main', signal: new AbortController().signal, emit: () => {} } as any
      );
      expect(r.ok).toBe(true);
      // 子代理系统提示含预设正文片段（"调研专员"）
      expect(llm.calls[0].system).toContain('调研专员');
      // 工具白名单：白名单内的都在，白名单外的被滤掉
      const toolNames = (llm.calls[0].tools ?? []).map((t: any) => t.name);
      expect(toolNames).toContain('fs_read');
      expect(toolNames).toContain('http_fetch');
      expect(toolNames).not.toContain('shell_run');

      const bad = await spawn.invoke(
        { goal: 'x', agent: 'ghost-agent' },
        { runId: 'r', agentId: 'main', signal: new AbortController().signal, emit: () => {} } as any
      );
      expect(bad.ok).toBe(false);
      expect((bad.error as any).code).toBe('PRESET_NOT_FOUND');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
