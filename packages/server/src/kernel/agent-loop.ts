import type { ChatMessage, ChatRequest, ChatResponse, ToolDefinition } from '../providers/types.js';
import type { Tool, ToolResult } from '../tools/types.js';
import { makeToolContext } from '../tools/types.js';
import { clipToolResults, compressIfNeeded } from './context-window.js';

/**
 * M1-3：Agent Loop — v2 的心脏（V2_PLAN §4.2）。
 *
 * 纯内核设计：LLM 走注入接口、事件走回调、checkpoint 走 sink — 不直接触库/事件总线，
 * M1-5 run-engine 负责接线。每轮：压缩检查 → llm.chat → 工具执行（审批位）→ 预算检查
 * → checkpoint，直到模型给出最终回答 / 预算耗尽（优雅收尾）/ 取消。
 */

export interface LoopEvent {
  type: string;
  payload?: Record<string, any>;
}

export interface LoopCheckpoint {
  seq: number;
  kind: 'loop_step';
  label: string;
  state: { messages: ChatMessage[] };
}

export interface LoopBudget {
  maxSteps: number;
  maxTokens: number;
  /** 预留（M1-5 接入定价后生效） */
  maxCostUsd?: number;
}

export interface AgentLoopOptions {
  runId: string;
  agentId: string;
  goal: string;
  /** 追加到基础系统提示的额外指令（如公司画像/记忆指引，由 run-engine 注入） */
  extraSystem?: string;
  tools: Tool[];
  budget: LoopBudget;
  signal: AbortSignal;
  onEvent: (e: LoopEvent) => void;
  /** 每 N 步落 checkpoint（默认 1 = 每步） */
  checkpointEvery?: number;
  saveCheckpoint?: (cp: LoopCheckpoint) => void;
  workspaceDir?: string;
  /**
   * 审批回调（permission='approval' 的工具执行前询问）。
   * 未注入时安全默认：拒绝执行（M2-4 审批中心接管前的保守策略）。
   */
  approveTool?: (tool: Tool, input: any) => Promise<boolean>;
  /** 上下文压缩阈值（字符）与保留条数；summarize 由 run-engine 注入 llmClient */
  maxTotalChars?: number;
  keepRecent?: number;
  summarize?: (transcript: string) => Promise<string>;
}

export interface LoopResult {
  status: 'completed' | 'cancelled' | 'budget_exceeded' | 'failed';
  finalContent: string;
  messages: ChatMessage[];
  steps: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  error?: string;
}

/** LLM 接口（llmClient 天然满足；测试注入脚本化桩） */
export interface LoopLLM {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

const BASE_SYSTEM = `You are CORAL, a personal local-first agent runtime. You accomplish the user's goal autonomously.

Working rules:
- Use the provided tools to gather information and take actions. Prefer tools over guessing.
- For multi-step work, maintain a visible plan with the todo_write tool and update statuses as you go.
- Tool results come back as JSON. Read them carefully before deciding the next step.
- If a tool fails, read the error: retry only when it says retryable, otherwise adapt your approach.
- When the goal is achieved (or truly blocked), stop calling tools and write a concise final answer in the user's language.
- Never fabricate results you did not obtain from tools.`;

export class AgentLoop {
  constructor(
    private llm: LoopLLM,
    private options: AgentLoopOptions
  ) {}

  async run(): Promise<LoopResult> {
    const { goal, tools, budget, signal } = this.options;
    const toolMap = new Map(tools.map(t => [t.name, t]));
    const toolDefs: ToolDefinition[] = tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    const system = this.buildSystemPrompt();
    let messages: ChatMessage[] = [{ role: 'user', content: goal }];

    let steps = 0;
    let toolCallCount = 0;
    let tokensIn = 0;
    let tokensOut = 0;

    try {
      while (true) {
        signal.throwIfAborted?.();

        // 上下文管理：先裁剪单条超大工具结果，再按需压缩历史
        messages = clipToolResults(messages);
        const compressed = await compressIfNeeded(messages, {
          maxTotalChars: this.options.maxTotalChars,
          keepRecent: this.options.keepRecent,
          summarize: this.options.summarize,
        });
        if (compressed.compressed) {
          messages = compressed.messages;
          this.emit('loop.context_compressed', {
            summaryChars: compressed.summary?.length ?? 0,
            keptMessages: messages.length,
          });
        }

        steps++;
        this.emit('loop.step_started', { step: steps, tokensIn, tokensOut });

        const response = await this.llm.chat({
          system,
          messages,
          tools: toolDefs,
          signal,
          maxTokens: 4096,
        });
        tokensIn += response.usage.inputTokens;
        tokensOut += response.usage.outputTokens;

        // 模型给出最终回答
        if (response.stopReason !== 'tool_use' || response.toolCalls.length === 0) {
          messages.push({ role: 'assistant', content: response.content });
          this.checkpoint(steps, messages);
          this.emit('loop.step_completed', { step: steps, final: true });
          return {
            status: 'completed',
            finalContent: response.content,
            messages,
            steps,
            toolCalls: toolCallCount,
            tokensIn,
            tokensOut,
          };
        }

        // assistant 发起工具调用 → 入历史
        messages.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        // 逐个执行（保持模型给出的顺序）
        for (const call of response.toolCalls) {
          toolCallCount++;
          const tool = toolMap.get(call.name);

          this.emit('tool.call_started', {
            step: steps,
            tool: call.name,
            callId: call.id,
            inputPreview: preview(call.input),
          });

          const result = await this.executeTool(tool, call);
          const content = JSON.stringify(
            result.ok ? result.data : { error: result.error }
          );

          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content,
          });

          this.emit(result.ok ? 'tool.call_completed' : 'tool.call_failed', {
            step: steps,
            tool: call.name,
            callId: call.id,
            ok: result.ok,
            error: result.ok ? undefined : result.error,
          });
        }

        this.checkpoint(steps, messages);
        this.emit('loop.step_completed', { step: steps, final: false });

        // 预算检查（工具轮结束后、下一轮 LLM 调用前）
        const stepsExhausted = steps >= budget.maxSteps;
        const tokensExhausted = tokensIn + tokensOut >= budget.maxTokens;
        if (stepsExhausted || tokensExhausted) {
          // 优雅收尾：最后一次不带工具的调用，让模型总结进展（不继续干活）
          const wrapUp = await this.wrapUp(messages, stepsExhausted ? 'maxSteps' : 'maxTokens');
          messages.push({ role: 'assistant', content: wrapUp.content });
          this.emit('loop.budget_exceeded', {
            reason: stepsExhausted ? 'maxSteps' : 'maxTokens',
            steps,
            tokensIn,
            tokensOut,
          });
          return {
            status: 'budget_exceeded',
            finalContent: wrapUp.content,
            messages,
            steps,
            toolCalls: toolCallCount,
            tokensIn: tokensIn + wrapUp.usage.inputTokens,
            tokensOut: tokensOut + wrapUp.usage.outputTokens,
          };
        }
      }
    } catch (err: any) {
      if (signal.aborted || err?.name === 'AbortError') {
        this.checkpoint(steps, messages);
        this.emit('loop.cancelled', { step: steps });
        return {
          status: 'cancelled',
          finalContent: '',
          messages,
          steps,
          toolCalls: toolCallCount,
          tokensIn,
          tokensOut,
          error: '已取消',
        };
      }
      this.emit('loop.failed', { step: steps, error: err?.message ?? String(err) });
      return {
        status: 'failed',
        finalContent: '',
        messages,
        steps,
        toolCalls: toolCallCount,
        tokensIn,
        tokensOut,
        error: err?.message ?? String(err),
      };
    }
  }

  /** 单个工具执行：未知工具 / 审批位 / 异常兜底 */
  private async executeTool(tool: Tool | undefined, call: { name: string; input: Record<string, any> }): Promise<ToolResult> {
    if (!tool) {
      return { ok: false, error: { code: 'TOOL_NOT_FOUND', message: `工具不存在: ${call.name}`, retryable: false } };
    }
    try {
      if (tool.permission === 'approval') {
        const approved = this.options.approveTool
          ? await this.options.approveTool(tool, call.input)
          : false; // 安全默认：未接审批通道时拒绝
        if (!approved) {
          return { ok: false, error: { code: 'APPROVAL_DENIED', message: `工具 ${call.name} 需要人工审批，当前未获批准`, retryable: false } };
        }
      }
      return await tool.invoke(call.input, makeToolContext({
        runId: this.options.runId,
        agentId: this.options.agentId,
        signal: this.options.signal,
        workspaceDir: this.options.workspaceDir,
        emit: ev => this.emit(ev.type, { tool: call.name, ...ev.payload }),
      }));
    } catch (err: any) {
      if (this.options.signal.aborted || err?.name === 'AbortError') throw err; // 取消向上传播
      return { ok: false, error: { code: 'TOOL_CRASHED', message: err?.message ?? String(err), retryable: false } };
    }
  }

  /** 预算耗尽的收尾调用：不带工具、注入收尾指令 */
  private async wrapUp(messages: ChatMessage[], reason: 'maxSteps' | 'maxTokens'): Promise<ChatResponse> {
    const note: ChatMessage = {
      role: 'user',
      content:
        `[system] Budget limit (${reason}) reached. Stop calling tools now and immediately write a final answer: ` +
        `summarize what has been accomplished so far, what remains, and any partial results.`,
    };
    return this.llm.chat({
      system: this.buildSystemPrompt(),
      messages: [...messages, note],
      signal: this.options.signal,
      maxTokens: 2048,
    });
  }

  private checkpoint(step: number, messages: ChatMessage[]): void {
    const every = this.options.checkpointEvery ?? 1;
    if (!this.options.saveCheckpoint || step % every !== 0) return;
    this.options.saveCheckpoint({
      seq: step,
      kind: 'loop_step',
      label: `step-${step}`,
      state: { messages },
    });
    this.emit('checkpoint.created', { seq: step, label: `step-${step}` });
  }

  private buildSystemPrompt(): string {
    const parts = [BASE_SYSTEM];
    if (this.options.workspaceDir) {
      parts.push(`A local workspace directory is bound. File tools operate inside it with relative paths.`);
    }
    if (this.options.extraSystem) {
      parts.push(this.options.extraSystem);
    }
    return parts.join('\n\n');
  }

  private emit(type: string, payload?: Record<string, any>): void {
    try {
      this.options.onEvent({ type, payload });
    } catch { /* 事件消费者异常不中断循环 */ }
  }
}

function preview(input: unknown): string {
  const s = JSON.stringify(input ?? {});
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}
