import type { ParsedSkillManifest } from '../types/index.js';

/**
 * M0-6：脚本沙箱环境变量白名单（修复 A13 — v1 把宿主全量 process.env 泄给子进程，
 * 包括 LLM_API_KEY 等机密）。
 *
 * 原则：进程级隔离本就不是安全边界（脚本可读整个文件系统），白名单的意义在于
 * 不把机密「主动递给」脚本 — 防止脚本把环境变量打进日志 / 发给外部服务等意外泄漏。
 * 需要的变量由平台以 CORAL_* 前缀显式注入。
 */
const SANDBOX_ENV_WHITELIST: ReadonlySet<string> = new Set([
  // 运行时必需：可执行文件查找 / 临时目录 / Windows 系统变量
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP',
  'APPDATA', 'LOCALAPPDATA', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TZ',
  // 代理：脚本外呼网络需要（见 USE.md「代理友好」设计）
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  // CORAL 政策采集类 Skill 读取的扩展变量（.env）
  'POLICY_NO_PROXY_DOMAINS', 'POLICY_FORCE_DIRECT',
]);

export function buildSandboxEnv(
  manifest: Pick<ParsedSkillManifest, 'name'>,
  ctx: { taskId: string; agentId: string },
  baseEnv: Record<string, string | undefined> = process.env
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of SANDBOX_ENV_WHITELIST) {
    const value = baseEnv[key];
    if (value !== undefined) env[key] = value;
  }

  // 平台注入的上下文（显式前缀，脚本按需读取）
  env.CORAL_SKILL_NAME = manifest.name;
  env.CORAL_TASK_ID = ctx.taskId;
  env.CORAL_AGENT_ID = ctx.agentId;

  // Python 输出编码与无缓冲（stderr 实时进度协议依赖）
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUNBUFFERED = '1';

  return env;
}
