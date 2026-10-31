/** SDK 冒烟：headless runAgent —— 注入桩 chat + 自定义工具，跑完整内核循环（不触 SQLite） */
import { runAgent, toolOk } from '../dist/index.js';

const chat = async req => {
  const hasToolCall = req.messages.filter(m => m.role === 'tool').length === 0;
  if (hasToolCall) {
    return {
      content: '',
      toolCalls: [{ id: 'c1', name: 'echo', input: { x: 1 } }],
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'tool_use',
    };
  }
  return { content: 'final answer: done', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end' };
};

const events = [];
const result = await runAgent({
  goal: 'call the echo tool then answer',
  chat,
  tools: [{
    name: 'echo',
    description: 'echo input',
    inputSchema: { type: 'object' },
    source: 'builtin',
    permission: 'auto',
    invoke: async (input, ctx) => toolOk({ echoed: input }, `echo 摘要: ${JSON.stringify(input)}`),
  }],
  onEvent: e => events.push(e.type),
});

console.log('status:', result.status);
console.log('final:', result.finalContent);
console.log('toolCalls:', result.toolCalls);
console.log('events sample:', [...new Set(events)].slice(0, 8));
if (result.status !== 'completed' || result.finalContent !== 'final answer: done' || result.toolCalls !== 1) {
  console.error('SMOKE FAILED'); process.exit(1);
}
console.log('SMOKE OK — headless loop ran with gates, no SQLite touched');
