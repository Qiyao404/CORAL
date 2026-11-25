/**
 * 打开对话页时自动选中哪个会话。
 *
 * 评测 / 基准题共用一个会话，"最近的会话"经常就是它。被自动选中后，用户接着输入的新任务会按"续接"发起，
 * 把最近一道评测题的完整过程（工具结果、推理）带进新任务——又贵，又容易被带偏。
 * 所以自动选中跳过自动化会话；全是自动化会话时一个都不选，停在"新建任务"。
 *
 * 哪些算自动化会话只认服务端给的标记（运行列表的 automation_session），这里不看会话名字——规则只有一处。
 */
export function pickAutoSession<T extends { automation?: boolean }>(sessions: T[]): T | null {
  return sessions.find(s => !s.automation) ?? null;
}

/**
 * 在输入框里发新消息时落在哪个会话。
 *
 * 人手动点开一个评测会话再输入：按"续接"发起的话，新任务会接在最近一道评测题的完整过程后面；
 * 而且评测会话在系统里按自动化会话对待 — 任务不写长期记忆、不做经验蒸馏，一个正常需求就这么悄悄按评测规则跑了。
 * 所以在自动化会话里发送一律新开一个会话（想追问某道评测题，可以靠"经历回溯"在新会话里查历史）。
 */
export function sessionForNewMessage(
  current: string | null,
  sessions: Array<{ sessionId: string | null; automation?: boolean }>,
  newSessionId: () => string,
): string {
  if (!current) return newSessionId();
  if (sessions.find(s => s.sessionId === current)?.automation) return newSessionId();
  return current;
}

/** 当前是否停在一个自动化会话里（输入框据此提示"这里发送会新开一个会话"） */
export function isAutomationSession(
  current: string | null,
  sessions: Array<{ sessionId: string | null; automation?: boolean }>,
): boolean {
  return Boolean(current && sessions.find(s => s.sessionId === current)?.automation);
}
