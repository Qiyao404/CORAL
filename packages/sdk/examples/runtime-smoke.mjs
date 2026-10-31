/** SDK 冒烟：createRuntime —— 技能注册表加载 + 三表持久化接线（read-only 验证，不发 run） */
import { createRuntime, toEngineLlm } from '../dist/index.js';

const stubChat = async () => ({ content: 'stub', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' });
const rt = await createRuntime({ llm: toEngineLlm(stubChat) });

const page = rt.engine.store.list({ limit: 3 });
console.log('store.list ok:', typeof page.total === 'number', 'items:', page.items.length);
await rt.dispose();
console.log('SMOKE OK — runtime wired, stores opened and closed cleanly');
