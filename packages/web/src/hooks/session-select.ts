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
