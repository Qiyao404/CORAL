import type { ChatMessage } from '../providers/types.js';

/**
 * 轨迹导出（训练数据口径）：run 的"模型可见即已记录"数据源结构化为 JSONL。
 *
 * 首行是元信息（format=coral-trajectory/1，含模型配置与系统提示——精确重放
 * 的同源数据），其后每行一条消息（role / content / toolCalls / toolName）。
 * 可直接用于工具调用模型的轨迹生成与压缩实验。
 */

export interface TrajectoryMeta {
  format: 'coral-trajectory/1';
  runId: string;
  goal: string;
  status: string;
  model?: { model: string; provider?: string; baseUrl?: string; profileId?: string };
  system?: string;
  messageCount: number;
  exportedAt: string;
}

export function buildTrajectoryLines(input: {
  runId: string;
  goal: string;
  status: string;
  messages?: ChatMessage[];
  system?: string;
  model?: { model: string; provider?: string; baseUrl?: string; profileId?: string };
}): string[] {
  const messages = input.messages ?? [];
  const meta: TrajectoryMeta = {
    format: 'coral-trajectory/1',
    runId: input.runId,
    goal: input.goal,
    status: input.status,
    ...(input.model ? { model: input.model } : {}),
    ...(input.system ? { system: input.system } : {}),
    messageCount: messages.length,
    exportedAt: new Date().toISOString(),
  };
  const lines: string[] = [JSON.stringify(meta)];
  for (const m of messages) {
    if (!m || typeof m.content !== 'string') continue;
    lines.push(JSON.stringify({
      role: m.role,
      content: m.content,
      ...((m as any).toolName ? { toolName: (m as any).toolName } : {}),
      ...(Array.isArray((m as any).toolCalls) && (m as any).toolCalls.length > 0 ? { toolCalls: (m as any).toolCalls } : {}),
    }));
  }
  return lines;
}
