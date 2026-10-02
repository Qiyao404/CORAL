import { spawn } from 'child_process';
import { platform } from 'os';
import type { Tool, ToolResult } from '../types.js';
import { toolOk, toolError } from '../types.js';
import { killProcessTree } from '../../skill-runtime/kill-tree.js';
import { resolveWorkspacePath } from '../workspace-path.js';

/**
 * M1-2：内置 shell_run 工具（D13：默认关闭，SHELL_TOOL_ENABLED=true 显式开启）。
 * 每次执行都需审批（permission: approval）；超时按进程树强杀（复用 M0-2 的 kill-tree）。
 */

const MAX_OUTPUT_CHARS = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

export function makeShellTool(): Tool {
  return {
    name: 'shell_run',
    description:
      'Run a shell command (with the system shell) and return stdout/stderr and exit code. ' +
      'cwd defaults to the bound workspace. Output is capped at 64KB per stream. Requires approval.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Shell command line to execute' },
        cwd: { type: 'string', description: 'Working directory (relative to workspace, default workspace root)' },
        timeout_ms: { type: 'integer', description: `Timeout ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})` },
      },
    },
    source: 'builtin',
    permission: 'approval',

    async invoke(input: any, ctx): Promise<ToolResult> {
      const command = String(input?.command ?? '');
      if (!command.trim()) return toolError('BAD_INPUT', 'command 不能为空');

      let cwd: string | undefined;
      if (ctx.workspaceDir) {
        const r = resolveWorkspacePath(ctx.workspaceDir, String(input?.cwd ?? '.'));
        if (!r.ok) return toolError(r.code, r.message);
        cwd = r.absPath;
      }

      const timeoutMs = Math.min(Math.max(Number(input?.timeout_ms) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);

      return new Promise<ToolResult>((resolve) => {
        const isWin = platform() === 'win32';
        const child = spawn(command, {
          shell: true,
          cwd,
          detached: !isWin, // POSIX 独立进程组，取消/超时按组强杀
          windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;

        const timer = setTimeout(() => {
          timedOut = true;
          killProcessTree(child);
        }, timeoutMs);

        const onAbort = () => killProcessTree(child);
        ctx.signal.addEventListener('abort', onAbort, { once: true });

        const settle = (result: ToolResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          resolve(result);
        };

        child.stdout?.on('data', (d: Buffer) => {
          if (stdout.length < MAX_OUTPUT_CHARS) stdout += d.toString('utf-8');
        });
        child.stderr?.on('data', (d: Buffer) => {
          if (stderr.length < MAX_OUTPUT_CHARS) stderr += d.toString('utf-8');
        });

        child.on('close', (code) => {
          if (ctx.signal.aborted) {
            settle(toolError('CANCELLED', '命令已取消', false));
            return;
          }
          if (timedOut) {
            settle(toolError('SHELL_TIMEOUT', `命令超时（${timeoutMs}ms，进程树已强杀）`, true));
            return;
          }
          settle(toolOk({
            exitCode: code,
            stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
            stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
            stdoutTruncated: stdout.length >= MAX_OUTPUT_CHARS,
            stderrTruncated: stderr.length >= MAX_OUTPUT_CHARS,
          }));
        });

        child.on('error', (err) => {
          settle(toolError('SHELL_SPAWN_FAILED', `命令启动失败: ${err.message}`, false));
        });

        // shell 命令不接收 stdin
        child.stdin?.end();
      });
    },
  };
}
