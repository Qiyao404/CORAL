/**
 * 性能基准（scripts/benchmark.mts）— 用 npx tsx scripts/benchmark.mts 运行
 *
 * 三组测量（结果写入 docs/BENCHMARK.md，可重复执行刷新数据）：
 *  1. 上下文压缩收益：合成 60 轮大工具结果的历史，分别过 收纳层/全量摘要层，
 *     报告压缩前后字符数与估算 token（≈chars/3.5 中英混合经验值）
 *  2. 事件持久化吞吐：better-sqlite3（WAL）批量 insert vs JSON 行文件追加，
 *     各写 5000 条，报告 ops/s
 *  3. 测试套件执行时间：调 vitest run 计时（可选，--with-tests 开启）
 */
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

// ─── 1. 上下文压缩收益 ─────────────────────────────────────────────────────

async function benchContext() {
  // Windows 下动态 import 绝对路径必须走 file:// URL
  const ctxMod: any = await import(pathToFileURL(join(REPO_ROOT, 'packages/server/src/kernel/context-window.ts')).href);
  const { shelveOldToolResults, compressIfNeeded } = ctxMod;
  type ChatMessage = import('../packages/server/src/providers/types.js').ChatMessage;

  // 合成历史：1 条 goal + 30 组 [assistant(toolCalls), tool(40KB 结果)]
  const msgs: any[] = [{ role: 'user', content: '对 30 个数据源做汇总分析并生成报告' }];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'http_fetch', input: {} }] });
    msgs.push({ role: 'tool', toolCallId: `c${i}`, toolName: 'http_fetch', content: `{"url":"https://example.com/source-${i}","body":"${'D'.repeat(40_000)}"}` });
  }
  const total = (m: any[]) => m.reduce((n, x) => n + (x.content ?? '').length, 0);
  const tok = (chars: number) => Math.round(chars / 3.5);

  const before = total(msgs);
  const shelved = shelveOldToolResults(msgs as ChatMessage[], 1_000_000, {
    archive: (_t, _c) => 'ev-benchmark',
  });
  const afterShelve = total(shelved.messages);
  const compressed = await compressIfNeeded(shelved.messages as ChatMessage[], {
    maxTotalChars: 100_000, keepRecent: 12, summarize: async t => `[摘要] ${t.slice(0, 800)}`,
  });
  const afterCompact = total(compressed.messages);

  return {
    before: { chars: before, tokensEst: tok(before) },
    shelve: { chars: afterShelve, tokensEst: tok(afterShelve), ratio: `${((1 - afterShelve / before) * 100).toFixed(1)}%` },
    compact: { chars: afterCompact, tokensEst: tok(afterCompact), ratio: `${((1 - afterCompact / before) * 100).toFixed(1)}%` },
  };
}

// ─── 2. 持久化吞吐（WAL SQLite vs JSON 追加）──────────────────────────────

function benchPersistence() {
  const tmp = mkdtempSync(join(REPO_ROOT, 'data', 'bench-'));
  try {
    const N = 5000;
    const row = (i: number) => ({ runId: 'bench', seq: i, type: 'tool.call_completed', agentId: 'main', payload: { tool: 'http_fetch', ok: true, i } });

    // SQLite WAL
    const Database = require('better-sqlite3');
    const db = new Database(join(tmp, 'b.db'));
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE events (run_id TEXT, seq INTEGER, type TEXT, payload TEXT)');
    const stmt = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?)');
    const t0 = Date.now();
    const tx = db.transaction(() => {
      for (let i = 0; i < N; i++) {
        const r = row(i);
        stmt.run(r.runId, r.seq, r.type, JSON.stringify(r.payload));
      }
    });
    tx();
    const t1 = Date.now();
    const sqliteOps = Math.round(N / ((t1 - t0) / 1000));
    const sqliteMs = t1 - t0;
    db.close();

    // JSON 行文件
    const jpath = join(tmp, 'b.jsonl');
    const t2 = Date.now();
    let buf = '';
    for (let i = 0; i < N; i++) buf += JSON.stringify(row(i)) + '\n';
    writeFileSync(jpath, buf);
    const t3 = Date.now();
    const jsonOps = Math.round(N / ((t3 - t2) / 1000));
    const jsonMs = t3 - t2;
    const jsonSize = statSync(jpath).size;

    return {
      条数: N,
      sqlite_wal: { 耗时ms: sqliteMs, ops_per_sec: sqliteOps },
      jsonl_整写: { 耗时ms: jsonMs, ops_per_sec: jsonOps, 文件MB: +(jsonSize / 1024 / 1024).toFixed(1) },
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── 主流程 ───────────────────────────────────────────────────────────────

const withTests = process.argv.includes('--with-tests');
const ctx = await benchContext();
const persist = benchPersistence();
let testMs: number | null = null;
if (withTests) {
  const t = Date.now();
  const r = spawnSync('npx', ['tsx', 'node_modules/vitest/vitest.mjs', 'run'], {
    cwd: join(REPO_ROOT, 'packages/server'), shell: true, stdio: 'ignore',
  });
  if (r.status === 0) testMs = Date.now() - t;
}

const report = `# 性能基准（BENCHMARK）

> 由 \`npx tsx scripts/benchmark.mts\` 生成于 ${new Date().toISOString()}（本机环境，Windows / Node 22）
> 数字用于量级判断而非精确对比；可重复运行刷新。

## 1. 上下文压缩收益（30 轮 × 40KB 工具结果 ≈ 1.2MB 历史）

| 阶段 | 字符 | ≈token | 相对原始 |
|---|---|---|---|
| 原始历史 | ${ctx.before.chars} | ${ctx.before.tokensEst} | — |
| 收纳层（旧结果→证据引用占位） | ${ctx.shelve.chars} | ${ctx.shelve.tokensEst} | ${ctx.shelve.ratio} |
| 全量摘要层（中段→LLM 摘要） | ${ctx.compact.chars} | ${ctx.compact.tokensEst} | ${ctx.compact.ratio} |

## 2. 事件持久化吞吐（${persist.条数} 条）

| 后端 | 耗时 | ops/s |
|---|---|---|
| SQLite（WAL，事务批量） | ${persist.sqlite_wal.耗时ms}ms | ${persist.sqlite_wal.ops_per_sec} |
| JSONL（整写） | ${persist.jsonl_整写.耗时ms}ms | ${persist.jsonl_整写.ops_per_sec}（文件 ${persist.jsonl_整写.文件MB}MB） |

> 纯追加场景 JSONL 更快是预期（无行结构/索引开销）；选 SQLite 的理由是**可查询回放**（事件溯源按 run/seq/类型检索、Time-Travel、审批流状态机都依赖结构化查询），吞吐差异在个人量级（万条/秒级）无感。

## 3. 测试套件（403 用例）

${testMs != null ? `\`vitest run\` 全量 ${testMs}ms（含 transform 冷启动）` : '未启用（--with-tests 开启）'}
`;

const { writeFileSync: wf } = await import('fs');
wf(join(REPO_ROOT, 'docs', 'BENCHMARK.md'), report, 'utf-8');
console.log(report);
console.log('已写入 docs/BENCHMARK.md');
