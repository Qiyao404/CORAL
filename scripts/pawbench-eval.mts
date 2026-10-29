/**
 * PawBench × CORAL 评测驱动（scripts/pawbench-eval.mts）
 *
 * 用法：
 *   npx tsx scripts/pawbench-eval.mts --n 25            # 分层抽样 25 个 text 任务
 *   npx tsx scripts/pawbench-eval.mts --ids T016,T033   # 指定任务
 *   npx tsx scripts/pawbench-eval.mts --all             # 全部 text 任务（约 124）
 *
 * 前置：
 *   - CORAL 已启动（127.0.0.1:3001，.env 已配模型）
 *   - PawBench 仓库克隆到本地（--pawbench 指定路径，默认 %TEMP%/pawbench）
 *
 * 机制：
 *   - 每任务：临时工作区（auto 权限，无人值守）→ 注入任务 assets →
 *     POST /api/runs（budget 0/0 = 无上限）→ 轮询终态 → 取 final + 工作区
 *   - 评分（对齐 PawBench grader 语义）：
 *       automated = 任务内嵌 grade(transcript, workspace_path)（python 子进程）
 *       llm_judge = 复刻官方 judge prompt，judge 模型 = CORAL 当前模型
 *                   （官方口径为 官方评审模型 — 报告中如实注明差异）
 *       hybrid    = grading_weights 加权（默认 0.3/0.7）
 *   - 结果写 docs/PAWBENCH.md 与 data/pawbench-results.json（可断点续跑）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const CORAL = 'http://127.0.0.1:3001';

// ── CLI ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argOf = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const N = Number(argOf('--n') ?? 25);
const IDS = argOf('--ids')?.split(',').map(s => s.trim()).filter(Boolean);
const ALL = args.includes('--all');
const PB = resolve(argOf('--pawbench') ?? join(tmpdir(), 'pawbench'));
const TASKS_DIR = join(PB, 'data', 'pawbench-v1.0', 'tasks');
const ASSETS_DIR = join(PB, 'data', 'pawbench-v1.0', 'assets');

// ── 任务解析（对齐 pawbench.task_loader 的约定）────────────────────────────

interface Task {
  file: string;
  taskId: string;
  name: string;
  category: string;
  gradingType: 'automated' | 'llm_judge' | 'hybrid';
  weights: { automated: number; llm_judge: number };
  timeoutSec: number;
  modality: string;
  workspaceFiles: Array<{ source: string; dest: string }>;
  prompt: string;
  expectedBehavior: string;
  automatedChecks: string;
  judgeRubric: string;
  gradingCriteria: string[];
}

function parseTask(file: string): Task | null {
  // CRLF 归一（PawBench 任务文件为 \r\n 行尾 — 不归一则 frontmatter/sections 全灭）
  const raw = readFileSync(file, 'utf-8').replace(/\r\n/g, '\n');
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  const body = raw.slice(fmMatch[0].length);

  // 分段（## Header → sections）
  const sections: Record<string, string> = {};
  let current: string | null = null;
  const lines: string[] = [];
  for (const line of body.split('\n')) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) { if (current) sections[current] = lines.join('\n').trim(); current = h[1]; lines.length = 0; }
    else if (current) lines.push(line);
  }
  if (current) sections[current] = lines.join('\n').trim();

  const pick = (re: RegExp): string => fm.match(re)?.[1]?.trim() ?? '';
  // workspace_files：逐行状态机（YAML 列表项 source 行带 "-"，dest 行缩进无 "-"，
  // 单正则交替会在 dest 行断链 — 实测丢字段）
  const wf: Array<{ source: string; dest: string }> = [];
  {
    let inWf = false;
    let cur: { source?: string; dest?: string } | null = null;
    const flush = () => { if (cur?.source && cur?.dest) wf.push({ source: cur.source, dest: cur.dest }); cur = null; };
    for (const line of fm.split('\n')) {
      if (/^workspace_files:/.test(line)) { inWf = true; continue; }
      if (!inWf) continue;
      if (/^(?!-)\S/.test(line)) { flush(); inWf = false; continue; } // 下一个顶层键（"- source" 列表项不算）
      const s = line.match(/^-\s*source:\s*(\S+)/);
      if (s) { flush(); cur = { source: s[1] }; }
      const d = line.match(/^\s+dest:\s*(\S+)/);
      if (d && cur) cur.dest = d[1];
    }
    flush();
  }
  const weights = {
    automated: Number(fm.match(/automated:\s*([\d.]+)/)?.[1] ?? 0.3),
    llm_judge: Number(fm.match(/llm_judge:\s*([\d.]+)/)?.[1] ?? 0.7),
  };

  return {
    file,
    taskId: basename(file).replace(/\.md$/, ''),
    name: pick(/^name:\s*(.+)$/m),
    category: pick(/^category:\s*(.+)$/m),
    gradingType: pick(/^grading_type:\s*(.+)$/) as Task['gradingType'],
    weights,
    timeoutSec: Number(fm.match(/timeout_seconds:\s*(\d+)/)?.[1] ?? 900),
    // 注意锚定行首+缩进：labels.modality.type 前有空格，且不能误匹配 grading_type
    modality: fm.match(/^\s{2,4}type:\s*(\w+)/m)?.[1] ?? 'text',
    workspaceFiles: wf,
    prompt: sections['Prompt'] ?? '',
    expectedBehavior: sections['Expected Behavior'] ?? '',
    automatedChecks: sections['Automated Checks'] ?? '',
    judgeRubric: sections['LLM Judge Rubric'] ?? '',
    gradingCriteria: (sections['Grading Criteria'] ?? '').split('\n')
      .map(l => l.trim().match(/^-\s+\[[ x]\]\s+(.+)$/)?.[1])
      .filter(Boolean) as string[],
  };
}

function basename(p: string): string { return p.split(/[\\/]/).pop() ?? p; }

// ── 模型配置（judge 用）───────────────────────────────────────────────────
const envFile = readFileSync(join(REPO_ROOT, '.env'), 'utf-8');
const envOf = (k: string) => envFile.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() || process.env[k] || '';
const JUDGE_BASE = envOf('LLM_BASE_URL');
const JUDGE_KEY = envOf('LLM_API_KEY');
const JUDGE_MODEL = envOf('LLM_MODEL') || 'deepseek-chat';

// ── CORAL API ─────────────────────────────────────────────────────────────

async function api(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${CORAL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

async function ensureWorkspace(taskId: string, dir: string): Promise<string> {
  const existing = await api('/api/workspaces');
  const hit = (existing.items ?? []).find((w: any) => w.name === `pawbench-${taskId}`);
  if (hit) return hit.id;
  const created = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: `pawbench-${taskId}`, dir: dir.split('\\').join('/'), permission: 'auto' }) });
  return created.id;
}

async function runTask(t: Task, wsId: string): Promise<{ status: string; final: string; transcript: any[]; runId: string; tokens: number; error?: string }> {
  const { runId } = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ goal: t.prompt, workspaceId: wsId, budget: { maxSteps: 0, maxTokens: 0 } }),
  });
  const started = Date.now();
  while (Date.now() - started < (t.timeoutSec + 120) * 1000) {
    await new Promise(r => setTimeout(r, 4000));
    const d = await api(`/api/runs/${runId}`);
    const run = d.run ?? d;
    // 无人值守：待审批自动批准（评测工作区是一次性的，风险封闭在 ws 内）
    if (run.status === 'waiting_human') {
      const resolved = new Set((d.events ?? []).filter((e: any) => e.type === 'tool.approval_resolved').map((e: any) => e.payload?.approvalId));
      for (const e of (d.events ?? []).filter((x: any) => x.type === 'tool.approval_required')) {
        if (resolved.has(e.payload.approvalId)) continue;
        await api(`/api/runs/${runId}/approvals/${e.payload.approvalId}`, { method: 'POST', body: JSON.stringify({ approved: true, scope: 'session' }) });
      }
      continue;
    }
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      // transcript：goal + 工具摘要 + 终答（judge 判分输入）
      const transcript: any[] = [{ role: 'user', content: t.prompt }];
      for (const e of (d.events ?? [])) {
        if (e.type === 'tool.call_started') transcript.push({ role: 'assistant', content: `调用工具 ${e.payload?.tool}(${String(e.payload?.inputPreview ?? '').slice(0, 150)})` });
        if (e.type === 'tool.result_preview') transcript.push({ role: 'tool', content: String(e.payload?.preview ?? '').slice(0, 300) });
      }
      transcript.push({ role: 'assistant', content: String(run.final_content ?? '') });
      return {
        status: run.status, final: String(run.final_content ?? ''), transcript, runId,
        tokens: (run.tokens_in ?? 0) + (run.tokens_out ?? 0),
        ...(run.error ? { error: JSON.stringify(run.error).slice(0, 200) } : {}),
      };
    }
  }
  await api(`/api/runs/${runId}/cancel`, { method: 'POST' }).catch(() => {});
  return { status: 'timeout', final: '', transcript: [{ role: 'user', content: t.prompt }], runId, tokens: 0, error: '评测超时' };
}

// ── 评分 ───────────────────────────────────────────────────────────────────

function gradeAutomated(t: Task, transcript: any[], wsDir: string): number {
  const m = t.automatedChecks.match(/```python\s*\n([\s\S]*?)\n\s*```/);
  if (!m) return -1; // 无判分代码
  const r = spawnSync('python', [join(HERE, 'pawbench-grade.py')], {
    input: JSON.stringify({ code: m[1], transcript, workspace_path: wsDir }),
    encoding: 'utf-8', timeout: 120_000,
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  if (r.status !== 0 || !r.stdout?.trim()) return 0;
  try { return Number(JSON.parse(r.stdout).score) || 0; } catch { return 0; }
}

async function gradeJudge(t: Task, transcript: any[]): Promise<{ total: number; notes: string }> {
  const rubric = t.judgeRubric || (t.gradingCriteria.length ? t.gradingCriteria.map((c, i) => `### Criterion ${i + 1}: ${c}`).join('\n\n') : 'Task completion quality.');
  const transcriptSummary = transcript.map((m: any) => `[${m.role}] ${String(m.content ?? '').slice(0, 1200)}`).join('\n').slice(0, 24_000);
  const prompt =
    'You are a grading function. Your ONLY job is to output a single JSON object.\n\n' +
    'CRITICAL RULES:\n- Do NOT use any tools\n- Do NOT write any prose or commentary outside the JSON\n- Respond with ONLY a JSON object — nothing else\n\n' +
    'Be a strict evaluator. Reserve 1.0 for genuinely excellent performance.\n\n' +
    `## Task\n${t.prompt}\n\n## Expected Behavior\n${t.expectedBehavior}\n\n` +
    `## Agent Transcript (summarized)\n${transcriptSummary}\n\n## Grading Rubric\n${rubric}\n\n` +
    'Score each criterion from 0.0 to 1.0.\n\n' +
    'Respond with ONLY this JSON (no markdown, no code fences):\n' +
    '{"scores": {"criterion_name": 0.0}, "total": 0.0, "notes": "brief justification"}';
  const res = await fetch(`${JUDGE_BASE.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${JUDGE_KEY}` },
    body: JSON.stringify({ model: JUDGE_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 1000 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status}`);
  const text = (await res.json()).choices?.[0]?.message?.content ?? '';
  const jsonText = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const parsed = JSON.parse(jsonText);
  return { total: Math.max(0, Math.min(1, Number(parsed.total) || 0)), notes: String(parsed.notes ?? '').slice(0, 300) };
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

const allFiles = readdirSync(TASKS_DIR).filter(f => f.endsWith('.md'));
const allTasks = allFiles.map(f => parseTask(join(TASKS_DIR, f))).filter((t): t is Task => t !== null);
// 只跑 text 任务（CORAL 无视觉通道；gui/screenshot 同理排除）
const textTasks = allTasks.filter(t => t.modality === 'text' && !/screenshot|gui/i.test(t.category));

let selected: Task[];
if (IDS) selected = IDS.map(id => allTasks.find(t => t.taskId.startsWith(id))).filter((t): t is Task => !!t);
else if (ALL) selected = textTasks;
else {
  // 分层抽样：按 grading_type 先分层，层内按类别均匀
  const byType = new Map<string, Task[]>();
  for (const t of textTasks) { const k = t.gradingType; byType.set(k, [...(byType.get(k) ?? []), t]); }
  selected = [];
  let more = true;
  while (selected.length < N && more) {
    more = false;
    for (const [k, list] of byType) {
      const used = selected.filter(s => s.gradingType === k).length;
      // 按类型配额（automated 全量优先，其余按比例）
      if (list[used] && (k === 'automated' || selected.length < N)) {
        selected.push(list[used]); more = true;
        if (selected.length >= N) break;
      }
    }
  }
}

console.log(`PawBench × CORAL：选中 ${selected.length} 个 text 任务（全库 ${allTasks.length}，text ${textTasks.length}）`);
console.log(`judge 模型：${JUDGE_MODEL}（官方口径为 官方评审模型 — 结果非官方可比）\n`);

const wsRoot = join(REPO_ROOT, 'data', 'pawbench-ws');
if (!existsSync(wsRoot)) mkdirSync(wsRoot, { recursive: true });
const resultsPath = join(REPO_ROOT, 'data', 'pawbench-results.json');
const prev: Record<string, any> = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf-8')) : {};
let done = 0;

for (const t of selected) {
  done++;
  const tag = `[${String(done).padStart(2)}/${selected.length}] ${t.taskId}`;
  if (prev[t.taskId]?.finalStatus === 'completed') {
    console.log(`${tag} 已有结果（score=${prev[t.taskId].score}）— 跳过`);
    continue;
  }
  // 1. 工作区：清空重建 + 注入 assets
  const wsDir = join(wsRoot, t.taskId);
  rmSync(wsDir, { recursive: true, force: true });
  mkdirSync(wsDir, { recursive: true });
  for (const wf of t.workspaceFiles) {
    // source 字段自带 assets/ 前缀（相对 data/pawbench-v1.0），拼接前剥掉
    const rel = wf.source.replace(/^assets\//, '');
    const src = join(ASSETS_DIR, rel.split('/').join('\\'));
    const dst = join(wsDir, wf.dest.split('/').join('\\'));
    mkdirSync(dirname(dst), { recursive: true });
    if (existsSync(src)) cpSync(src, dst, { recursive: true });
    else console.log(`  ⚠ 资产缺失: ${wf.source}`);
  }
  try {
    const wsId = await ensureWorkspace(t.taskId, wsDir);
    // 2. 运行（无上限预算）
    const r = await runTask(t, wsId);
    // 3. 评分
    let auto = -1, judge: { total: number; notes: string } | null = null, score = 0, gradingUsed = '';
    if (t.gradingType === 'automated') {
      auto = gradeAutomated(t, r.transcript, wsDir);
      score = auto >= 0 ? auto : 0; gradingUsed = 'automated';
    } else {
      try { judge = await gradeJudge(t, r.transcript); } catch (e: any) { judge = { total: 0, notes: `judge 失败: ${e?.message ?? e}` }; }
      gradingUsed = 'llm_judge';
      score = judge.total;
      if (t.gradingType === 'hybrid') {
        auto = gradeAutomated(t, r.transcript, wsDir);
        if (auto >= 0) { score = auto * t.weights.automated + judge.total * t.weights.llm_judge; gradingUsed = `hybrid(${t.weights.automated}/${t.weights.llm_judge})`; }
      }
    }
    prev[t.taskId] = {
      taskId: t.taskId, name: t.name, category: t.category, gradingType: t.gradingType,
      gradingUsed, runStatus: r.status, finalStatus: r.status, score: Number(score.toFixed(3)),
      auto: auto >= 0 ? Number(auto.toFixed(3)) : null,
      judge: judge ? Number(judge.total.toFixed(3)) : null,
      judgeNotes: judge?.notes ?? '', tokens: r.tokens, runId: r.runId,
      error: r.error ?? '',
    };
    writeFileSync(resultsPath, JSON.stringify(prev, null, 2), 'utf-8');
    console.log(`${tag} ${r.status} score=${score.toFixed(2)} (${gradingUsed}${auto >= 0 ? ` auto=${auto.toFixed(2)}` : ''}${judge ? ` judge=${judge.total.toFixed(2)}` : ''}) tokens=${r.tokens}${r.error ? ` ⚠ ${r.error}` : ''}`);
  } catch (e: any) {
    prev[t.taskId] = { taskId: t.taskId, name: t.name, category: t.category, gradingType: t.gradingType, runStatus: 'error', finalStatus: 'error', score: 0, error: String(e?.message ?? e).slice(0, 300) };
    writeFileSync(resultsPath, JSON.stringify(prev, null, 2), 'utf-8');
    console.log(`${tag} ⚠ ERROR ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

// ── 汇总报告 ───────────────────────────────────────────────────────────────
const scored = Object.values(prev).filter((r: any) => selected.some(s => s.taskId === r.taskId));
const valid = scored.filter((r: any) => r.finalStatus !== 'error');
const avg = valid.reduce((n: number, r: any) => n + r.score, 0) / (valid.length || 1);
const byCat: Record<string, { n: number; sum: number }> = {};
for (const r of valid) { byCat[r.category] = byCat[r.category] ?? { n: 0, sum: 0 }; byCat[r.category].n++; byCat[r.category].sum += r.score; }
const failed = valid.filter((r: any) => r.score < 0.5).map((r: any) => `- ${r.taskId}（${r.category}）score=${r.score} ${r.judgeNotes || r.error || ''}`.slice(0, 180));

const report = `# PawBench × CORAL 评测报告

> 生成于 ${new Date().toISOString()} · 任务集 PawBench v1.0（text 任务子集）
> 运行配置：CORAL v2.2.0，预算无上限（token/步数 0=∞），工作区 auto 权限，无人值守
> **judge 模型：${JUDGE_MODEL}（官方口径为 官方评审模型 —— 本分数与官方榜单不可直接对比，仅用于回归与诊断）**

## 总分：**${(avg * 100).toFixed(1)} / 100**（${valid.length} 个任务）

### 分类得分
${Object.entries(byCat).sort((a, b) => b[1].n - a[1].n).map(([c, v]) => `- ${c}：${((v.sum / v.n) * 100).toFixed(0)}（${v.n} 题）`).join('\n')}

### 低分任务（<0.5，诊断线索）
${failed.length ? failed.join('\n') : '（无）'}
`;
writeFileSync(join(REPO_ROOT, 'docs', 'PAWBENCH.md'), report, 'utf-8');
console.log(`\n=== 总分 ${(avg * 100).toFixed(1)}/100（${valid.length} 题）=== 报告已写 docs/PAWBENCH.md`);
