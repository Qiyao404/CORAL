import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * REG-22：code-exec 的沙箱必须是"边界"而不是"黑名单"。
 *
 * 旧实现是一张 import 正则黑名单：`from os import environ`、`import pathlib`、`from subprocess import run`
 * 这类写法直接绕过 — 模型（或被网页内容诱导的模型）写的代码可以读写文件、读环境变量里的集成密钥、起子进程。
 * 现在边界做在解释器内部（审计钩子拦截"动作"），并由这里逐个手法验证。
 *
 * 测试直接启动真实技能脚本（stdin JSON，与平台执行器的调用方式一致），需要本机有 Python 3.8+。
 */

const SKILL_MAIN = resolve(__dirname, '../../../../../skills/code-exec/scripts/main.mjs');
const SECRETS = { CORAL_GITHUB_TOKEN: 'ghp_SECRET_TOKEN_VALUE', CORAL_TAVILY_API_KEY: 'tvly_SECRET_KEY_VALUE' };

const py = process.platform === 'win32' ? spawnSync('python', ['--version'], { encoding: 'utf-8' }) : spawnSync('python3', ['--version'], { encoding: 'utf-8' });
const pythonOk = py.status === 0 && !/Windows Store|Microsoft Store/i.test(`${py.stdout}${py.stderr}`);
const d = pythonOk ? describe : describe.skip;

function runCode(code: string, cwd: string) {
  const r = spawnSync(process.execPath, [SKILL_MAIN], {
    input: JSON.stringify({ input: { code } }),
    encoding: 'utf-8',
    timeout: 90_000,
    cwd,
    // 与平台执行器的技能环境一致：白名单变量（含集成密钥）+ 运行时必需项
    env: {
      PATH: process.env.PATH ?? '',
      PATHEXT: process.env.PATHEXT ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? '',
      TEMP: cwd,
      TMP: cwd,
      PYTHONUTF8: '1',
      ...SECRETS,
    },
  });
  let parsed: any = null;
  try { parsed = JSON.parse(String(r.stdout ?? '').trim().split('\n').pop() ?? ''); } catch { /* 非 JSON */ }
  return { parsed, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), status: r.status };
}

let work: string;
let secretFile: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'coral-codeexec-test-'));
  secretFile = join(work, 'secret.txt');
  writeFileSync(secretFile, 'TOP_SECRET_FILE_CONTENT_9f3a', 'utf-8');
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

d('code-exec · 正常计算不受影响', () => {
  it('math / statistics / datetime / re / json / decimal 等标准计算库可用', () => {
    const code = [
      'import json, math, statistics, datetime, re, decimal, fractions, collections, itertools, random',
      "d = decimal.Decimal('0.1') + decimal.Decimal('0.2')",
      "print(json.dumps({'hyp': math.hypot(3, 4), 'mean': statistics.mean([1, 2, 3]), 'days': (datetime.date(2025, 3, 20) - datetime.date(2024, 1, 15)).days, 'dec': str(d), 'frac': str(fractions.Fraction(1, 3)), 'nums': re.findall(r'\\d+', 'a1b22'), 'seeded': random.Random(7).random() > 0}))",
    ].join('\n');
    const r = runCode(code, work);
    expect(r.parsed?.ok, r.stderr || r.stdout).toBe(true);
    const out = JSON.parse(r.parsed.stdout);
    expect(out.hyp).toBe(5);
    expect(out.days).toBe(430);
    expect(out.dec).toBe('0.3');
    expect(out.nums).toEqual(['1', '22']);
  });

  it('中文输出不乱码；运行时错误如实带回', () => {
    const ok = runCode("print('计算结果：四十二')", work);
    expect(ok.parsed?.ok).toBe(true);
    expect(ok.parsed.stdout).toContain('计算结果：四十二');
    const bad = runCode('x = 1 / 0', work);
    expect(bad.parsed?.ok).toBe(false);
    expect(String(bad.parsed?.detail ?? '') + String(bad.parsed?.error ?? '')).toContain('ZeroDivisionError');
  });
});

d('code-exec · 上次审计列出的绕过手法逐个封堵', () => {
  // leak：输出里绝不能出现的字符串；allowRun：读得到本身不违规（os 是解释器自带模块），只断言不泄漏。
  // code 可以是函数：依赖 beforeAll 里才创建的文件路径的探针必须延迟到用例执行时再拼 —
  //（曾在 describe 体里直接拼，路径是 undefined → 实际执行的是 open(undefined) → NameError，
  //  而报错栈里恰好带着 sandbox_prelude.py 的文件名，把断言"碰巧"满足成了假绿）
  const IDENTITY_KEYS = ['USERNAME', 'USERPROFILE', 'LOGONSERVER', 'PATH'];
  const probes: Array<{ name: string; code: string | (() => string); leak?: string[]; allowRun?: boolean }> = [
    {
      name: 'from os import environ — 读环境变量（不得出现密钥与身份信息）',
      code: "from os import environ\nprint(environ.get('CORAL_GITHUB_TOKEN'), environ.get('CORAL_TAVILY_API_KEY'), sorted(environ))",
      leak: [...Object.values(SECRETS), ...IDENTITY_KEYS],
      allowRun: true,
    },
    {
      name: 'import os 后打印全部环境变量（不得出现密钥与身份信息）',
      code: 'import os\nprint(dict(os.environ))',
      leak: [...Object.values(SECRETS), ...IDENTITY_KEYS],
      allowRun: true,
    },
    { name: 'open() 读任意文件（字符串路径 — 与 pathlib 是不同的拦截分支）', code: `import os\nprint(open(os.path.join(os.environ.get('SYSTEMROOT', 'C:/Windows'), 'win.ini'), encoding='utf-8', errors='ignore').read()[:40])`, leak: ['[fonts]'] },
    { name: 'open() 读测试目录里的机密文件（字符串路径）', code: () => `print(open(${JSON.stringify(secretFile)}, encoding='utf-8').read())`, leak: ['TOP_SECRET_FILE_CONTENT_9f3a'] },
    { name: 'open() 读当前目录下的文件（字符串相对路径）', code: `print(open('main.py', encoding='utf-8').read()[:20])` },
    { name: 'pathlib 写文件', code: "import pathlib\npathlib.Path('pwned.txt').write_text('pwned', encoding='utf-8')\nprint('written')" },
    { name: 'pathlib 读文件', code: () => `import pathlib\nprint(pathlib.Path(${JSON.stringify(secretFile)}).read_text(encoding='utf-8'))`, leak: ['TOP_SECRET_FILE_CONTENT_9f3a'] },
    { name: 'from subprocess import run — 起子进程', code: "from subprocess import run\nr = run(['python', '-c', 'print(1)'], capture_output=True)\nprint('spawned', r.returncode)" },
    { name: 'socket 绑定端口', code: "from socket import socket, AF_INET, SOCK_STREAM\ns = socket(AF_INET, SOCK_STREAM)\ns.bind(('127.0.0.1', 0))\nprint('bound')" },
    { name: 'importlib 动态加载 ctypes', code: "import importlib\nm = importlib.import_module('ctypes')\nprint('loaded', m.__name__)" },
    { name: 'sqlite3 建库文件', code: "import sqlite3\nc = sqlite3.connect('pwned.db')\nc.close()\nprint('db created')" },
    { name: 'importlib 动态加载 os 后 system()', code: "import importlib\nos_mod = importlib.import_module('os')\nprint(os_mod.system('echo pwned'))" },
    { name: 'tempfile 建临时文件', code: "import tempfile\nf = tempfile.NamedTemporaryFile(delete=False)\nf.close()\nprint(f.name)" },
    { name: 'exec 字符串里的文件写入', code: "exec(\"open('pwned2.txt', 'w', encoding='utf-8').write('x')\")\nprint('written')" },
    { name: '__import__ 动态加载后列目录', code: "os_mod = __import__('os')\nprint(os_mod.listdir('.'))" },
  ];
  if (process.platform === 'win32') {
    probes.push({ name: 'importlib 动态加载 winreg（注册表）', code: "import importlib\nimportlib.import_module('winreg')\nprint('reg loaded')" });
  }

  for (const p of probes) {
    it(p.name, () => {
      const code = typeof p.code === 'function' ? p.code() : p.code;
      expect(code.includes('undefined'), `探针代码里混进了 undefined: ${code.slice(0, 120)}`).toBe(false);
      const r = runCode(code, work);
      const text = `${r.stdout}\n${r.stderr}\n${JSON.stringify(r.parsed ?? {})}`;
      for (const secret of p.leak ?? []) expect(text).not.toContain(secret);
      if (p.allowRun) return; // 读得到环境变量本身不违规 — 上面已断言里面没有密钥与身份信息
      expect(r.parsed?.ok, `应当被沙箱拦截，实际返回: ${text}`).toBe(false);
      // 只认沙箱的真实提示语 — 不能用宽泛的 /sandbox/（前导文件名里就有这个词，会把任何报错都"匹配"成通过）
      expect(text).toMatch(/沙箱禁止的操作|沙箱禁止导入模块|沙箱提示/);
      // 是真的拦住了，而不是代码自己先报了错
      expect(text).not.toMatch(/NameError|SyntaxError/);
    });
  }

  it('被拦截的写入没有落盘', () => {
    runCode("import pathlib\npathlib.Path('pwned.txt').write_text('pwned', encoding='utf-8')", work);
    expect(existsSync(join(work, 'pwned.txt'))).toBe(false);
  });
});

d('code-exec · 临时目录不泄漏', () => {
  // 要连续启动 4 个 Python 进程：单独跑约 1.2 秒，但机器繁忙时（实测并行跑全量时）会超过默认的 5 秒上限 —
  // 那是进程启动慢，不是被测行为有问题，所以只放宽这条的时间上限，断言不变
  it('连续执行后临时目录下不留下 coral-code-* 残留', () => {
    // 本测试把 TEMP/TMP 指到了 work（见 runCode 的 env）— 残留只可能出现在这里，就数这里
    const count = () => readdirSync(work).filter(f => f.startsWith('coral-code-')).length;
    runCode('print(1)', work); // 预热
    const before = count();
    for (let i = 0; i < 3; i++) runCode(`print(${i})`, work);
    expect(count()).toBe(before);
  }, 60_000);
});

d('code-exec · 可信根目录的自检按结构判，不按长度判', () => {
  // 线上问题：自检曾要求可信根"长度不少于 12"。Linux 上系统自带的 Python，解释器目录就是 /usr 或 /usr/local
  //（长度 4 / 10）— 合法的可信根被判成异常，所有用系统 Python 的 Linux 用户都用不了代码执行。
  // 这个测试在 Windows 上也能验证那种情况：把前导脚本当模块加载，直接给它喂各种可信根组合。
  // （不能在沙箱里跑：沙箱里的代码读不了技能目录下的前导文件）
  const ROOTS_HARNESS = [
    'import importlib.util, json, os, sys',
    "spec = importlib.util.spec_from_file_location('sandbox_prelude_under_test', sys.argv[1])",
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    'sep = os.sep',
    'root = os.path.abspath(sep)',
    "base = root if root.endswith(sep) else root + sep",
    "short = base + 'usr'",
    'cases = [',
    "    ('system_prefix', {short}, True),",
    "    ('system_prefix_subdir', {short + sep + 'lib'}, True),",
    "    ('long_prefix', {base + 'tools' + sep + 'python311'}, True),",
    "    ('filesystem_root', {root}, False),",
    "    ('split_into_chars', set(sys.prefix), False),",
    "    ('root_without_separator', {root.rstrip(sep)}, False),",
    "    ('empty', {''}, False),",
    "    ('not_a_string', {None}, False),",
    ']',
    'out = {}',
    'for name, roots, expected in cases:',
    '    mod._TRUSTED_ROOTS = roots',
    '    sane, why = mod._roots_look_sane()',
    "    out[name] = {'sane': bool(sane), 'expected': expected, 'why': why, 'sample': sorted(str(r) for r in roots)[:3]}",
    'print(json.dumps(out))',
  ].join('\n');

  it('/usr、/usr/local 这类短前缀是合法的；文件系统根、被拆成单字符的列表、空值、非字符串都要拒绝', () => {
    const prelude = resolve(__dirname, '../../../../../skills/code-exec/scripts/sandbox_prelude.py');
    const harness = join(work, 'roots_harness.py');
    writeFileSync(harness, ROOTS_HARNESS, 'utf-8');
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const r = spawnSync(python, ['-I', harness, prelude], {
      encoding: 'utf-8',
      cwd: work,
      env: { PATH: process.env.PATH ?? '', PATHEXT: process.env.PATHEXT ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? '', PYTHONUTF8: '1' },
    });
    const out = JSON.parse(String(r.stdout ?? '').trim().split('\n').pop() ?? 'null');
    expect(out, r.stderr || String(r.stdout)).not.toBeNull();
    // 前提：这两个"短前缀"在本平台上确实短于 12 个字符，否则这个测试证明不了长度判据的问题
    expect(out.system_prefix.sample[0].length).toBeLessThan(12);
    expect(out.system_prefix_subdir.sample[0].length).toBeLessThan(12);
    for (const [name, v] of Object.entries<any>(out)) {
      expect(v.sane, `${name}: ${v.sample.join(' ')} → ${v.why}`).toBe(v.expected);
    }
  });
});
