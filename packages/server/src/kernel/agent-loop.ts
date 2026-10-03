import type { ChatMessage, ChatRequest, ChatResponse, ToolDefinition } from '../providers/types.js';
import type { Tool, ToolResult } from '../tools/types.js';
import { makeToolContext } from '../tools/types.js';
import { clipToolResults, compressIfNeeded } from './context-window.js';
import { platformConfig } from '../services/config.js';
import { resolveToolName } from '../tools/alias.js';

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
  /** 多轮续接：本会话此前的对话历史（含上一轮的 goal/工具结果/最终回答），种子在新 goal 之前 */
  initialHistory?: ChatMessage[];
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
   * callId：本轮工具调用的 id（审批事件关联用，M1-10）。
   */
  approveTool?: (tool: Tool, input: any, callId?: string) => Promise<boolean>;
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
  /** LLM 接口（llmClient 天然满足；测试注入脚本化桩）。chatStream 可选 — 未注入回退 chat */
  chat(req: ChatRequest): Promise<ChatResponse>;
  chatStream?(req: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResponse>;
}

const BASE_SYSTEM = `You are CORAL, a personal local-first agent runtime. You accomplish the user's goal autonomously.

Working rules:
- Use the provided tools to gather information and take actions. Prefer tools over guessing.
- For multi-step work, maintain a visible plan with the todo_write tool and update statuses as you go.
- Tool results come back as JSON. Read them carefully before deciding the next step.
- If a tool fails, read the error: retry only when it says retryable, otherwise adapt your approach. If a TOOL_NOT_FOUND error lists available tools, switch to one of those exact names.
- To see WHAT FILES exist in the workspace, always use fs_list first. fs_search only scans text files and silently skips binary formats (.docx/.xlsx) — never conclude a workspace is "empty" from fs_search results alone.
- When the user refers to "the file I uploaded" but the workspace contains several files, use fs_list, prefer the most recently modified candidate, and state clearly which file you used.
- Skills whose name starts with "skill_" are prompt generators — they CANNOT read local files. To read workspace files use fs_read (text), docx_read (Word .docx), or fs_search (keyword search). Never trust a skill that claims to "read" a file — it can only fabricate content.
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
    // 多轮续接：先种入历史（合法性过滤），再追加本轮 goal
    const seed = (this.options.initialHistory ?? []).filter(
      m => m && typeof m.content === 'string' && ['user', 'assistant', 'tool'].includes(m.role)
    );
    let messages: ChatMessage[] = [...seed, { role: 'user' as const, content: goal }];

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

        // 创新①：流式直播 — 支持则逐 token 聚为 loop.delta 事件（前端逐字渲染）
        let deltaBuf = '';
        const flushTimer = this.llm.chatStream
          ? setInterval(() => {
              if (deltaBuf) {
                this.emit('loop.delta', { step: steps, delta: deltaBuf });
                deltaBuf = '';
              }
            }, 120) // 120ms 聚合批次（防事件风暴）
          : null;
        const onDelta = (d: string) => { deltaBuf += d; };

        let response: ChatResponse;
        try {
          response = this.llm.chatStream
            ? await this.llm.chatStream({ system, messages, tools: toolDefs, signal, maxTokens: 4096 }, onDelta)
            : await this.llm.chat({ system, messages, tools: toolDefs, signal, maxTokens: 4096 });
        } finally {
          if (flushTimer) clearInterval(flushTimer);
        }
        if (deltaBuf) this.emit('loop.delta', { step: steps, delta: deltaBuf });
        if (response.degraded) this.emit('loop.llm_degraded', { step: steps });
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

  /** 单个工具执行：未知工具（附可用清单，模型可自纠）/ 审批位 / 异常兜底（call 携带 id — 审批事件与结果预览关联用） */
  private async executeTool(tool: Tool | undefined, call: { id: string; name: string; input: Record<string, any> }): Promise<ToolResult> {
    // M1 打磨（用户实测）：常见幻觉名自动纠正（web_fetch → http_fetch 等），
    // 纠正时在结果里附备注让模型知道实际执行的名字（后续轮次改用正确名）
    let resolvedTool = tool;
    let correctedFrom: string | undefined;
    if (!resolvedTool) {
      const fixed = resolveToolName(call.name, this.options.tools);
      if (fixed) {
        resolvedTool = fixed.tool;
        correctedFrom = fixed.correctedFrom;
      }
    }

    if (!resolvedTool) {
      return {
        ok: false,
        error: {
          code: 'TOOL_NOT_FOUND',
          message: `工具 "${call.name}" 不存在。可用工具: ${this.options.tools.map(t => t.name).join(', ')}`,
          retryable: false,
        },
      };
    }
    try {
      if (resolvedTool.permission === 'approval') {
        const approved = this.options.approveTool
          ? await this.options.approveTool(resolvedTool, call.input, call.id)
          : false; // 安全默认：未接审批通道时拒绝
        if (!approved) {
          return { ok: false, error: { code: 'APPROVAL_DENIED', message: `工具 ${resolvedTool.name} 需要人工审批，当前未获批准`, retryable: false } };
        }
      }
      const result = await resolvedTool.invoke(call.input, makeToolContext({
        runId: this.options.runId,
        agentId: this.options.agentId,
        signal: this.options.signal,
        workspaceDir: this.options.workspaceDir,
        emit: ev => this.emit(ev.type, { tool: call.name, ...ev.payload }),
      }));
      // 结果预览进事件（M1-8 工具卡片「结果可展开」）
      if (result.ok) {
        this.emit('tool.result_preview', {
          tool: resolvedTool.name,
          callId: call.id,
          preview: preview(result.data),
        });
      }
      if (correctedFrom) {
        // 让模型看到纠正（下一轮直接用正确名）
        const data = (result.ok && result.data && typeof result.data === 'object')
          ? { ...(result.data as any), _tool_name_corrected: `"${correctedFrom}" 已自动纠正为 "${resolvedTool.name}"，后续请直接使用 ${resolvedTool.name}` }
          : result.data;
        return { ...result, data };
      }
      return result;
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
      maxTokens: 8192,
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
    // agentId 注入：主循环 'main'，sub-agent 各自 id（M1-4 — 事件流区分来源）
    const enriched = { agentId: this.options.agentId, ...payload };
    try {
      this.options.onEvent({ type, payload: enriched });
    } catch { /* 事件消费者异常不中断循环 */ }
  }
}

function preview(input: unknown): string {
  const s = JSON.stringify(input ?? {});
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}
