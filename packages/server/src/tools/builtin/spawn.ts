import { nanoid } from 'nanoid';
import { AgentLoop, type LoopLLM } from '../../kernel/agent-loop.js';
import type { Tool, ToolResult } from '../types.js';
import { toolOk, toolError } from '../types.js';

/**
 * M1-4：agent_spawn — orchestrator 派生 sub-agent（harness 范式的子代理）。
 *
 *  · 独立上下文窗口：子任务全部中间过程不占主循环上下文，只回传最终答案
 *  · 工具子集：请求按名筛选，**永不超出父级可用集**（安全不变量）；
 *    未指定时继承全部基础工具
 *  · 预算钳制：子预算 = 请求值 clamp 到 [1, 上限]；上限由工厂注入（父级预算减半量级）
 *  · 深度 ≤ 2：depth<maxDepth 的子循环才配备下一代 spawn 工具
 *  · 取消级联：子循环直接继承父 signal
 *  · 事件溯源：子循环事件带 agentId=sub-N 汇入同一 run；另有 subagent.started/completed/failed
 *  · run 级 spawn 限额：防模型 spawn 风暴
 */

export interface SpawnDeps {
  llm: LoopLLM;
  summarize?: (transcript: string) => Promise<string>;
  /** 主循环的全部基础工具（不含 spawn 自身）— 子集的挑选池 */
  baseTools: Tool[];
  /** 本工具所属循环的深度（主循环 = 0） */
  depth: number;
  /** 允许的最大嵌套深度（默认 2：主 → 子 → 孙，孙不再有 spawn） */
  maxDepth?: number;
  /** run 级共享的 spawn 计数器（同一 run 的所有层级共用） */
  spawnCounter?: { count: number };
  /** 每 run 最大 spawn 次数（默认 8） */
  maxSpawnsPerRun?: number;
  /** 子预算默认值与硬上限 */
  subBudget: { defaultSteps: number; defaultTokens: number; maxSteps: number; maxTokens: number };
}

const GOAL_LIMIT = 10_000;
const SYSTEM_LIMIT = 2_000;

const SUB_EXTRA_SYSTEM = `You are a SUB-AGENT spawned by an orchestrator to execute one focused subtask.
Focus strictly on the assigned goal, use tools as needed, and finish with a concise, self-contained
final answer — the orchestrator only sees that answer, not your intermediate steps.`;

export function makeSpawnTool(deps: SpawnDeps): Tool {
  const maxDepth = deps.maxDepth ?? 2;
  const spawnCounter = deps.spawnCounter ?? { count: 0 };
  const maxSpawns = deps.maxSpawnsPerRun ?? 8;

  return {
    name: 'agent_spawn',
    description:
      'Spawn a sub-agent with a FRESH context window to execute a self-contained subtask and return its final answer. ' +
      'Use it to isolate long or noisy work (deep research, multi-file analysis, repetitive processing) from the main thread. ' +
      'Optionally pass a subset of tool names; the sub-agent can never access tools beyond your own set.',
    inputSchema: {
      type: 'object',
      required: ['goal'],
      properties: {
        goal: { type: 'string', description: 'Complete, self-contained description of the subtask (include all needed context)' },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional subset of tool names the sub-agent may use (default: all your tools except agent_spawn)',
        },
        system_prompt: { type: 'string', description: 'Optional extra instructions for the sub-agent' },
        max_steps: { type: 'integer', description: `Step budget for the sub-agent (default ${deps.subBudget.defaultSteps}, max ${deps.subBudget.maxSteps})` },
        max_tokens: { type: 'integer', description: `Token budget for the sub-agent (default ${deps.subBudget.defaultTokens}, max ${deps.subBudget.maxTokens})` },
      },
    },
    source: 'builtin',
    permission: 'auto',

    async invoke(input: any, ctx): Promise<ToolResult> {
      const goal = String(input?.goal ?? '').trim();
      if (!goal) return toolError('BAD_INPUT', 'goal 必填');
      if (goal.length > GOAL_LIMIT) return toolError('BAD_INPUT', `goal 过长（${goal.length}，上限 ${GOAL_LIMIT}）`);

      if (spawnCounter.count >= maxSpawns) {
        return toolError('SPAWN_LIMIT', `本 run 的 sub-agent 数量已达上限（${maxSpawns}）`, false);
      }

      // 工具子集（安全不变量：只在 baseTools 内筛选）
      const subset = pickSubset(deps.baseTools, input?.tools);
      if ('error' in subset) return toolError('BAD_TOOLS', subset.error);

      const childDepth = deps.depth + 1;
      const subId = `sub-${childDepth}-${nanoid(4)}`;

      const subTools: Tool[] = [...subset.tools];
      if (childDepth < maxDepth) {
        subTools.push(makeSpawnTool({ ...deps, depth: childDepth, spawnCounter }));
      }

      const budget = {
        maxSteps: clamp(Number(input?.max_steps) || deps.subBudget.defaultSteps, 1, deps.subBudget.maxSteps),
        maxTokens: clamp(Number(input?.max_tokens) || deps.subBudget.defaultTokens, 1000, deps.subBudget.maxTokens),
      };

      spawnCounter.count++;
      ctx.emit({
        type: 'subagent.started',
        payload: {
          agentId: subId,
          depth: childDepth,
          goalPreview: goal.slice(0, 200),
          toolNames: subTools.map(t => t.name),
          budget,
        },
      });

      const extraSystem = [
        SUB_EXTRA_SYSTEM,
        ...(typeof input?.system_prompt === 'string' && input.system_prompt.trim()
          ? [input.system_prompt.slice(0, SYSTEM_LIMIT)]
          : []),
      ].join('\n\n');

      const loop = new AgentLoop(deps.llm, {
        runId: ctx.runId,
        agentId: subId,
        goal,
        tools: subTools,
        budget,
        signal: ctx.signal,
        workspaceDir: ctx.workspaceDir,
        extraSystem,
        onEvent: ev => ctx.emit(ev),
        summarize: deps.summarize,
      });

      const result = await loop.run();

      if (result.status === 'cancelled' || ctx.signal.aborted) {
        ctx.emit({ type: 'subagent.failed', payload: { agentId: subId, status: 'cancelled' } });
        return toolError('CANCELLED', 'sub-agent 已随任务取消', false);
      }
      if (result.status === 'failed') {
        ctx.emit({ type: 'subagent.failed', payload: { agentId: subId, status: 'failed', error: result.error } });
        return toolError('SUBAGENT_FAILED', `sub-agent 执行失败: ${result.error}`, false);
      }

      ctx.emit({
        type: 'subagent.completed',
        payload: {
          agentId: subId,
          status: result.status,
          steps: result.steps,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
        },
      });

      return toolOk({
        status: result.status,
        finalContent: result.finalContent,
        steps: result.steps,
        toolCalls: result.toolCalls,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      });
    },
  };
}

type SubsetResult = { tools: Tool[] } | { error: string };

function pickSubset(base: Tool[], requested: unknown): SubsetResult {
  if (requested === undefined || requested === null) return { tools: base };
  if (!Array.isArray(requested) || requested.some(n => typeof n !== 'string')) {
    return { error: 'tools 必须为字符串数组' };
  }
  const byName = new Map(base.map(t => [t.name, t]));
  const picked: Tool[] = [];
  const missing: string[] = [];
  for (const name of requested as string[]) {
    const t = byName.get(name);
    if (t) picked.push(t);
    else missing.push(name);
  }
  if (missing.length > 0) {
    return { error: `以下工具不在可用集合内: ${missing.join(', ')}（可用: ${[...byName.keys()].join(', ')}）` };
  }
  return { tools: picked };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(v), min), max);
}
