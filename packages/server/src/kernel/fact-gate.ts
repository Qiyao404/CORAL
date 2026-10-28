import { existsSync } from 'fs';
import { join } from 'path';
import type { ChatMessage } from '../providers/types.js';
import type { Tool } from '../tools/types.js';

/**
 * 事实门（三段式强制调查）：对"改动已存在内容"的写调用做确定性拦截 —
 * 没读过就改 = 盲改，直接 DENY 并给出调查指令；读过（事实已呈现在上下文中）
 * 后放行重试。
 *
 * 范围（刻意收窄 — 新建文件不设门）：
 *  · fs_edit 恒设门（编辑的前提是知道原文）
 *  · fs_write / docx_write 在目标文件【已存在】时设门（覆盖 = 隐式编辑）
 *  · 新建文件放行 — 写门槛由权限档（ask 审批 / auto 直写）把关，
 *    事实门只管"改你没读过的东西"这个正确性不变量
 *
 * 与审批中心的关系：事实门是确定性前置闸（免费、即时、可复核），人工审批仍在
 * 其后照常进行。fork/续接场景：种子的 initialHistory 同样计入。
 *
 * 防死锁（第三道保险）：同一工具+路径连续被拦 3 次后放行并发出告警事件 —
 * 门是防盲改的，不是防改的。
 */

const READ_TOOLS = new Set(['fs_read', 'docx_read']);
const MAX_DENIALS = 3;

export interface FactGateDecision {
  pass: boolean;
  /** DENY 时给模型的确切调查指令 */
  instruction?: string;
  /** 被拦原因（事件/UI 用） */
  reason?: string;
}

interface ToolMessage extends ChatMessage {
  toolName?: string;
}

export class FactGate {
  /** key = tool:normalizedPath，值为被拦次数 */
  private denials = new Map<string, number>();

  /**
   * 检查一次写类调用。
   * @param messages 当前完整消息历史（含种子）— 事实来源
   * @param workspaceDir 工作区根（判断目标文件是否已存在）
   */
  check(tool: Tool, input: any, messages: ChatMessage[], workspaceDir?: string): FactGateDecision {
    if (!tool.effects?.writesFilesystem) return { pass: true };

    const path = normalizePath(input?.path);
    const key = `${tool.name}:${path}`;
    const toolMsgs = messages.filter(m => m.role === 'tool') as ToolMessage[];

    // 门的有效范围：编辑类恒拦；覆盖类仅当目标已存在
    const targetExists = Boolean(
      workspaceDir && path && existsSync(join(workspaceDir, path))
    );
    if (tool.name !== 'fs_edit' && !targetExists) {
      return { pass: true }; // 新建文件 — 权限档把关，不设事实门
    }

    const hasRead = toolMsgs.some(
      m => READ_TOOLS.has(m.toolName ?? '') && m.content.includes(`"${path}"`) && !m.content.includes('"error"')
    );
    if (!hasRead) {
      const reader = path.toLowerCase().endsWith('.docx') ? 'docx_read' : 'fs_read';
      return this.deny(key, tool.name, path,
        `目标文件${targetExists ? '已存在（本次是覆盖/编辑）' : '将被编辑'}，但本任务尚未读取过它。` +
        `先调用 ${reader} 读取 "${path}" 确认现状（你在改什么、周围是什么），然后重试本操作。盲改会被运行时直接拒绝。`
      );
    }
    return { pass: true };
  }

  private deny(key: string, toolName: string, path: string, instruction: string): FactGateDecision {
    const count = (this.denials.get(key) ?? 0) + 1;
    this.denials.set(key, count);
    // 防死锁：第 3 次放行（带告警事件由调用方发出）
    if (count >= MAX_DENIALS) {
      return { pass: true, reason: `bypassed_after_${count}_denials` };
    }
    return { pass: false, reason: `facts_required(${path})`, instruction: `[runtime fact-gate] ${instruction}` };
  }
}

function normalizePath(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/');
}

/**
 * 事实门拒绝 → 工具结果错误体（retryable=true：模型补做调查后重试是预期路径）
 */
export function factsRequiredError(instruction: string) {
  return {
    code: 'FACTS_REQUIRED',
    message: instruction,
    retryable: true,
  };
}
