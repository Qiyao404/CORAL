/**
 * M1-2：行级统一 diff（fs_write / fs_edit 的产出，供 diff 审批卡片渲染）。
 * LCS 回溯 + hunk 前后 context 行，个人量级文件（数千行内）足够。
 */

type Op = { type: '=' | '-' | '+'; line: string };

function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // LCS 长度表（O(n·m) 内存，个人文件可接受）
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: '=', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: '-', line: a[i] });
      i++;
    } else {
      ops.push({ type: '+', line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: '-', line: a[i++] });
  while (j < m) ops.push({ type: '+', line: b[j++] });
  return ops;
}

/**
 * 生成 unified diff 文本（--- / +++ / @@ 头 + 变更行与上下文行）。
 * 内容一致时返回空字符串；空文件到有内容也正确（行号从 1 起）。
 */
export function unifiedDiff(before: string, after: string, path: string, contextLines = 3): string {
  if (before === after) return '';

  // 空字符串 split('\n') 得 ['']（一个空行）— 空文件语义下应为 0 行
  const toLines = (s: string) => (s === '' ? [] : s.split('\n'));
  const ops = diffOps(toLines(before), toLines(after));
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];

  let lineA = 0;
  let lineB = 0;
  let hunk: string[] = [];
  let startA = 1;
  let startB = 1;
  /** hunk 未打开时缓存的等值行（最多 context 条，作为下一个 hunk 的前置上下文） */
  let prefix: string[] = [];
  /** hunk 打开后连续等值行计数（超过 context 关闭 hunk） */
  let equalRun = 0;

  const closeHunk = () => {
    if (hunk.length === 0) return;
    const countA = hunk.filter(l => !l.startsWith('+')).length;
    const countB = hunk.filter(l => !l.startsWith('-')).length;
    // GNU diff 惯例：该侧 count 为 0 时起始行号显示 0
    const a0 = countA === 0 ? 0 : startA;
    const b0 = countB === 0 ? 0 : startB;
    out.push(`@@ -${a0},${countA} +${b0},${countB} @@`);
    out.push(...hunk);
    hunk = [];
  };

  for (const op of ops) {
    if (op.type === '=') {
      lineA++;
      lineB++;
      if (hunk.length > 0) {
        equalRun++;
        if (equalRun <= contextLines) {
          hunk.push(` ${op.line}`);
        } else {
          closeHunk();
          prefix = [`${' '}${op.line}`]; // 该行成为潜在新 hunk 的前置上下文
        }
      } else {
        prefix.push(` ${op.line}`);
        if (prefix.length > contextLines) prefix.shift();
      }
    } else {
      if (hunk.length === 0) {
        startA = lineA - prefix.length + 1;
        startB = lineB - prefix.length + 1;
        hunk.push(...prefix.splice(0));
      }
      hunk.push(`${op.type}${op.line}`);
      if (op.type === '-') lineA++;
      else lineB++;
      equalRun = 0;
    }
  }
  closeHunk();

  return out.join('\n') + '\n';
}
