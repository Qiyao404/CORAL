import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-approval-'));
process.env.DATABASE_PATH = join(tmp, 'runs.db');
process.env.RUN_MAX_STEPS = '10';

const wsDir = join(tmp, 'project');

const { RunEngine } = await import('../../kernel/run-engine.js');
const { RunStore } = await import('../../store/run-store.js');
const { RunEventStore } = await import('../../store/run-event-store.js');
const { CheckpointStore } = await import('../../store/checkpoint-store.js');
const { WorkspaceService } = await import('../../services/workspace-service.js');
const { FilesystemSkillRegistry } = await import('../../skill-runtime/filesystem-registry.js');
const { SkillExecutor } = await import('../../skill-runtime/skill-executor.js');
const { closeDb } = await import('../../store/index.js');

let engine: RunEngine;
let runStore: RunStore;
let eventStore: RunEventStore;
let wsAsk: string;
let wsReadonly: string;
let wsAuto: string;
let workspaceSvc: import('../../services/workspace-service.js').WorkspaceService;

// 三个权限档各用独立目录（服务禁止同目录重复绑定）
const askDir = join(wsDir, 'ask');
const roDir = join(wsDir, 'readonly');
const autoDir = join(wsDir, 'auto');

beforeAll(async () => {
  for (const d of [wsDir, askDir, roDir, autoDir]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(askDir, 'existing.md'), '# 旧标题\n\n旧内容。\n', 'utf-8');

  const skillsDir = join(tmp, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const skillRegistry = new FilesystemSkillRegistry(skillsDir);
  await skillRegistry.reloadAll();

  runStore = new RunStore();
  eventStore = new RunEventStore();
  workspaceSvc = new WorkspaceService();
  // 幂等创建（按名查，同目录禁止重复绑定是服务的不变量 — 各档独立目录）
  const ensure = (name: string, dir: string, permission: string) => {
    const byName = workspaceSvc.list().items.find(w => w.name === name);
    if (byName) return byName.id;
    return workspaceSvc.create({ name, dir, permission: permission as any }).id;
  };
  wsAsk = ensure('ask 区', askDir, 'ask');
  wsReadonly = ensure('只读区', roDir, 'readonly');
  wsAuto = ensure('auto 区', autoDir, 'auto');

  engine = new RunEngine({
    llm: makeLLMFactory(),
    skillRegistry,
    skillExecutor: new SkillExecutor(skillRegistry),
    runStore,
    eventStore,
    checkpointStore: new CheckpointStore(),
  });
});
afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/** 脚本工厂：每次 newEngine 都拿全新脚本 */
let script: Array<Partial<import('../../providers/types.js').ChatResponse>> = [];
function makeLLMFactory() {
  return {
    calls: 0,
    async chat(): Promise<import('../../providers/types.js').ChatResponse> {
      this.calls++;
      const item = script[this.calls - 1] ?? { content: '默认', stopReason: 'end' };
      return {
        content: item.content ?? '',
        toolCalls: item.toolCalls ?? [],
        usage: item.usage ?? { inputTokens: 10, outputTokens: 5 },
        stopReason: item.stopReason ?? 'end',
      };
    },
    async complete(): Promise<{ content: string }> {
      return { content: '（测试摘要）' };
    },
  } as any;
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitTerminal(runId: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const run = runStore.get(runId);
    if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) return;
    await wait(30);
  }
}
async function waitStatus(runId: string, status: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (runStore.get(runId)?.status === status) return;
    await wait(30);
  }
}

const fsWriteRound = (path: string, content: string) => ({
  stopReason: 'tool_use' as const,
  toolCalls: [{ id: 'c1', name: 'fs_write', input: { path, content } }],
  content: '',
});

describe('M1-10：工作区 + 审批流（run-engine）', () => {
  it('ask 档：fs_write 触发 waiting_human + diff 预览事件 → 批准 → 文件落盘', async () => {
    const ws = workspaceSvc.get(wsAsk)!;
    script = [fsWriteRound('new-report.md', '# 报告\n\n内容'), { stopReason: 'end', content: '已写入报告' }];
    (engine.deps.llm as any).calls = 0;

    const { runId } = engine.startRun({ goal: '写个报告', workspaceId: ws.id });
    await waitStatus(runId, 'waiting_human');

    // 审批事件带 diff
    const reqEvent = eventStore.listByRun(runId).find(e => e.type === 'tool.approval_required');
    expect(reqEvent).toBeTruthy();
    expect(reqEvent!.payload.diff).toContain('+内容');
    expect(reqEvent!.payload.tool).toBe('fs_write');
    expect(runStore.get(runId)!.status).toBe('waiting_human');
    expect(engine.listPendingApprovals(runId)).toHaveLength(1);

    // 批准
    expect(engine.resolveApproval(runId, reqEvent!.payload.approvalId, true)).toBe(true);
    await waitTerminal(runId);

    expect(readFileSync(join(askDir, 'new-report.md'), 'utf-8')).toContain('# 报告');
    const run = runStore.get(runId)!;
    expect(run.status).toBe('completed');
    const types = eventStore.listByRun(runId).map(e => e.type);
    expect(types).toContain('tool.approval_resolved');
    expect(types.filter(t => t === 'tool.approval_resolved')).toHaveLength(1);
  });

  it('ask 档：拒绝 → APPROVAL_DENIED 工具结果（模型可见），文件不落盘', async () => {
    script = [fsWriteRound('rejected.md', '不该写入'), { stopReason: 'end', content: '被拒，改用别的方式' }];
    (engine.deps.llm as any).calls = 0;
    const { runId } = engine.startRun({ goal: '写文件', workspaceId: wsAsk });
    await waitStatus(runId, 'waiting_human');
    const [req] = eventStore.listByRun(runId).filter(e => e.type === 'tool.approval_required').slice(-1);
    engine.resolveApproval(runId, req.payload.approvalId, false);
    await waitTerminal(runId);

    expect(existsSync(join(askDir, 'rejected.md'))).toBe(false);
    const run = runStore.get(runId)!;
    expect(run.status).toBe('completed'); // 模型收到拒绝后自行收尾
  });

  it('readonly 档：fs_write 不在工具集 → TOOL_NOT_FOUND', async () => {
    script = [{
      stopReason: 'tool_use',
      toolCalls: [{ id: 'c', name: 'fs_write', input: { path: 'x.md', content: 'x' } }],
      content: '',
    }, { stopReason: 'end', content: '只读区写不了' }];
    (engine.deps.llm as any).calls = 0;
    const { runId } = engine.startRun({ goal: '尝试写入', workspaceId: wsReadonly });
    await waitTerminal(runId);

    const types = eventStore.listByRun(runId).map(e => e.type);
    expect(types).not.toContain('tool.approval_required'); // 没进审批流
    const run = runStore.get(runId)!;
    expect(run.status).toBe('completed');
  });

  it('auto 档：fs_write 直接执行（无审批事件），文件落盘', async () => {
    script = [fsWriteRound('auto.md', '直接写入'), { stopReason: 'end', content: '完成' }];
    (engine.deps.llm as any).calls = 0;
    const { runId } = engine.startRun({ goal: '快速写入', workspaceId: wsAuto });
    await waitTerminal(runId);

    expect(readFileSync(join(autoDir, 'auto.md'), 'utf-8')).toContain('直接写入');
    expect(eventStore.listByRun(runId).map(e => e.type)).not.toContain('tool.approval_required');
  });

  it('auto 档：docx_write 也直接执行（无审批事件）', async () => {
    script = [{
      stopReason: 'tool_use',
      toolCalls: [{ id: 'dw', name: 'docx_write', input: { path: 'auto-纪要.docx', content: '# 浓缩版\n自动档直写内容' } }],
      content: '',
    }, { stopReason: 'end', content: '完成' }];
    (engine.deps.llm as any).calls = 0;
    const r2 = engine.startRun({ goal: 'auto 生成 word', workspaceId: wsAuto });
    await waitTerminal(r2.runId);

    expect(eventStore.listByRun(r2.runId).map(e => e.type)).not.toContain('tool.approval_required');
    expect(existsSync(join(autoDir, 'auto-纪要.docx'))).toBe(true);
  });

  it('无工作区：fs 工具不在工具集；不存在的 workspaceId 报错', async () => {
    script = [{ stopReason: 'end', content: '无工作区也能干活' }];
    (engine.deps.llm as any).calls = 0;
    const { runId } = engine.startRun({ goal: '纯聊天' });
    await waitTerminal(runId);
    expect(runStore.get(runId)!.status).toBe('completed');

    expect(() => engine.startRun({ goal: 'g', workspaceId: 'ws_ghost' })).toThrow(/不存在/);
  });

  it('取消时挂起的审批被拒绝（loop 不悬挂）', async () => {
    script = [fsWriteRound('never.md', 'x'), { stopReason: 'end', content: 'x' }];
    (engine.deps.llm as any).calls = 0;
    const { runId } = engine.startRun({ goal: '写一半取消', workspaceId: wsAsk });
    await waitStatus(runId, 'waiting_human');
    engine.cancelRun(runId);
    await waitTerminal(runId);
    expect(runStore.get(runId)!.status).toBe('cancelled');
    expect(existsSync(join(askDir, 'never.md'))).toBe(false);
  });
});
