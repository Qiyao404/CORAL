import { describe, it, expect } from 'vitest';
import { deriveRunView } from '../useRunStream';
import type { RunEventItem } from '../useRunStream';

/**
 * 事件归并（deriveRunView）：错题集 REG-12 提到的"web 端纯函数测试"此前实际并不存在，
 * 这里补上 —— 覆盖乱序 / 重复输入下的终态判定，以及终态相关的派生字段
 *（失败原因 / 原地打转 / 终态后不再有挂起的审批）。
 */

const ev = (seq: number, type: string, payload: Record<string, any> = {}): RunEventItem => ({
  eventId: `e${seq}-${type}`, runId: 'r1', seq, type, payload, timestamp: new Date().toISOString(),
});

describe('deriveRunView · 终态与派生字段', () => {
  it('没有任何终态事件：任务仍在进行（runStatus 为 null）', () => {
    const v = deriveRunView([ev(1, 'run.started'), ev(2, 'loop.step_started'), ev(3, 'loop.delta', { delta: '你好' })]);
    expect(v.runStatus).toBeNull();
    expect(v.finalContent).toBeNull();
  });

  it('乱序 + 重复输入：以事件数组里的终态事件为准，重复事件不产生重复工具卡', () => {
    const done = ev(5, 'run.completed', { finalContentPreview: '完成' });
    const v = deriveRunView([ev(4, 'todo.updated', { todos: [] }), done, ev(2, 'tool.call_started', { callId: 'c1', tool: 'fs_read' }), done, ev(3, 'tool.call_completed', { callId: 'c1' })]);
    expect(v.runStatus).toBe('completed');
    expect(v.finalContent).toBe('完成');
    // 重复的 call_started（同 callId）只保留一张"进行中"的卡，后续 completed 把它落定
    expect(v.toolCards.filter(c => c.callId === 'c1' && c.status === 'running')).toHaveLength(0);
    expect(v.toolCards.filter(c => c.callId === 'c1' && c.status === 'ok')).toHaveLength(1);
  });

  it('完成 + 预算耗尽事件 → endReason = budget_exceeded', () => {
    const v = deriveRunView([ev(1, 'run.budget_exceeded'), ev(2, 'run.completed', { finalContentPreview: '部分成果' })]);
    expect(v.endReason).toBe('budget_exceeded');
  });

  it('失败原因要带到界面（run.failed 的 error，字符串或对象两种形态）', () => {
    expect(deriveRunView([ev(1, 'run.failed', { error: '模型报错' })]).runError).toBe('模型报错');
    expect(deriveRunView([ev(1, 'run.failed', { error: { message: '服务停止或重启，任务被中断' }, interrupted: true })]).runError).toBe('服务停止或重启，任务被中断');
  });

  it('原地打转被运行时终止：状态失败、endReason = stalled（界面据此给"继续"入口）', () => {
    const v = deriveRunView([ev(1, 'run.stalled', { tool: 'http_fetch', count: 15 }), ev(2, 'run.failed', { error: '检测到原地打转' })]);
    expect(v.runStatus).toBe('failed');
    expect(v.endReason).toBe('stalled');
  });

  it('任务终态后不再有"挂着"的审批（残留的 approval_required 不再等人点）', () => {
    const v = deriveRunView([
      ev(1, 'tool.approval_required', { approvalId: 'a1', tool: 'fs_write', input: {} }),
      ev(2, 'run.failed', { error: '服务停止或重启，任务被中断' }),
    ]);
    expect(v.pendingApprovals).toEqual([]);
  });

  it('任务进行中：挂起的审批照常保留', () => {
    const v = deriveRunView([ev(1, 'tool.approval_required', { approvalId: 'a1', tool: 'fs_write', input: {} })]);
    expect(v.pendingApprovals.map(a => a.approvalId)).toEqual(['a1']);
  });

  it('取消：状态为 cancelled', () => {
    expect(deriveRunView([ev(1, 'run.cancelled')]).runStatus).toBe('cancelled');
  });
});
