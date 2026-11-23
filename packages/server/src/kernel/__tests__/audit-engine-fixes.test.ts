import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ChatRequest, ChatResponse } from '../../providers/types.js';

/**
 * 审计修复（引擎层）：REG-20 / REG-25 / REG-26 / REG-27 / REG-29
 *  · REG-20 评测会话不蒸馏进个人记忆（隔离规则此前只实现于 memory_write 一个入口）
 *  · REG-25 上次进程遗留的在途 run 启动时收尸；后台 teammate 随主循环结束一并终止
 *  · REG-26 无人值守（定时/触发）run 不反问、不注入"请立即澄清"
 *  · REG-29 记忆使用记账只记一次；run 级内部状态在终态清理（先改状态后校验 → 先校验）
 */

const tmp = mkdtempSync(join(tmpdir(), 'coral-audit-engine-'));
process.env.DATABASE_PATH = join(tmp, 'fix.db');
process.env.MEMORY_DIR = join(tmp, 'memory');
process.env.SKILLS_DIR = join(tmp, 'skills');
process.env.RUN_MAX_STEPS = '30';
process.env.RUN_MAX_TOKENS = '1000000';
const MEM_DIR = process.env.MEMORY_DIR!;
mkdirSync(MEM_DIR, { recursive: true });
mkdirSync(process.env.SKILLS_DIR!, { recursive: true });

const { RunEngine } = await import('../run-engine.js');
const { RunStore } = await import('../../store/run-store.js');
const { RunEventStore } = await import('../../store/run-event-store.js');
const { CheckpointStore } = await import('../../store/checkpoint-store.js');
const { FilesystemSkillRegistry } = await import('../../skill-runtime/filesystem-registry.js');
const { SkillExecutor } = await import('../../skill-runtime/skill-executor.js');
const { WorkspaceService } = await import('../../services/workspace-service.js');
const { closeDb } = await import('../../store/index.js');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error('waitUntil 超时');
}
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

type ChatHandler = (req: ChatRequest) => any;
function makeLLM(chat: ChatHandler, complete: () => string = () => 'ok') {
  return {
    chatCalls: [] as ChatRequest[],
    completeCalls: [] as any[],
    async chat(req: ChatRequest): Promise<ChatResponse> {
      this.chatCalls.push(req);
      const r = (await chat(req)) ?? {};
      return {
        content: r.content ?? '',
        toolCalls: r.toolCalls ?? [],
        usage: r.usage ?? { inputTokens: 10, outputTokens: 5 },
        stopReason: r.stopReason ?? (r.toolCalls?.length ? 'tool_use' : 'end'),
      } as ChatResponse;
    },
    async complete(messages: any[], options?: any) {
      this.completeCalls.push({ messages, options });
      return { content: complete() };
    },
    isDemoMode: () => false,
  };
}
function makeEngine(llm: any): InstanceType<typeof RunEngine> {
  return new RunEngine({
    llm,
    skillRegistry: registry,
    skillExecutor: executor,
    runStore: new RunStore(),
    eventStore: new RunEventStore(),
    checkpointStore: new CheckpointStore(),
  });
}
const eventsOf = (engine: InstanceType<typeof RunEngine>, runId: string) => engine.events.listByRun(runId, 0, 2000);

let registry: InstanceType<typeof FilesystemSkillRegistry>;
let executor: InstanceType<typeof SkillExecutor>;
beforeAll(async () => {
  registry = new FilesystemSkillRegistry(process.env.SKILLS_DIR!);
  await registry.reloadAll();
  executor = new SkillExecutor(registry);
});
afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

// ─── REG-20 ───────────────────────────────────────────────────────────────
describe('REG-20 · 评测会话隔离覆盖全部记忆入口', () => {
  const distill = (file: string) => () =>
    JSON.stringify({ long_term: [{ filename: file, content: '# 残留\n- 评测题里的站点小癖好\n' }], session_files: [], session_points: [] });

  it('评测会话（gaia-eval-*）的 run 完成后：不蒸馏、不落盘', async () => {
    const engine = makeEngine(makeLLM(() => ({ content: '答案：42' }), distill('eval-only.md')));
    const { runId } = engine.startRun({ goal: '评测题', sessionId: 'gaia-eval-session' });
    await waitUntil(() => engine.store.get(runId)!.status === 'completed');
    await sleep(400); // 蒸馏在终态落库之后执行 — 留出窗口再断言"没有发生"
    expect(eventsOf(engine, runId).some(e => e.type === 'memory.distilled')).toBe(false);
    expect(existsSync(join(MEM_DIR, 'eval-only.md'))).toBe(false);
  });

  it('普通会话照常蒸馏（隔离不误伤正常路径）', async () => {
    const engine = makeEngine(makeLLM(() => ({ content: '好的' }), distill('normal-note.md')));
    const { runId } = engine.startRun({ goal: '帮我记一下', sessionId: 'sess_normal' });
    await waitUntil(() => eventsOf(engine, runId).some(e => e.type === 'memory.distilled'));
    expect(existsSync(join(MEM_DIR, 'normal-note.md'))).toBe(true);
  });
});

// ─── REG-25 ───────────────────────────────────────────────────────────────
describe('REG-25 · 在途状态必须有人收尸', () => {
  it('启动时：上次进程遗留的 free run（running / waiting_human / created）标记为中断', () => {
    const engine = makeEngine(makeLLM(() => ({ content: 'x' })));
    for (const [id, status] of [['zombie-run', 'running'], ['zombie-wait', 'waiting_human'], ['zombie-created', 'created']] as const) {
      engine.store.insert({ id, goal: '旧任务', mode: 'free', sessionId: 'sess_old' });
      if (status !== 'created') engine.store.update(id, { status });
    }
    engine.store.insert({ id: 'done-run', goal: '已完成', mode: 'free' });
    engine.store.update('done-run', { status: 'completed', endReason: 'final_answer' });
    engine.store.insert({ id: 'graph-run', goal: '图任务', mode: 'graph' });
    engine.store.update('graph-run', { status: 'running' }); // graph 有自己的恢复语义，不归这里管

    expect(engine.reconcileInterruptedRuns('startup')).toBe(3);
    for (const id of ['zombie-run', 'zombie-wait', 'zombie-created']) {
      const r = engine.store.get(id)!;
      expect(r.status).toBe('failed');
      expect(r.end_reason).toBe('interrupted');
      expect(r.error?.message).toBeTruthy();
      // 终态事件沿用 run.failed（前端现有失败态处理直接复用）+ interrupted 标记区分"被中断"与"模型失败"
      const terminal = eventsOf(engine, id).filter(e => ['run.failed', 'run.completed', 'run.cancelled'].includes(e.type));
      expect(terminal).toHaveLength(1);
      expect((terminal[0].payload as any).interrupted).toBe(true);
    }
    expect(engine.store.get('done-run')!.status).toBe('completed');
    expect(engine.store.get('graph-run')!.status).toBe('running');
  });

  it('收尸时把"挂着的问题与审批"在事件流里一并落定（否则界面上任务已失败、问题卡却还在等人作答）', () => {
    const engine = makeEngine(makeLLM(() => ({ content: 'x' })));
    // 模拟：上次进程里模型发了一个反问 + 一个审批请求，然后进程退出（没有后续事件）
    engine.store.insert({ id: 'zombie-ask', goal: '列几首歌', mode: 'free', sessionId: 'sess_zombie' });
    engine.store.update('zombie-ask', { status: 'waiting_human' });
    (engine as any).emitRunEvent('zombie-ask', 'question.asked', { questionId: 'q_zombie', question: '要几首？', options: [{ label: '5 首' }, { label: '10 首' }], allowMultiple: false });
    (engine as any).emitRunEvent('zombie-ask', 'tool.approval_required', { approvalId: 'apr_zombie', tool: 'fs_write', input: { path: 'a.txt' } });
    // 对照：已经落定过的不重复发
    (engine as any).emitRunEvent('zombie-ask', 'question.answered', { questionId: 'q_old', source: 'choice', answer: 'x' });

    expect(engine.reconcileInterruptedRuns()).toBe(1);
    const evs = eventsOf(engine, 'zombie-ask');
    const types = evs.map(e => e.type);
    // 问题 → 以 cancelled 落定；审批 → 以"未批准"落定；终态事件仍是最后一条
    const closedQ = evs.filter(e => e.type === 'question.answered' && (e.payload as any).questionId === 'q_zombie');
    expect(closedQ).toHaveLength(1);
    expect((closedQ[0].payload as any).source).toBe('cancelled');
    const closedA = evs.filter(e => e.type === 'tool.approval_resolved' && (e.payload as any).approvalId === 'apr_zombie');
    expect(closedA).toHaveLength(1);
    expect((closedA[0].payload as any).approved).toBe(false);
    expect((closedA[0].payload as any).interrupted).toBe(true);
    expect(types[types.length - 1]).toBe('run.failed');
    expect(types.indexOf('run.failed')).toBeGreaterThan(types.lastIndexOf('tool.approval_resolved'));
  });

  it('收尸后不能再往僵尸 run 里塞"立即补充"（否则消息静默丢失）', () => {
    const engine = makeEngine(makeLLM(() => ({ content: 'x' })));
    engine.store.insert({ id: 'zombie-inject', goal: '旧任务', mode: 'free' });
    engine.store.update('zombie-inject', { status: 'running' });
    engine.reconcileInterruptedRuns('startup');
    expect(engine.injectUserInput('zombie-inject', '顺便也查一下').ok).toBe(false);
  });

  it('主循环先结束（没收割）→ 后台 teammate 一并终止，不成为僵尸', async () => {
    let mainCalls = 0;
    const llm = makeLLM(req => {
      if (String(req.system ?? '').includes('You are teammate')) {
        // teammate 一直在干活，直到被终止
        return new Promise((_, reject) => {
          req.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      }
      mainCalls++;
      return mainCalls === 1
        ? { toolCalls: [{ id: 'c1', name: 'team_spawn', input: { name: 'scout', goal: '调研并汇报' } }] }
        : { content: '主任务完成' };
    });
    const engine = makeEngine(llm);
    const { runId } = engine.startRun({ goal: '派一个人去调研，但我不等它' });
    await waitUntil(() => engine.store.get(runId)!.status === 'completed');
    await waitUntil(() => eventsOf(engine, runId).some(e => e.type === 'team.teammate_failed'));
    const failed = eventsOf(engine, runId).find(e => e.type === 'team.teammate_failed')!;
    expect((failed.payload as any).status).toBe('cancelled');
  });
});

// ─── REG-26 ───────────────────────────────────────────────────────────────
describe('REG-26 · 无人值守 run 不反问', () => {
  const criteriaJson = JSON.stringify({ lines: ['工作区存在今日价格记录文件'], ambiguities: ['日志文件名未指定', '价格保留几位小数未说明'] });
  const passJson = JSON.stringify({ results: [{ line: '工作区存在今日价格记录文件', pass: true, evidence: 'x' }] });
  // 模型照平台要求"先反问再干活"
  const askingLLM = () => makeLLM(req => {
    const first = String((req.messages as any)[0]?.content ?? '');
    if (first.startsWith('Convert this task into an acceptance checklist')) return { content: criteriaJson };
    if (first.startsWith('You are a skeptical acceptance checker')) return { content: passJson };
    const toolMsgs = (req.messages as any[]).filter(m => m.role === 'tool').length;
    return toolMsgs === 0
      ? { toolCalls: [{ id: 'q1', name: 'ask_user', input: { question: '日志文件名用哪个？', options: [{ label: 'price-log.md' }, { label: 'prices.md' }] } }] }
      : { content: '已记录今日价格。' };
  });
  function workspace(name: string) {
    const dir = join(tmp, `ws-${name}`);
    mkdirSync(dir, { recursive: true });
    return new WorkspaceService().create({ name, dir, permission: 'auto' });
  }

  it('定时/触发形态（unattended）：ask_user 直接返回"用户不可用"，任务自己跑完', async () => {
    const ws = workspace('cron');
    const engine = makeEngine(askingLLM());
    const { runId } = engine.startRun({ goal: '把今天的商品价格追加记录到价格日志里', workspaceId: ws.id, sessionId: 'sess_a1b2c3d4e5', unattended: true } as any);
    await waitUntil(() => TERMINAL.has(engine.store.get(runId)!.status));
    const evs = eventsOf(engine, runId);
    expect(engine.store.get(runId)!.status).toBe('completed');
    expect(evs.some(e => e.type === 'question.asked')).toBe(false);
    // 开工歧义提示不再变成"立即澄清"的死命令
    const injected = evs.find(e => e.type === 'run.user_input_injected');
    expect(injected && String((injected.payload as any).chars) ? '有注入' : '无注入').toBe('无注入');
  });

  it('交互 run：该问的仍然问（行为不变）— 且无效作答不吞掉问题', async () => {
    const ws = workspace('ask');
    const engine = makeEngine(askingLLM());
    const { runId } = engine.startRun({ goal: '把今天的商品价格追加记录到价格日志里', workspaceId: ws.id, sessionId: 'sess_interactive' });
    await waitUntil(() => engine.store.get(runId)!.status === 'waiting_human');
    const pending = engine.listPendingQuestions(runId);
    expect(pending).toHaveLength(1);
    const qid = pending[0].questionId;

    // REG-29：下标越界 / 空作答 → 报错且问题仍在（此前先删后验，问题被吞）
    expect(engine.answerQuestion(runId, qid, { choice: [99] }).ok).toBe(false);
    expect(engine.listPendingQuestions(runId)).toHaveLength(1);
    expect(engine.answerQuestion(runId, qid, {}).ok).toBe(false);
    expect(engine.listPendingQuestions(runId)).toHaveLength(1);

    expect(engine.answerQuestion(runId, qid, { choice: [0] }).ok).toBe(true);
    expect(engine.listPendingQuestions(runId)).toHaveLength(0);
    await waitUntil(() => TERMINAL.has(engine.store.get(runId)!.status));
    expect(engine.store.get(runId)!.status).toBe('completed');
    const answered = eventsOf(engine, runId).filter(e => e.type === 'question.answered');
    expect(answered).toHaveLength(1);
    expect((answered[0].payload as any).answer).toBe('price-log.md');
  });

  it('无人值守 + 需审批的工作区：审批不会被永久挂起 — 按"未获批准"落定并留痕，任务照常结束', async () => {
    const dir = join(tmp, 'ws-cron-ask');
    mkdirSync(dir, { recursive: true });
    const ws = new WorkspaceService().create({ name: 'cron-ask', dir, permission: 'ask' });
    const criteriaJson = JSON.stringify({ lines: ['工作区存在 a.txt'], ambiguities: [] });
    const passJson = JSON.stringify({ results: [{ line: '工作区存在 a.txt', pass: true, evidence: 'x' }] });
    let n = 0;
    const engine = makeEngine(makeLLM(req => {
      const first = String((req.messages as any)[0]?.content ?? '');
      if (first.startsWith('Convert this task into an acceptance checklist')) return { content: criteriaJson };
      if (first.startsWith('You are a skeptical acceptance checker')) return { content: passJson };
      return n++ === 0
        ? { toolCalls: [{ id: 'w1', name: 'fs_write', input: { path: 'a.txt', content: 'hi' } }] }
        : { content: '完成' };
    }));
    const { runId } = engine.startRun({ goal: '在工作区写入 a.txt', workspaceId: ws.id, unattended: true });
    await waitUntil(() => TERMINAL.has(engine.store.get(runId)!.status)); // 修复前：永远停在 waiting_human → 超时
    expect(engine.store.get(runId)!.status).toBe('completed');
    expect(existsSync(join(dir, 'a.txt'))).toBe(false); // 审批没有被绕过：文件没写
    const resolved = eventsOf(engine, runId).find(e => e.type === 'tool.approval_resolved')!;
    expect((resolved.payload as any).approved).toBe(false);
    expect((resolved.payload as any).unattended).toBe(true);
  });
});

// ─── REG-29 ───────────────────────────────────────────────────────────────
describe('REG-29 · 记账一次 + 终态清理', () => {
  it('同一个 run 里读过一次记忆 → useCount 只 +1', async () => {
    writeFileSync(join(MEM_DIR, 'prefs.md'), '# 偏好\n- 中文回复\n', 'utf-8');
    let n = 0;
    const engine = makeEngine(makeLLM(() => (n++ === 0
      ? { toolCalls: [{ id: 'c1', name: 'memory_read', input: { name: 'prefs.md' } }] }
      : { content: '好' })));
    const { runId } = engine.startRun({ goal: '读一下偏好' });
    await waitUntil(() => engine.store.get(runId)!.status === 'completed');
    await sleep(300);
    const usage = JSON.parse(readFileSync(join(MEM_DIR, '.usage.json'), 'utf-8'));
    expect(usage['prefs.md'].useCount).toBe(1);
  });

  it('run 终态后，run 级内部状态（清单/判决/已问数）全部释放', async () => {
    const dir = join(tmp, 'ws-leak');
    mkdirSync(dir, { recursive: true });
    const ws = new WorkspaceService().create({ name: 'leak', dir, permission: 'auto' });
    const criteriaJson = JSON.stringify({ lines: ['工作区存在 a.txt'], ambiguities: [] });
    const passJson = JSON.stringify({ results: [{ line: '工作区存在 a.txt', pass: true, evidence: 'x' }] });
    let n = 0;
    const engine = makeEngine(makeLLM(req => {
      const first = String((req.messages as any)[0]?.content ?? '');
      if (first.startsWith('Convert this task into an acceptance checklist')) return { content: criteriaJson };
      if (first.startsWith('You are a skeptical acceptance checker')) return { content: passJson };
      return n++ === 0
        ? { toolCalls: [{ id: 'q1', name: 'ask_user', input: { question: '口径？', options: [{ label: 'A' }, { label: 'B' }] } }] }
        : { content: '完成' };
    }));
    const { runId } = engine.startRun({ goal: '在工作区生成 a.txt', workspaceId: ws.id });
    await waitUntil(() => engine.store.get(runId)!.status === 'waiting_human');
    engine.answerQuestion(runId, engine.listPendingQuestions(runId)[0].questionId, { choice: [0] });
    await waitUntil(() => engine.store.get(runId)!.status === 'completed');
    await sleep(200);
    const e = engine as any;
    expect(e.criteriaByRun.size).toBe(0);
    expect(e.verdictByRun.size).toBe(0);
    expect(e.questionsAskedByRun.size).toBe(0);
    expect(e.userInboxByRun.size).toBe(0);
  });
});

describe('REG-25 · run 总账包含 teammate 与同步子代理的消耗', () => {
  it('主循环 2 次调用 + teammate 1 次调用 → run 的 token 数是三者之和', async () => {
    let mainCalls = 0;
    const llm = makeLLM(req => {
      if (String(req.system ?? '').includes('You are teammate')) {
        return { content: '调研完成', usage: { inputTokens: 1000, outputTokens: 500 } };
      }
      mainCalls++;
      return mainCalls === 1
        ? { toolCalls: [{ id: 'c1', name: 'team_spawn', input: { name: 'scout', goal: '调研' } }] }
        : { content: '主任务完成' };
    });
    const engine = makeEngine(llm);
    const { runId } = engine.startRun({ goal: '派一个人去调研，我不等它' });
    await waitUntil(() => engine.store.get(runId)!.status === 'completed');
    const r = engine.store.get(runId) as any;
    // 主循环：2 × (10 + 5)；teammate：1000 + 500 —— 此前库里只记主循环的 20 / 10
    expect(r.tokens_in).toBe(20 + 1000);
    expect(r.tokens_out).toBe(10 + 500);
  });
});
