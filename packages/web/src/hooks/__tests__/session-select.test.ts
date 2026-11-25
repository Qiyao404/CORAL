import { describe, it, expect } from 'vitest';
import { pickAutoSession, sessionForNewMessage, isAutomationSession } from '../session-select';

/**
 * 打开对话页时自动选中哪个会话。
 * 背景：评测 / 基准题共用一个会话，最近的会话经常就是它。被自动选中后，用户接着输入的新任务会按"续接"发起，
 * 把最近一道评测题的完整过程（工具结果、推理）带进新任务——又贵，又容易被带偏。
 */
describe('pickAutoSession · 自动选中哪个会话', () => {
  const s = (sessionId: string, automation = false) => ({ sessionId, automation });

  it('最近的会话是普通会话 → 选它（多轮对话的续接体验不变）', () => {
    expect(pickAutoSession([s('sess_a'), s('gaia-eval-session', true)])).toEqual(s('sess_a'));
  });

  it('最近的会话是评测会话 → 跳过它，选最近的普通会话', () => {
    expect(pickAutoSession([s('gaia-eval-session', true), s('sess_old'), s('sess_older')])).toEqual(s('sess_old'));
  });

  it('只有自动化会话 → 不选任何会话（停在"新建任务"，输入框里发出去的新任务会开一个新会话）', () => {
    expect(pickAutoSession([s('gaia-eval-session', true), s('eval-batch-2', true)])).toBeNull();
  });

  it('没有会话 / 列表为空 → 不选', () => {
    expect(pickAutoSession([])).toBeNull();
  });

  it('只认服务端给的标记，不看会话名字（规则只在服务端一处）', () => {
    // 名字像评测、但服务端没标 → 照常可选（规则改了前端不用跟着改）
    expect(pickAutoSession([s('eval-legacy-name')])).toEqual(s('eval-legacy-name'));
  });
});

/**
 * 在输入框里发新消息时落在哪个会话。
 * 背景：人手动点开一个评测会话再输入，新任务会按"续接"接在最近一道评测题的完整过程后面；
 * 而且评测会话在系统里按自动化会话对待——任务不写长期记忆、不做经验蒸馏。一个正常需求就这么悄悄按评测规则跑了。
 */
describe('sessionForNewMessage · 发送新消息落在哪个会话', () => {
  const s = (sessionId: string, automation = false) => ({ sessionId, automation });
  const fresh = () => 'sess_new';

  it('当前在评测会话里 → 新开一个会话，不续接评测历史', () => {
    const list = [s('gaia-eval-session', true), s('sess_mine')];
    expect(sessionForNewMessage('gaia-eval-session', list, fresh)).toBe('sess_new');
  });

  it('当前在普通会话里 → 续接当前会话（多轮对话的体验不变）', () => {
    expect(sessionForNewMessage('sess_mine', [s('gaia-eval-session', true), s('sess_mine')], fresh)).toBe('sess_mine');
  });

  it('没有选中会话 → 新开一个', () => {
    expect(sessionForNewMessage(null, [s('sess_mine')], fresh)).toBe('sess_new');
  });

  it('当前会话不在最近的列表里（较早的会话）→ 当普通会话续接，不打断', () => {
    expect(sessionForNewMessage('sess_old', [s('gaia-eval-session', true)], fresh)).toBe('sess_old');
  });
});

describe('isAutomationSession · 输入框要不要提示"这里发送会新开会话"', () => {
  const s = (sessionId: string, automation = false) => ({ sessionId, automation });
  it('当前在评测会话里 → 提示', () => {
    expect(isAutomationSession('gaia-eval-session', [s('gaia-eval-session', true), s('sess_mine')])).toBe(true);
  });
  it('普通会话、没有选中、或不在列表里 → 不提示', () => {
    expect(isAutomationSession('sess_mine', [s('gaia-eval-session', true), s('sess_mine')])).toBe(false);
    expect(isAutomationSession(null, [s('gaia-eval-session', true)])).toBe(false);
    expect(isAutomationSession('sess_old', [s('gaia-eval-session', true)])).toBe(false);
  });
});
