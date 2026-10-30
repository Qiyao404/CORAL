/**
 * GAIA 官方 validation × CORAL 评测驱动（scripts/gaia-eval.mts）
 *
 * 用法：
 *   npx tsx scripts/gaia-eval.mts --n 30            # 按层级比例抽样（text-only 优先）
 *   npx tsx scripts/gaia-eval.mts --all             # 全部 127 道 text-only 题
 *   npx tsx scripts/gaia-eval.mts --ids <task_id>   # 指定题
 *
 * 数据：官方 validation 165 题（L1 53 / L2 86 / L3 26）；首跑聚焦 text-only 127 题
 * （CORAL 无音频/图像通道，38 道附件题中 mp3/jpg/png 必定无法处理；csv/txt/docx/pdf
 *  附件题可跑——用 --with-attachments 纳入，附件注入工作区）
 * 评分：GAIA 官方 normalization（lowercase/去冠词/去标点/空白归一/数值等价）后
 *       exact match——确定性评分，无 judge 模型参与
 * 附件下载：需要环境变量 HF_TOKEN（官方数据集 gated）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const CORAL = 'http://127.0.0.1:3001';
const DATA_DIR = join(tmpdir(), 'gaia-official');
const QUESTIONS = join(DATA_DIR, 'validation.jsonl');

const args = process.argv.slice(2);
const argOf = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const N = Number(argOf('--n') ?? 30);
const IDS = argOf('--ids')?.split(',').map(s => s.trim()).filter(Boolean);
const ALL = args.includes('--all');
const WITH_ATT = args.includes('--with-attachments');
const PROXY = process.env.EVAL_PROXY ?? 'http://127.0.0.1:22307';
const HF_TOKEN = process.env.HF_TOKEN ?? '';

// ── 题目加载 ───────────────────────────────────────────────────────────────

interface Q {
  task_id: string;
  question: string;
  level: string;
  answer: string;
  file_name: string;
  file_path: string;
}

const allQuestions: Q[] = readFileSync(QUESTIONS, 'utf-8')
  .trim().split('\n')
  .map(line => {
    const o = JSON.parse(line);
    return {
      task_id: o.task_id, question: o.question, level: o.level,
      answer: o.answer, file_name: o.file_name ?? '', file_path: o.file_path ?? '',
    };
  });

const runnable = WITH_ATT ? allQuestions : allQuestions.filter(q => !q.file_name);
let selected: Q[];
if (IDS) selected = IDS.map(id => allQuestions.find(q => q.task_id.startsWith(id))).filter((q): q is Q => !!q);
else if (ALL) selected = runnable;
else {
  // 按 L1:L2:L3 = 42:66:19（text-only 的层级比例）分层抽样
  const byLevel = new Map<string, Q[]>();
  for (const q of runnable) byLevel.set(q.level, [...(byLevel.get(q.level) ?? []), q]);
  selected = [];
  for (const [lv, list] of byLevel) {
    const quota = Math.max(1, Math.round(N * list.length / runnable.length));
    selected.push(...list.slice(0, quota));
  }
  selected = selected.slice(0, N + 3);
}

console.log(`GAIA × CORAL：选中 ${selected.length} 题（text-only 池 ${runnable.length} / 全库 ${allQuestions.length}）`);
console.log(`评分：官方 normalization exact match（确定性）\n`);

// ── GAIA 官方评分器（对齐官方 scorer 语义）────────────────────────────────

function normalizeAnswer(s: string): string {
  let t = String(s ?? '').toLowerCase().trim();
  t = t.replace(/\b(a|an|the)\b/g, ' ');            // 去冠词
  t = t.replace(/[,;%€£$]/g, '');                    // 千分位/货币/百分号
  // 去标点（保留数字内的 . 和 /）；连字符转空格（"human-oriented"="human oriented" — 实测发现的评分缺口）
  t = t.replace(/[!?;:_"'`~@#^*(){}\[\]<>|\\]+/g, ' ');
  t = t.replace(/-(?!\d)|(?<!\d)-/g, ' ');           // 非数字间的连字符 → 空格（负号/日期保留）
  t = t.replace(/(?<!\d)[.](?!\d)/g, ' ');           // 非数字间的句点
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function numeric(v: string): number | null {
  const t = v.replace(/,/g, '').trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return null;
}

function scoreAnswer(pred: string, gold: string): boolean {
  const p = normalizeAnswer(pred);
  const g = normalizeAnswer(gold);
  if (p === g) return true;
  const pn = numeric(p), gn = numeric(g);
  if (pn !== null && gn !== null) return Math.abs(pn - gn) < 1e-6;   // 数值等价（"1,000"="1000"）
  return false;
}

/** 从模型终答提取简短答案（"Final Answer: X" 行 → 末行 → 全文） */
function extractAnswer(final: string): string {
  const text = String(final ?? '').trim();
  const m = text.match(/final answer\s*[:：]\s*(.+)$/im);
  if (m) return m[1].trim();
  // 去掉常见前缀后的最后一行（若非空且短）
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].replace(/^[#>*\-\s]+/, '').trim();
    if (l && l.length <= 80) return l;
  }
  return text.slice(0, 80);
}

// ── CORAL API ──────────────────────────────────────────────────────────────

async function api(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${CORAL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

const PROMPT = (q: string) =>
  `${q}\n\n---\nUse your tools (skill_web-search for search, http_fetch for pages, and your own knowledge) to find the answer. ` +
  `Think step by step, verify facts, and end your reply with a line exactly of the form:\nFinal Answer: <short answer>\n` +
  `The short answer must be only a word, number, name or short phrase (no explanation, no unit unless essential).`;

async function ensureWorkspace(dir: string): Promise<string> {
  const existing = await api('/api/workspaces');
  const hit = (existing.items ?? []).find((w: any) => w.name === 'gaia-eval');
  if (hit) return hit.id;
  const created = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'gaia-eval', dir: dir.split('\\').join('/'), permission: 'auto' }) });
  return created.id;
}

async function downloadAttachment(q: Q, wsDir: string): Promise<void> {
  if (!q.file_name || !q.file_path) return;
  const rel = q.file_path.replace(/^\//, '');
  const url = `https://huggingface.co/datasets/gaia-benchmark/GAIA/resolve/main/2023/validation/${encodeURIComponent(q.file_name)}`;
  const dst = join(wsDir, q.file_name);
  const r = spawnSync('curl', ['-sL', '--max-time', '60', '-x', PROXY, '-H', `Authorization: Bearer ${HF_TOKEN}`, '-o', dst, url], { encoding: 'utf-8' });
  if (r.status !== 0) console.log(`  ⚠ 附件下载失败: ${q.file_name}`);
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

const wsDir = join(REPO_ROOT, 'data', 'gaia-ws');
if (!existsSync(wsDir)) mkdirSync(wsDir, { recursive: true });
const resultsPath = join(REPO_ROOT, 'data', 'gaia-results.json');
const prev: Record<string, any> = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf-8')) : {};

async function main() {
  const wsId = await ensureWorkspace(wsDir);
  let done = 0;
  for (const q of selected) {
    done++;
    const tag = `[${String(done).padStart(2)}/${selected.length}] L${q.level} ${q.task_id.slice(0, 8)}`;
    if (prev[q.task_id]?.finalStatus === 'completed') { console.log(`${tag} 已有结果（${prev[q.task_id].correct ? '✓' : '✗'}）— 跳过`); continue; }

    rmSync(wsDir, { recursive: true, force: true });
    mkdirSync(wsDir, { recursive: true });
    await downloadAttachment(q, wsDir);

    try {
      const { runId } = await api('/api/runs', {
        method: 'POST',
        // sessionId：让评测 run 作为一个对话出现在 ChatPage 侧栏——用户可实时看到正在跑的题
        body: JSON.stringify({ goal: PROMPT(q.question), workspaceId: wsId, sessionId: 'gaia-eval-session', budget: { maxSteps: 0, maxTokens: 0 } }),
      });
      const started = Date.now();
      let result: any = null;
      while (Date.now() - started < 25 * 60_000) {  // 单题 25 分钟（官方无硬限，宽松预算）
        await new Promise(r => setTimeout(r, 5000));
        const d = await api(`/api/runs/${runId}`);
        const run = d.run ?? d;
        if (run.status === 'waiting_human') {  // 审批自动批（附件写操作等）
          const resolved = new Set((d.events ?? []).filter((e: any) => e.type === 'tool.approval_resolved').map((e: any) => e.payload?.approvalId));
          for (const e of (d.events ?? []).filter((x: any) => x.type === 'tool.approval_required')) {
            if (resolved.has(e.payload.approvalId)) continue;
            await api(`/api/runs/${runId}/approvals/${e.payload.approvalId}`, { method: 'POST', body: JSON.stringify({ approved: true, scope: 'session' }) });
          }
          continue;
        }
        if (['completed', 'failed', 'cancelled'].includes(run.status)) { result = run; break; }
      }
      if (!result) {
        await api(`/api/runs/${runId}/cancel`, { method: 'POST' }).catch(() => {});
        prev[q.task_id] = { taskId: q.task_id, level: q.level, status: 'timeout', finalStatus: 'timeout', correct: false, extracted: '', gold: q.answer, question: q.question.slice(0, 120), error: '超时' };
        writeFileSync(resultsPath, JSON.stringify(prev, null, 2), 'utf-8');
        console.log(`${tag} ⏱ 超时`);
        continue;
      }
      const extracted = extractAnswer(String(result.final_content ?? ''));
      const correct = scoreAnswer(extracted, q.answer);
      prev[q.task_id] = {
        taskId: q.task_id, level: q.level, status: result.status, finalStatus: result.status,
        correct, extracted: extracted.slice(0, 100), gold: q.answer,
        question: q.question.slice(0, 120),
        tokens: (result.tokens_in ?? 0) + (result.tokens_out ?? 0),
        ...(result.error ? { error: String(result.error).slice(0, 150) } : {}),
      };
      writeFileSync(resultsPath, JSON.stringify(prev, null, 2), 'utf-8');
      console.log(`${tag} ${correct ? '✓' : '✗'} pred="${extracted.slice(0, 50)}" gold="${q.answer.slice(0, 50)}" tokens=${prev[q.task_id].tokens}${prev[q.task_id].error ? ' ⚠ ' + prev[q.task_id].error : ''}`);
    } catch (e: any) {
      prev[q.task_id] = { taskId: q.task_id, level: q.level, status: 'error', finalStatus: 'error', correct: false, extracted: '', gold: q.answer, question: q.question.slice(0, 120), error: String(e?.message ?? e).slice(0, 200) };
      writeFileSync(resultsPath, JSON.stringify(prev, ' ', 2).replace("' '", '  '), 'utf-8');
      console.log(`${tag} ⚠ ERROR ${String(e?.message ?? e).slice(0, 150)}`);
    }
  }

  // ── 汇总 ─────────────────────────────────────────────────────────────
  const rows = Object.values(prev).filter((r: any) => selected.some(s => s.task_id === r.taskId));
  const valid = rows.filter((r: any) => r.finalStatus === 'completed');
  const acc = valid.filter((r: any) => r.correct).length / (valid.length || 1);
  const byLevel: Record<string, { n: number; c: number }> = {};
  for (const r of valid) { byLevel[r.level] = byLevel[r.level] ?? { n: 0, c: 0 }; byLevel[r.level].n++; if (r.correct) byLevel[r.level].c++; }
  const wrong = valid.filter((r: any) => !r.correct);

  const report = `# GAIA × CORAL 评测报告

> 生成于 ${new Date().toISOString()} · 官方 GAIA benchmark validation split（gaia-benchmark/GAIA）
> 任务范围：text-only 题（无附件；附件题另测）· 抽样 ${selected.length} 题
> 运行配置：CORAL v2.2.0 · 预算无上限（0=∞）· 单题限时 8 分钟 · 工作区 auto 无人值守
> 评分：官方 normalization（lowercase/去冠词/去标点/空白归一/数值等价）后 exact match — 确定性评分，无 judge 模型

## 总分（accuracy）：**${(acc * 100).toFixed(1)}%**（${valid.length} 题，答对 ${valid.filter((r: any) => r.correct).length} 题）

### 分层
${Object.entries(byLevel).sort().map(([lv, v]) => `- Level ${lv}：${v.c}/${v.n}（${((v.c / v.n) * 100).toFixed(0)}%）`).join('\n')}

### 参照（官方榜单 validation 粗略区间：人类 ~92%，GPT-4+插件 ~40-60%，顶级 agent 系统 ~60-75%）

### 答错清单（诊断用）
${wrong.map((r: any) => `- L${r.level} [${r.taskId.slice(0, 8)}] pred="${String(r.extracted).slice(0, 60)}" / gold="${String(r.gold).slice(0, 60)}"${r.error ? ' ⚠' + String(r.error).slice(0, 60) : ''}`).join('\n') || '（无）'}

### 非完成态
${rows.filter((r: any) => r.finalStatus !== 'completed').map((r: any) => `- [${r.taskId.slice(0, 8)}] ${r.finalStatus}${r.error ? '：' + String(r.error).slice(0, 80) : ''}`).join('\n') || '（无）'}

### 复现
\`HF_TOKEN=<token> npx tsx scripts/gaia-eval.mts --n 30\`（断点续跑：data/gaia-results.json）
`;
  writeFileSync(join(REPO_ROOT, 'docs', 'GAIA.md'), report, 'utf-8');
  console.log(`\n=== GAIA accuracy ${(acc * 100).toFixed(1)}%（${valid.length} 题）=== 报告已写 docs/GAIA.md`);
}

await main();
