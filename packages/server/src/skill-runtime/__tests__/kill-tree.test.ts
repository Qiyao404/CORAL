import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { platform } from 'os';
import { killProcessTree } from '../kill-tree.js';

/**
 * M0-2 / A11：验证进程树强杀真实生效。
 * 启动一个 30 秒的休眠子进程（模拟长跑脚本），killProcessTree 后应在数秒内退出。
 */
describe('killProcessTree（M0-2 A11 基础件）', () => {
  it('强杀长跑子进程（Windows: taskkill /T /F；POSIX: 进程组 SIGTERM）', async () => {
    const isWin = platform() === 'win32';
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
      detached: !isWin, // 与 skill-executor 的 spawn 参数保持一致（POSIX 需独立进程组）
    });

    // 确保子进程已启动
    await new Promise(r => setTimeout(r, 300));
    expect(child.exitCode).toBeNull();

    killProcessTree(child);

    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error('子进程在 5 秒内未被杀死')),
        5000
      );
      child.once('exit', () => {
        clearTimeout(deadline);
        resolve();
      });
    });
  }, 10000);

  it('对已退出的进程调用是安全的 no-op', () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    return new Promise<void>(resolve => {
      child.once('exit', () => {
        expect(() => killProcessTree(child)).not.toThrow();
        resolve();
      });
    });
  });
});
