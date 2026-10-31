#!/usr/bin/env node
/**
 * code-exec：安全 Python 代码执行沙箱
 * 限制：超时 30s、禁止危险 import、禁止文件/网络操作、输出截断
 */
import { spawnSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const stdin = await new Promise(resolve => {
  let d = '';
  process.stdin.on('data', c => (d += c));
  process.stdin.on('end', () => resolve(d));
});
const payload = JSON.parse(stdin || '{}');
const input = payload.input ?? payload;
const code = String(input.code ?? '').trim();

if (!code) {
  console.log(JSON.stringify({ ok: false, error: '缺少 code' }));
  process.exit(0);
}

// 安全检查：禁止的模块和函数
const FORBIDDEN = /\b(import\s+(os|sys|subprocess|shutil|socket|requests|urllib|http|ftplib|telnetlib|smtplib|pickle|ctypes|multiprocessing)\b|__import__|eval\s*\(|exec\s*\(|open\s*\(|globals\s*\(|locals\s*\(|getattr\s*\(.*__|compile\s*\()/;
if (FORBIDDEN.test(code)) {
  console.log(JSON.stringify({ ok: false, error: '代码包含禁止的操作（文件/网络/系统调用）' }));
  process.exit(0);
}

// 写入临时 .py 文件执行（比 -c 更安全，避免 shell 注入）
const here = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(tmpdir(), 'coral-code-'));
const pyFile = join(tmpDir, 'main.py');
writeFileSync(pyFile, code, 'utf-8');

try {
  const result = spawnSync('python', [pyFile], {
    encoding: 'utf-8',
    timeout: 30_000,
    cwd: tmpDir,
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      // 沙箱：清空可能被利用的环境变量
      PYTHONSTARTUP: '',
      PYTHONPATH: '',
      PYTHONHOME: '',
    },
  });

  const stdout = (result.stdout ?? '').slice(0, 10_000);
  const stderr = (result.stderr ?? '').slice(0, 2_000);

  if (result.status === 0) {
    console.log(JSON.stringify({ ok: true, stdout: stdout.trim() || '(无输出)' }));
  } else if (result.signal === 'SIGTERM' || result.error?.code === 'ETIMEDOUT') {
    console.log(JSON.stringify({ ok: false, error: '执行超时（30 秒）' }));
  } else {
    console.log(JSON.stringify({ ok: false, error: `Python 错误 (exit ${result.status})`, detail: stderr.trim().slice(0, 500) }));
  }
} finally {
  try { unlinkSync(pyFile); } catch {}
  try { unlinkSync(join(tmpDir, '__pycache__')); } catch {}
}
