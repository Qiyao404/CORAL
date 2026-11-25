import { describe, it, expect } from 'vitest';
import {
  appendReasoning, classifyRunError, deriveRunView, deriveThinking, eventTime,
  FETCH_FAILURE_WARN_AT, REASONING_CAP, TRANSIENT_EVENT_TYPES,
  type RunEventItem,
} from '../useRunStream';
import { EVICTABLE } from '../run-event-window';

/**
 * 等待可见与结果可信（2026-11-24 性能体检落地）的纯逻辑：
 *  · 思考计时：主循环最后一次"模型调用起点"之后没有新的主循环事件 → 模型在思考
 *  · 思考过程累积：只收主循环、按步重置、有上限
 *  · 抓取失败计数与提醒门槛、网络不可用收尾的识别
 *  · 失败原因归类（用量上限 / 密钥 / 中断 / 超时 / 网络）
 */

let seq = 0;
const ev = (type: string, payload: Record<string, any> = {}, over: Partial<RunEventItem> = {}): RunEventItem => ({
  eventId: `e${++seq}`,
  runId: 'r1',
  seq,
  type,
  payload,
  timestamp: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('思考计时 · deriveThinking', () => {
  it('最后一条主循环事件是模型调用的起点 → 在思考，起点取该事件', () => {
    const events = [ev('run.started'), ev('loop.step_started', { step: 1 }, { timestamp: '2026-01-01T00:00:10.000Z', receivedAt: Date.parse('2026-01-01T00:00:10.400Z') })];
    expect(deriveThinking(events, null)).toEqual({ since: Date.parse('2026-01-01T00:00:10.000Z'), step: 1 });
  });

  it('之后出现了别的主循环事件（开始调工具 / 开始输出文字）→ 不再算思考', () => {
    expect(deriveThinking([ev('run.started'), ev('loop.step_started', { step: 1 }), ev('tool.call_started', { callId: 'c1', tool: 'http_fetch' })], null)).toBeNull();
    expect(deriveThinking([ev('run.started'), ev('loop.step_started', { step: 1 }), ev('loop.delta', { delta: '答' })], null)).toBeNull();
    expect(deriveThinking([ev('run.started'), ev('loop.step_started', { step: 1 }), ev('tool.approval_required', { approvalId: 'a1', tool: 'fs_write' })], null)).toBeNull();
  });

  it('子代理 / 队友的事件不影响主线程的判断', () => {
    const events = [
      ev('run.started'),
      ev('loop.step_started', { step: 3 }),
      ev('tool.call_started', { callId: 's1', tool: 'agent_spawn' }),
      ev('loop.step_started', { step: 1 }, { agentId: 'sub-1-abcd' }),
      ev('loop.delta', { delta: '子代理的话' }, { agentId: 'sub-1-abcd' }),
      ev('loop.step_started', { step: 1 }, { agentId: 'mate-worker-x1' }),
    ];
    expect(deriveThinking(events, null)).toBeNull();
  });

  it('工具跑完、下一步刚开始 → 又进入思考；强制收尾的调用也算思考', () => {
    const thinking = deriveThinking([
      ev('run.started'), ev('loop.step_started', { step: 1 }), ev('tool.call_started', { callId: 'c1', tool: 'http_fetch' }),
      ev('tool.call_completed', { callId: 'c1' }), ev('loop.step_completed', { step: 1 }), ev('loop.step_started', { step: 2 }),
    ], null);
    expect(thinking).toMatchObject({ step: 2 });
    expect(deriveThinking([ev('run.started'), ev('loop.budget_exceeded', { reason: 'maxSteps' })], null)).not.toBeNull();
    expect(deriveThinking([ev('run.started'), ev('loop.stalled', { tool: 'http_fetch', count: 15 })], null)).not.toBeNull();
  });

  it('任务已终态 → 不思考；刚创建还没开始 → 不思考', () => {
    expect(deriveThinking([ev('run.started'), ev('loop.step_started', { step: 1 })], 'completed')).toBeNull();
    expect(deriveThinking([ev('run.created')], null)).toBeNull();
    expect(deriveThinking([], null)).toBeNull();
  });

  it('计时起点：实时事件用本地收到时刻，回放的旧事件用服务端时间戳', () => {
    const now = Date.now();
    const replayed = ev('loop.step_started', { step: 7 }, { timestamp: new Date(now - 40_000).toISOString(), receivedAt: now });
    expect(now - eventTime(replayed)).toBe(40_000);
    const live = ev('loop.step_started', { step: 8 }, { timestamp: new Date(now - 200).toISOString(), receivedAt: now });
    expect(now - eventTime(live)).toBe(200);
    // 本机时钟比服务端慢：不让起点落到未来
    const skewed = ev('loop.step_started', { step: 9 }, { timestamp: new Date(now + 60_000).toISOString(), receivedAt: now });
    expect(eventTime(skewed)).toBe(now);
    expect(eventTime({ ...live, timestamp: 'not-a-date' })).toBe(now);
  });
});

describe('思考过程累积 · appendReasoning', () => {
  it('同一步的增量累加；换步从头开始；只收主循环', () => {
    let cur = appendReasoning(null, { runId: 'r1', payload: { step: 1, delta: '先想' } });
    cur = appendReasoning(cur, { runId: 'r1', payload: { step: 1, delta: '一想' } });
    expect(cur).toEqual({ runId: 'r1', step: 1, text: '先想一想' });
    // 子代理的思考不混进来
    expect(appendReasoning(cur, { runId: 'r1', agentId: 'sub-1-abcd', payload: { step: 1, delta: '子代理' } })).toBe(cur);
    cur = appendReasoning(cur, { runId: 'r1', payload: { step: 2, delta: '新的一步' } });
    expect(cur).toEqual({ runId: 'r1', step: 2, text: '新的一步' });
    // 换了任务也从头开始
    expect(appendReasoning(cur, { runId: 'r2', payload: { step: 2, delta: '别的任务' } })).toEqual({ runId: 'r2', step: 2, text: '别的任务' });
  });

  it('有上限：只保留最近的部分', () => {
    let cur = appendReasoning(null, { runId: 'r1', payload: { step: 1, delta: '' } });
    for (let i = 0; i < 30; i++) cur = appendReasoning(cur, { runId: 'r1', payload: { step: 1, delta: 'x'.repeat(1000) } });
    expect(cur!.text.length).toBe(REASONING_CAP);
  });

  it('思考过程事件走旁路、不进事件窗口', () => {
    expect(TRANSIENT_EVENT_TYPES.has('loop.reasoning')).toBe(true);
    expect(TRANSIENT_EVENT_TYPES.has('loop.delta')).toBe(false);
    expect(EVICTABLE.has('loop.delta')).toBe(true);
  });
});

describe('抓取失败与网络不可用收尾 · deriveRunView', () => {
  const failed = (tool: string, error: any, callId = `c${seq}`) => [
    ev('tool.call_started', { callId, tool }),
    ev('tool.call_failed', { callId, tool, error }),
  ];

  it('只数抓取类工具的失败；网络层的单独计', () => {
    const events = [
      ...failed('http_fetch', { code: 'HTTP_FAILED', message: '请求失败: 连接被中断（ECONNRESET）', retryable: true }),
      ...failed('http_fetch', { code: 'HTTP_TIMEOUT', message: '请求超时（30000ms）', retryable: true }),
      ...failed('http_fetch', { code: 'NETWORK_DOWN', message: '网络不可用，本次抓取没有发出请求' }),
      ...failed('skill_web-reader', '脚本返回错误: fetch failed'),
      ...failed('http_fetch', { code: 'TOOL_CRASHED', message: 'unexpected token <' }),
      ...failed('fs_read', { code: 'FILE_NOT_FOUND', message: '文件不存在' }),
      ev('tool.call_completed', { callId: 'ok1', tool: 'http_fetch' }),
    ];
    const v = deriveRunView(events);
    expect(v.fetchFailures).toEqual({ total: 5, network: 4 });
    expect(v.fetchFailures.total).toBeGreaterThanOrEqual(FETCH_FAILURE_WARN_AT);
    expect(FETCH_FAILURE_WARN_AT).toBe(3);
    expect(deriveRunView([ev('tool.call_completed', { callId: 'ok', tool: 'http_fetch' })]).fetchFailures).toEqual({ total: 0, network: 0 });
  });

  it('网络不可用收尾：状态是完成、结束原因是 network_down（界面据此给出提示与"继续"入口）', () => {
    const v = deriveRunView([
      ev('run.started'),
      ev('loop.network_down', { steps: 12, dead: true }),
      ev('run.network_down', { steps: 12, error: '网络不可用：…' }),
      ev('run.completed', { finalContentPreview: '基于已核实内容的回答' }),
    ]);
    expect(v.runStatus).toBe('completed');
    expect(v.endReason).toBe('network_down');
    expect(v.finalContent).toBe('基于已核实内容的回答');
    expect(v.runError).toBeNull();
  });

  it('其余结束原因不受影响', () => {
    expect(deriveRunView([ev('run.completed', {})]).endReason).toBe('final_answer');
    expect(deriveRunView([ev('run.budget_exceeded', {}), ev('run.completed', {})]).endReason).toBe('budget_exceeded');
    expect(deriveRunView([ev('run.stalled', {}), ev('run.failed', { error: '检测到原地打转' })]).endReason).toBe('stalled');
  });
});

describe('失败原因归类 · classifyRunError（样例取自真实失败信息）', () => {
  it('用量上限 / 密钥 / 被中断 / 超时 / 网络', () => {
    expect(classifyRunError('已达到 5 小时的使用上限。您的限额将在 2026-11-22 12:00:00 重置。')).toBe('quota');
    expect(classifyRunError('您的账户已达到速率限制，请您控制请求频率')).toBe('quota');
    expect(classifyRunError('Authentication Fails, Your api key: ****lder is invalid (request_id: x)')).toBe('auth');
    expect(classifyRunError('服务停止或重启，任务被中断')).toBe('interrupted');
    expect(classifyRunError('请求超时（120000ms）: https://x.example.com')).toBe('timeout');
    expect(classifyRunError('fetch failed')).toBe('network');
  });

  it('认不出的不乱归类（原样显示）', () => {
    expect(classifyRunError('模型的工具调用连续被输出长度上限截断，无法继续')).toBeNull();
    expect(classifyRunError('检测到原地打转：工具 http_fetch 的同一调用已重复 15 次，运行时已强制收尾')).toBeNull();
    expect(classifyRunError('')).toBeNull();
    expect(classifyRunError(null)).toBeNull();
  });
});
