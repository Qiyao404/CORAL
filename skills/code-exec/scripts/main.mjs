#!/usr/bin/env node
/**
 * code-exec：模型写的 Python 代码在受限解释器内执行
 *
 * 沙箱边界做在解释器内部（sandbox_prelude.py — 审计钩子拦截"动作"），本文件负责：
 *  · 只给 Python 子进程最小环境变量（不转发任何密钥；见 PYTHON_ENV_WHITELIST）
 *  · fail-closed：沙箱自检不过 / Python 版本不够 → 拒绝执行，绝不"降级裸跑"
 *  · 超时 30s、输出截断、临时目录用完即删
 */
import { spawnSync } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const MAX_CODE_CHARS = 100_000;
const MAX_STDOUT_CHARS = 10_000;
const TIMEOUT_MS = 30_000;

/**
 * Python 子进程可见的环境变量（REG-22）。
 * 此前是 `...process.env` — 技能环境里的集成密钥（搜索 / 代码托管平台令牌）对模型写的代码敞开，
 * `from os import environ` 一行就能读走。纯计算不需要 PATH、临时目录，更不需要任何密钥：
 * 标准库与扩展模块的加载不依赖 PATH（3.8+ 走 add_dll_directory 语义）。
 * Windows 仍会自动给新进程注入用户名 / 主机名等身份变量 — 那部分由前导在解释器内部清除。
 */
const PYTHON_ENV_WHITELIST = ['SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE'];

function minimalEnv() {
  const env = {};
  for (const key of PYTHON_ENV_WHITELIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function out(obj) {
  console.log(JSON.stringify(obj));
}

const stdin = await new Promise(resolve => {
  let d = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', c => (d += c));
  process.stdin.on('end', () => resolve(d));
});
const payload = JSON.parse(stdin || '{}');
const input = payload.input ?? payload;
const code = String(input.code ?? '').trim();

if (!code) {
  out({ ok: false, error: '缺少 code' });
  process.exit(0);
}
if (code.length > MAX_CODE_CHARS) {
  out({ ok: false, error: `代码过长（${code.length} 字符，上限 ${MAX_CODE_CHARS}）` });
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const prelude = join(here, 'sandbox_prelude.py');
const tmpBase = join(tmpdir(), 'coral-code-');
mkdirSync(tmpBase, { recursive: true });
const tmpDir = mkdtempSync(join(tmpBase, 'run-'));
const pyFile = join(tmpDir, 'main.py');
writeFileSync(pyFile, code, 'utf-8');

/** 依次尝试可执行文件名；返回 { result } 或 { error }（一个都起不来） */
function runPython() {
  const candidates = process.platform === 'win32' ? ['python', 'py -3', 'python3'] : ['python3', 'python'];
  const args = ['-E', '-X', 'utf8', '-u', prelude, 'main.py'];
  let lastError = null;
  for (const cmd of candidates) {
    // -E：忽略 PYTHON* 环境变量（PYTHONPATH/启动注入类风险面）；-X utf8：跨平台统一输出编码
    const result = spawnSync(cmd, args, {
      encoding: 'utf-8',
      timeout: TIMEOUT_MS,
      cwd: tmpDir,
      windowsHide: true,
      env: minimalEnv(),
    });
    if (!result.error) return { result };
    // Windows 商店的占位 python：退出码 9009 + 提示语 — 视同不存在，换下一个候选
    const isStoreStub = result.status === 9009 || /Microsoft Store|无 Store/i.test(String(result.stderr ?? ''));
    if (result.error.code === 'ENOENT' || isStoreStub) {
      lastError = result.error;
      continue;
    }
    return { result };
  }
  return { error: lastError ?? new Error('python not found') };
}

try {
  const { result, error } = runPython();
  if (!result) {
    out({ ok: false, error: '未找到可用的 Python（需要 3.8+）', detail: String(error.message) });
    process.exit(0);
  }

  const stdout = (result.stdout ?? '').slice(0, MAX_STDOUT_CHARS);
  // 异常行在 stderr 末尾（"ZeroDivisionError: ..."）— 取尾部而不是头部，模型才看得到真正的错因
  const stderr = (result.stderr ?? '').trim().slice(-1500);

  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
    out({ ok: false, error: `执行超时（${TIMEOUT_MS / 1000} 秒）` });
  } else if (result.status === 0) {
    out({ ok: true, stdout: stdout.trim() || '(无输出)' });
  } else if (result.status === 4) {
    // 沙箱拦截（prelude 的 EXIT_VIOLATION）
    const reason = (stderr.match(/SANDBOX_VIOLATION:\s*(.*)/) ?? [])[1] ?? stderr.slice(0, 500);
    out({ ok: false, error: String(reason).trim(), detail: '这是沙箱的限制，不是代码 bug — 请改用纯计算的方式完成任务（不要读写文件/联网/起子进程）。' });
  } else if (result.status === 3) {
    // 沙箱不可用（prelude 的 EXIT_SANDBOX_UNAVAILABLE）— fail-closed：绝不降级裸跑
    out({ ok: false, error: '执行环境不支持沙箱，已拒绝执行', detail: stderr.slice(0, 500) });
  } else {
    out({ ok: false, error: `Python 错误 (exit ${result.status})`, detail: stderr.slice(-1200) });
  }
} finally {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
}
