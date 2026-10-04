#!/usr/bin/env node
/**
 * M4-2 csv-insight：本地 CSV 数据画像（行列/类型/数值范围/缺失值/极值行），零依赖解析。
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitProgress, emitLog, emitArtifact } from '../../_lib/coral-progress.mjs';

const stdin = await new Promise(resolve => {
  let data = '';
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => resolve(data));
});
const payload = JSON.parse(stdin || '{}');
const input = payload.input ?? payload;
const csvPath = String(input.path || '');
if (!csvPath) {
  console.log(JSON.stringify({ ok: false, error: '缺少 path（CSV 文件路径，相对工作区）' }));
  process.exit(0);
}

emitProgress('read', '读取 CSV', { percent: 10 });
const base = process.env.CORAL_OUTPUT_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'output');
const abs = /^[a-zA-Z]:[\/]/.test(csvPath) || csvPath.startsWith('/') ? csvPath : join(base, csvPath);
let raw;
try {
  raw = readFileSync(abs, 'utf-8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // 终审 P2：剥 BOM（Excel 导出常见）
} catch (err) {
  emitLog(`读取失败: ${err?.message ?? err}`, 'error');
  console.log(JSON.stringify({ ok: false, error: `读取失败: ${abs}` }));
  process.exit(0);
}

emitProgress('parse', '解析行列', { percent: 40 });
// 轻量 CSV 解析（处理引号转义）
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const rows = parseCsv(raw);
if (rows.length < 2) {
  console.log(JSON.stringify({ ok: false, error: `CSV 行数不足（${rows.length}）` }));
  process.exit(0);
}
const header = rows[0];
const dataRows = rows.slice(1);

emitProgress('stats', '统计画像', { percent: 75 });
const columns = header.map((name, col) => {
  const values = dataRows.map(r => (r[col] ?? '').trim());
  const nonEmpty = values.filter(v => v !== '');
  const missing = values.length - nonEmpty.length;
  const numerics = nonEmpty.map(Number).filter(Number.isFinite);
  const isNumeric = numerics.length >= nonEmpty.length * 0.8 && nonEmpty.length > 0;
  const uniq = new Set(nonEmpty);
  // 终审 P3：for 归约 — Math.min(...大数组) 超 6.5 万实参直接 RangeError
  let stats = null;
  if (isNumeric) {
    let min = Infinity, max = -Infinity, sum = 0;
    for (const v of numerics) { if (v < min) min = v; if (v > max) max = v; sum += v; }
    stats = { min, max, avg: Number((sum / numerics.length).toFixed(2)) };
  }
  return { name, missing, unique: uniq.size, type: isNumeric ? 'number' : 'string', stats,
    topValues: [...uniq].slice(0, 3) };
});

emitProgress('write', '生成报告', { percent: 95 });
mkdirSync(base, { recursive: true });
const outPath = join(base, `csv-insight_${header.length}cols.md`);
writeFileSync(outPath, [
  `# CSV 画像：${csvPath}`,
  '',
  `- 数据行: ${dataRows.length} | 列数: ${header.length}`,
  '',
  '| 列 | 类型 | 缺失 | 唯一值 | 数值范围/高频值 |',
  '|---|---|---|---|---|',
  ...columns.map(c => `| ${c.name} | ${c.type} | ${c.missing} | ${c.unique} | ${c.stats ? `${c.stats.min} ~ ${c.stats.max}（均 ${c.stats.avg}）` : c.topValues.join(' / ')} |`),
].join('\n'), 'utf-8');
emitArtifact(outPath.split(/[\/]/).pop(), outPath, 'markdown', { preview: `${dataRows.length} 行 × ${header.length} 列` });
emitProgress('done', '完成', { percent: 100 });

console.log(JSON.stringify({ ok: true, md_path: outPath, rows: dataRows.length, columns: header.length, columnStats: columns }, null, 2));
