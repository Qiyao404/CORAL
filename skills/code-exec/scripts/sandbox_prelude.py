# -*- coding: utf-8 -*-
"""code-exec 沙箱前导（REG-22）：先在解释器内部装上隔离措施，再执行用户代码。

为什么不是黑名单
    旧实现是一张 import 正则黑名单。`from os import environ`、`import pathlib`、
    `from subprocess import run`、`importlib.import_module('ctypes')` 这些写法全部绕过 —
    模型写的（或被网页/文档内容诱导写的）代码可以读写文件、读取环境变量、起子进程。

三层边界（每层都由真实探针验证过，不是凭文档想象）
  1. 审计钩子（不可移除）— 边界做在"动作"层：打开文件 / 起进程 / 连网络 / 加载动态库 /
     读注册表，不管经由哪个模块都会先经过 sys.audit，一律拒绝。它同时覆盖 `import` 语句
     路径与扩展模块的动态加载路径。
  2. 拒绝查找器 — importlib.import_module 这类纯 Python 查找路径**不触发任何审计事件**
     （3.9.6 实测），内建模块（winreg / _winapi）由此可被加载。在 sys.meta_path 最前面
     放一个按模块名拒绝的查找器；被摘除时由审计钩子在下一个事件上补回。
  3. 逐出 + 清环境 — 受限模块若已在 sys.modules 里就走"快路径"（同样没有审计事件），
     执行用户代码前一律逐出；环境变量只保留系统目录三项（Windows 会自动给新进程
     塞入用户名 / 主机名等身份变量，无法在启动时拒收，只能在这里清除）。

自检 fail-closed
    措施装好后先试探一批危险动作与导入路径；任何一项没被拦住 = 这个环境不支持沙箱 → 拒绝执行。

能力范围（如实声明）
    沙箱内可用 Python **标准库**的计算模块（math / statistics / datetime / json / csv / re /
    decimal / fractions / collections / pathlib 的纯路径运算 …）。numpy / pandas / scipy 等第三方库
    在导入时自身会加载 subprocess / ctypes，因此不可用（历史 447 次调用中用到它们的为 0 次）。

局限（如实声明）
    这是解释器级隔离，不是操作系统级容器。它防的是"模型被诱导去读写文件、发网络请求、
    起子进程"，不防熟悉 CPython 内部的人蓄意绕过；文件是否存在（os.stat）仍可探测；
    没有内存用量上限。需要更强隔离时应换成容器 / 虚拟机。
    可信根 = 解释器自身目录（含用户级 site-packages）：沙箱内代码可以只读打开这个目录。
    Windows 上它通常是一个独立的安装目录；Linux 上若用系统自带的 Python，则是 /usr 或 /usr/local —
    范围因此大一些（系统文件，本就对所有用户可读；用户自己的文件与密钥不在其中）。
"""
import os
import sys

EXIT_SANDBOX_UNAVAILABLE = 3
EXIT_VIOLATION = 4


class SandboxViolation(PermissionError):
    """代码触发了沙箱禁止的动作（PermissionError 的子类 — 上层按 OSError 兜底的逻辑不会被打破）"""


# ─── 允许的唯一一类文件访问：解释器为导入标准库/已安装包而只读打开自身目录 ───
# 范围 = 解释器目录 + 用户级 site-packages（pip install --user 装的包；与解释器自身同为用户装的可信代码）
_TRUSTED_ROOTS = {sys.prefix, sys.base_prefix, getattr(sys, 'exec_prefix', sys.prefix)}
try:
    import site as _site

    if getattr(_site, 'ENABLE_USER_SITE', False):
        # 注意返回类型：非隔离模式下它返回**字符串**，隔离模式下才可能是列表 —
        # 直接当可迭代对象遍历会把路径拆成一个个单字符"根"（实测多出 30 个单字符条目：
        # 路径脱敏被搅碎；这种短条目一旦规范化成真实前缀就是放行范围失控 — _roots_look_sane 专门拦它）
        user_site = _site.getusersitepackages()
        user_site_paths = [user_site] if isinstance(user_site, str) else list(user_site or [])
        _TRUSTED_ROOTS.update(p for p in user_site_paths if isinstance(p, str) and p)
except Exception:
    pass
_READONLY_PREFIXES = tuple(
    os.path.normcase(os.path.realpath(p)) + os.sep
    for p in sorted(_TRUSTED_ROOTS)
)


def _roots_look_sane():
    """可信根必须是"文件系统根之下的绝对路径"。

    按结构判，不按长度判。要拦的是会让白名单覆盖远超预期范围的条目：字符串被拆成的单个字符、
    不带斜杠的盘符（都不是绝对路径）；'/'、'C:\\' 这类文件系统根 — 宁可拒绝执行，
    也不能带着一份可疑的白名单放行文件读取。
    Linux 上系统自带的 Python，解释器目录就是 /usr 或 /usr/local（长度 4 / 10）：它们是合法的可信根，
    按长度卡会把所有用系统 Python 的 Linux 用户挡在门外。"""
    for p in _TRUSTED_ROOTS:
        if not isinstance(p, str) or not p or not os.path.isabs(p):
            return False, f'可信根目录异常: {p!r}'
        norm = os.path.normpath(p)
        if os.path.dirname(norm) == norm:
            return False, f'可信根目录异常（指向整个文件系统根）: {p!r}'
    return True, ''
_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND

# ─── 用户代码可见的环境变量（只留系统目录；其余 — 包括系统自动注入的身份变量 — 一律清除）──
_ENV_KEEP = frozenset({'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE'})


def _text(path):
    if isinstance(path, bytes):
        return path.decode('utf-8', 'replace')
    return path if isinstance(path, str) else None


def _norm(path):
    """规范化成可比较的绝对路径；无法解析返回 None"""
    try:
        return os.path.normcase(os.path.realpath(path)) + os.sep
    except Exception:
        return None


def _in_trusted_root(path):
    """路径是否落在解释器自身目录 / site-packages 内"""
    text = _text(path)
    if text is None:
        return False
    norm = _norm(text)
    return norm is not None and norm.startswith(_READONLY_PREFIXES)


def _is_runtime_read(path, mode, flags):
    """是否为解释器自身的只读打开（标准库导入）"""
    if not _in_trusted_root(path):
        return False
    if isinstance(flags, int) and flags & _WRITE_FLAGS:
        return False
    if isinstance(mode, str) and any(c in mode for c in 'wax+'):
        return False
    return True


def _short(path, limit=120):
    text = _text(path) or repr(path)
    return text if len(text) <= limit else text[:limit] + '…'


# ─── 第 1 层：拒绝的动作（审计事件名）────────────────────────────────────────
_DENIED_ACTIONS = frozenset({
    # 进程
    'os.system', 'os.fork', 'os.afork', 'os.exec', 'os.spawn', 'os.posix_spawn',
    'os.startfile', 'os.startfile/2', 'os.kill', 'subprocess.Popen',
    'pty.spawn', 'pty.fork', 'webbrowser.open',
    # 文件系统（打开文件单独判定）
    'os.remove', 'os.rename', 'os.rmdir', 'os.mkdir', 'os.link', 'os.symlink',
    'os.truncate', 'os.chmod', 'os.chown', 'os.utime',
    'os.listdir', 'os.scandir',
    'tempfile.mkstemp', 'tempfile.mkdtemp', 'tempfile.gettempdir',
    'mmap.__new__', 'urllib.Request',
    # 交互 / 调试器
    'builtins.input', 'builtins.breakpoint',
    # 注：code.__new__ / function.__new__ 不能拒绝 — 任何模块的加载与编译都会触发它们
})
_DENIED_ACTION_PREFIXES = (
    'socket.', 'ctypes.', 'winreg.', 'http.client.', 'http.server.',
    'ftplib.', 'smtplib.', 'shutil.', 'pdb.',
)

# ─── 拒绝导入的模块 ────────────────────────────────────────────────────────
# 整个包族都拒绝的"根名"
_DENIED_MODULE_ROOTS = frozenset({
    'ctypes', '_ctypes',
    'sqlite3', '_sqlite3', 'dbm', '_dbm', 'shelve',
    'winreg', '_winreg', '_winapi', 'msvcrt',
    'subprocess', 'multiprocessing', '_multiprocessing',
    'socket', '_socket', 'ssl',
    'ftplib', 'smtplib', 'telnetlib', 'poplib', 'imaplib', 'nntplib', 'xmlrpc',
    'asyncio',
    'pdb', 'webbrowser', 'pty', 'tty', 'curses', '_curses', 'tkinter', '_tkinter', 'getpass',
})
# 只拒绝包族里的特定子模块（其余子模块是纯计算，放行）
#   urllib.parse / urllib.error / http.cookies / http.HTTPStatus 不碰网络
_DENIED_MODULE_PREFIXES = ('urllib.request', 'urllib.robotparser', 'http.client', 'http.server')


def _is_denied_module(name):
    name = str(name or '')
    if name.split('.')[0] in _DENIED_MODULE_ROOTS:
        return True
    return any(name == p or name.startswith(p + '.') for p in _DENIED_MODULE_PREFIXES)


_DENIED_IMPORT_MARK = '沙箱禁止导入模块'

# 最近一次拦截（供报错时附带解释：标准库常把 PermissionError 吞掉再抛别的异常，
# 比如 tempfile 建不了临时文件最终抛 FileNotFoundError — 模型看不出这是沙箱拦的）
_LAST_DENIAL = None


def _denied_import_error(name):
    name = str(name or '')
    return ImportError(
        f'{_DENIED_IMPORT_MARK} {name}（文件/网络/子进程/系统接口不在 code-exec 的能力范围内）。'
        f'如果是 import {name.split(".")[0]} 这类第三方库在导入时触发的：沙箱内只支持标准库计算模块，'
        '请改用 json/csv/statistics/datetime/decimal/fractions/math 等。'
    )


_ACTION_LABELS = {
    'open': '文件读写',
    'os.listdir': '列目录', 'os.scandir': '列目录',
    'subprocess.Popen': '起子进程', 'os.system': '执行系统命令',
}


def _deny(event, detail=''):
    global _LAST_DENIAL
    label = _ACTION_LABELS.get(event)
    if label is None:
        label = next((f'{p[:-1]} 相关操作' for p in _DENIED_ACTION_PREFIXES if event.startswith(p)), event)
    _LAST_DENIAL = f'沙箱禁止的操作：{label}{f"（{detail}）" if detail else ""}'
    raise SandboxViolation(
        f'{_LAST_DENIAL}。code-exec 只允许纯计算 — 不读写文件、不联网、不起子进程、不碰系统设置。'
    )


# ─── 第 2 层：拒绝查找器 ───────────────────────────────────────────────────
class _DenyFinder:
    """导入查找器链最前面的按名拒绝查找器。只抛 ImportError、不加载任何东西。"""

    def find_spec(self, fullname, path=None, target=None):
        if _is_denied_module(fullname):
            raise _denied_import_error(fullname)
        return None


_DENY_FINDER = _DenyFinder()


def _ensure_guard():
    """查找器若被用户代码摘除，在下一个审计事件上补回（审计钩子本身不可移除）"""
    for finder in sys.meta_path:
        if finder is _DENY_FINDER:
            return
    sys.meta_path.insert(0, _DENY_FINDER)


def _audit(event, args):
    global _LAST_DENIAL
    _ensure_guard()
    if event == 'open':
        path = args[0] if args else None
        mode = args[1] if len(args) > 1 else None
        flags = args[2] if len(args) > 2 else None
        if _is_runtime_read(path, mode, flags):
            return
        _deny('open', _short(path))
        return
    if event == 'import':
        name = args[0] if args else ''
        if _is_denied_module(name):
            _LAST_DENIAL = f'{_DENIED_IMPORT_MARK} {name}'
            raise _denied_import_error(name)
        return
    if event in ('os.listdir', 'os.scandir'):
        # 导入带子模块的包（json.decoder / urllib.parse …）时，解释器要列出包目录的内容 —
        # 与"只读打开"同一条规则：只在解释器自身目录 / site-packages 内放行
        path = args[0] if args else None
        if path is not None and _in_trusted_root(path):
            return
        _deny(event, _short(path) if path is not None else '当前目录')
        return
    if event in _DENIED_ACTIONS or event.startswith(_DENIED_ACTION_PREFIXES):
        _deny(event)


# ─── 第 3 层：逐出受限模块 + 清环境 ────────────────────────────────────────
_RESTRICTED_LOADED = (
    'ctypes', '_ctypes', 'sqlite3', '_sqlite3', 'winreg', '_winreg', '_winapi', 'msvcrt',
    'socket', '_socket', 'subprocess', 'ssl', 'asyncio',
)


def _evict_restricted_modules():
    """已导入的模块不会再触发 import 审计事件（快路径）— 留着就等于留了一条不经审计的
    取用路径；逐出后再有人 import 必然经过审计钩子或拒绝查找器。"""
    for name in _RESTRICTED_LOADED:
        sys.modules.pop(name, None)


def _scrub_environment():
    for key in list(os.environ):
        if key.upper() not in _ENV_KEEP:
            os.environ.pop(key, None)


# ─── 自检（fail-closed）：措施装好后，危险动作与导入路径必须真的被拦 ───────────
def _load_probe_modules():
    """探测 socket / subprocess 的"动作级"拦截需要它们在场；必须在装钩子**之前**导入。
    （ctypes 不做动作级探测：实测 3.9.6 上 ctypes.windll.* 不触发任何审计事件，
    唯一安全的处理是绝不让它进进程 — 由导入层的两道防线负责）"""
    modules = {}
    for name in ('socket', 'subprocess'):
        try:
            modules[name] = __import__(name)
        except Exception:
            modules[name] = None  # 这个解释器里没有该模块 = 没有这项能力，无需探测
    return modules


_PROBE_MODULES = _load_probe_modules()


def _selfcheck(user_file):
    import importlib

    socket_mod, subprocess_mod = _PROBE_MODULES['socket'], _PROBE_MODULES['subprocess']
    # 系统目录里的一个文件（与解释器同盘：专门抓"可信根被拆成盘符/单字符 → 整盘可读"这类事故）
    win_ini = os.path.join(os.environ.get('SYSTEMROOT', os.sep.join(['C:', 'Windows'])), 'win.ini')

    probes = [
        # 动作层
        ('写入文件', lambda: open('coral-sandbox-probe.txt', 'w', encoding='utf-8')),
        ('读取任意文件', lambda: open(__file__, 'r', encoding='utf-8')),
        ('读取当前目录下的文件（字符串路径）', lambda: open(user_file, 'r', encoding='utf-8')),
        ('读取系统目录文件（字符串路径）', lambda: open(win_ini, 'r', encoding='utf-8', errors='ignore')),
        ('列目录', lambda: os.listdir('.')),
        ('删除文件', lambda: os.remove('coral-sandbox-probe-nonexistent')),
        # 导入层 — 语句路径（审计钩子）
        ('import 语句加载 ctypes', lambda: __import__('ctypes')),
        ('import 语句加载 sqlite3', lambda: __import__('sqlite3')),
        # 导入层 — 查找器路径（importlib 不触发审计事件，只能靠拒绝查找器）
        ('importlib 加载 ctypes', lambda: importlib.import_module('ctypes')),
    ]
    if sys.platform.startswith('win'):
        probes.append(('importlib 加载 winreg', lambda: importlib.import_module('winreg')))
    if socket_mod is not None:
        probes.append(('绑定端口', lambda: socket_mod.socket().bind(('127.0.0.1', 0))))
    if subprocess_mod is not None:
        probes.append(('起子进程', lambda: subprocess_mod.Popen([sys.executable, '-c', 'pass'])))

    for name, probe in probes:
        try:
            probe()
        except (SandboxViolation, ImportError):
            continue
        except Exception:
            # 钩子之外的异常（例如端口占用）不能当作"已拦截"
            pass
        print(f'SANDBOX_UNAVAILABLE: 自检未通过 — "{name}" 没有被拦截', file=sys.stderr)
        return EXIT_SANDBOX_UNAVAILABLE
    return 0


def _is_denial(exc):
    return isinstance(exc, SandboxViolation) or (
        isinstance(exc, ImportError) and str(exc).startswith(_DENIED_IMPORT_MARK)
    )


def _reset_denial():
    global _LAST_DENIAL
    _LAST_DENIAL = None


def _print_user_traceback():
    """只打印用户代码的报错栈：跳过前导自身与导入系统的帧，并把解释器目录路径抹成 <python> —
    既不让模型把沙箱内部路径 / 用户名 / 临时目录读进上下文，也让第一行就是出错的位置"""
    import re
    import traceback

    exc_type, exc_value, tb = sys.exc_info()
    while tb is not None and (tb.tb_frame.f_code.co_filename == __file__ or tb.tb_frame.f_code.co_filename.startswith('<frozen')):
        tb = tb.tb_next
    text = ''.join(traceback.format_exception(exc_type, exc_value, tb or None))
    # 字面量替换（不用正则）：可信根是普通路径，正则的转义/忽略大小写在这里没有任何好处
    for root in sorted(_TRUSTED_ROOTS, key=len, reverse=True):
        text = text.replace(str(root), '<python>').replace(str(root).lower(), '<python>').replace(str(root).upper(), '<python>')
    sys.stderr.write(text)
    # 标准库常把 PermissionError 吞掉再抛别的异常（tempfile → FileNotFoundError）：
    # 如果报错前一刻发生过拦截，把原因附上 — 模型才知道这是沙箱的限制而不是代码 bug
    if _LAST_DENIAL and isinstance(exc_value, OSError) and not _is_denial(exc_value):
        sys.stderr.write(f'沙箱提示：这次报错很可能是因为沙箱拦截了「{_LAST_DENIAL}」。code-exec 只允许纯计算。\n')


def main(argv):
    if not hasattr(sys, 'addaudithook'):
        print('SANDBOX_UNAVAILABLE: 需要 Python 3.8+（审计钩子）', file=sys.stderr)
        return EXIT_SANDBOX_UNAVAILABLE
    if len(argv) < 2:
        print('SANDBOX_UNAVAILABLE: 缺少待执行代码文件', file=sys.stderr)
        return EXIT_SANDBOX_UNAVAILABLE
    path = argv[1]
    with open(path, 'r', encoding='utf-8') as f:  # 装措施之前读入（此后任何文件访问都会被拒）
        source = f.read()
    try:
        code = compile(source, path, 'exec')
    except (SyntaxError, ValueError):
        import traceback
        traceback.print_exc()
        return 1

    # 可信根先过目：白名单里混进短条目 = 放行范围失控 — 带着它执行等于没有沙箱
    sane, why = _roots_look_sane()
    if not sane:
        print(f'SANDBOX_UNAVAILABLE: {why}', file=sys.stderr)
        return EXIT_SANDBOX_UNAVAILABLE

    _evict_restricted_modules()
    _ensure_guard()
    sys.addaudithook(_audit)
    unavailable = _selfcheck(path)
    if unavailable:
        return unavailable
    _evict_restricted_modules()  # 自检把 socket/subprocess 导进来了 — 用户代码执行前逐出
    _scrub_environment()
    _reset_denial()  # 自检故意触发的拦截不算数 — 报错解释只看用户代码自己触发的拦截

    globs = {'__name__': '__main__', '__file__': path, '__builtins__': __builtins__}
    sys.argv = [path]
    try:
        exec(code, globs)
    except SystemExit as exc:
        if exc.code is None:
            return 0
        return exc.code if isinstance(exc.code, int) else 1
    except BaseException as exc:
        if _is_denial(exc):
            # 沙箱拒绝的动作/导入按"越界"报告（带改法指引），而不是当成普通 Python 报错甩一段 traceback
            print(f'SANDBOX_VIOLATION: {exc}', file=sys.stderr)
            return EXIT_VIOLATION
        _print_user_traceback()
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
