const BASE = 'http://127.0.0.1:3001';
const DS = 'b4NnS9WT-2Bds18IpV4gc';
const fs = require('fs');
const os = require('os');
const path = require('path');

const questions = fs.readFileSync(path.join(os.tmpdir(), 'gaia-official', 'validation.jsonl'), 'utf-8').trim().split('\n')
  .map(l => JSON.parse(l))
  .filter(q => ['e1fc63a2','624cbf11','384d0dd8'].some(p => q.task_id.startsWith(p)));

function normalize(s) {
  let t = String(s ?? '').toLowerCase().trim();
  t = t.replace(/\b(a|an|the)\b/g, ' ');
  t = t.replace(/[,;%.%€£$]/g, '');
  t = t.replace(/-/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}
function score(pred, gold) {
  const p = normalize(pred), g = normalize(gold);
  if (p === g) return true;
  const pn = parseFloat(p), gn = parseFloat(g);
  return !isNaN(pn) && !isNaN(gn) && Math.abs(pn - gn) < 1e-6;
}
function extract(text) {
  const t = String(text ?? '').trim();
  let m = t.match(/final answer\s*[:：]\s*(.+)$/im);
  if (m) return m[1].trim();
  m = t.match(/最终答案\s*[:：]\s*(.+)$/m);
  if (m) return m[1].trim();
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].replace(/^[#>*\-\s]+/, '').trim();
    if (l && l.length <= 80) return l;
  }
  return t.slice(0, 80);
}

const results = JSON.parse(fs.readFileSync('data/gaia-results.json', 'utf-8'));
const wsDir = path.join(process.cwd(), 'data', 'gaia-ws');
if (!fs.existsSync(wsDir)) fs.mkdirSync(wsDir, { recursive: true });

async function main() {
  const wsList = await fetch(BASE + '/api/workspaces').then(r => r.json());
  let ws = (wsList.items ?? []).find(w => w.name === 'gaia-eval');
  if (!ws) {
    const wsPath = wsDir.split(path.sep).join('/');
    const created = await fetch(BASE + '/api/workspaces', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'gaia-eval', dir: wsPath, permission: 'auto' }),
    }).then(r => r.json());
    ws = created;
  }
  console.log('工作区:', ws.id);

  for (const q of questions) {
    console.log('\n=== ' + q.task_id.slice(0,8) + ' (L' + q.level + ') ===');
    const prompt = q.question + '\n\nUse your tools to find the answer. End with: Final Answer: <short answer>';
    const { runId } = await fetch(BASE + '/api/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: prompt, workspaceId: ws.id, sessionId: 'gaia-eval-session', modelProfileId: DS, budget: { maxSteps: 0, maxTokens: 0 } }),
    }).then(r => r.json());
    console.log('runId:', runId, '| 模型: deepseek-chat');

    const t0 = Date.now();
    let run = null;
    while (Date.now() - t0 < 25 * 60_000) {
      await new Promise(r => setTimeout(r, 5000));
      const d = await fetch(BASE + '/api/runs/' + runId).then(r => r.json());
      if (d.run?.status === 'waiting_human') {
        const p = (d.events ?? []).filter(e => e.type === 'tool.approval_required').at(-1);
        if (p) await fetch(BASE + '/api/runs/' + runId + '/approvals/' + p.payload.approvalId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved: true }) });
        continue;
      }
      if (['completed','failed','cancelled','timeout'].includes(d.run?.status)) { run = d.run; break; }
    }
    if (!run) run = { status: 'timeout', final_content: '' };

    const extracted = extract(run.final_content ?? '');
    const gold = q['Final answer'] ?? q.answer;
    const correct = score(extracted, gold);
    console.log(run.status, correct ? '✓' : '✗', '| pred:', extracted.slice(0, 40), '| gold:', String(gold).slice(0, 40));

    results[q.task_id] = {
      taskId: q.task_id, level: q.level, status: run.status, finalStatus: run.status,
      correct, extracted: extracted.slice(0, 100), gold: gold,
      question: q.question.slice(0, 120), tokens: (run.tokens_in ?? 0) + (run.tokens_out ?? 0),
      model: 'deepseek-chat', error: run.error?.message ?? '',
    };
    fs.writeFileSync('data/gaia-results.json', JSON.stringify(results, null, 2));
  }

  const all = Object.values(results);
  const orig30 = ['e1fc63a2','8e867cd7','ec09fa32','27d5d136','c61d22de','04a04a9b','14569e28','2a649bb1','624cbf11','e4e91f1c','676e5e31','384d0dd8','de9887f5','00d579ea','5d0080cb','a1e91b78','4b6bb5f7','3627a8be','dd3c7503','f0f46385','8b3379c0','0ff53813','a7feb290','2d83110e','46719c30','b816bfce','72e110e7','42576abe','5188369a','6f37996b'];
  const orig = all.filter(r => orig30.some(p => r.taskId?.startsWith(p)));
  const correct = orig.filter(x => x.correct).length;
  console.log('\n=== 最终（DeepSeek 重跑后）===');
  console.log('30题:', orig.length, '| 对:', correct, '| acc:', (correct / orig.length * 100).toFixed(1) + '%');
}
main();
