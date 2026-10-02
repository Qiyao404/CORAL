import { spawnSync, type ChildProcess } from 'child_process';
import { platform } from 'os';

/**
 * 按进程组强杀子进程树（M0-2 — A11 的基础件，M0-3 超时强杀复用）：
 *  · Windows：taskkill /T /F —— executor 用 shell:true spawn 时 child.pid 是 shell，
 *    /T 连带杀掉整棵树（cmd → python）；无宽限直接强杀（console 进程对 WM_CLOSE 无响应）
 *  · POSIX：对进程组 SIGTERM（要求 spawn 时 detached: true），宽限后升级 SIGKILL
 */
export function killProcessTree(child: ChildProcess, gracefulMs = 5000): void {
  if (!child.pid || child.killed || child.exitCode !== null) return;

  if (platform() === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch { /* 尽力而为：进程可能已退出 */ }
    return;
  }

  const killGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, sig);
    } catch {
      try { child.kill(sig); } catch { /* 已退出 */ }
    }
  };

  killGroup('SIGTERM');
  const timer = setTimeout(() => killGroup('SIGKILL'), gracefulMs);
  timer.unref?.();
  child.once('close', () => clearTimeout(timer));
}
