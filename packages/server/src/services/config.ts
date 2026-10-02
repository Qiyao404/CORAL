import { config as dotenvConfig } from 'dotenv';
import { resolve, isAbsolute, dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import type { PlatformConfig } from '../types/index.js';

/**
 * 自动定位「项目根目录」：向上查找首个同时含 .env 与含 workspaces 字段的根 package.json
 * 这样无论从仓库根目录还是 packages/server 启动 npm 命令，都能正确找到 .env / skills/ / data/
 */
function findProjectRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  while (true) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const p = JSON.parse(readFileSync(pkg, 'utf-8'));
        if (p.workspaces || p.name === 'coral') return dir;
      } catch { /* */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export const PROJECT_ROOT = findProjectRoot();

dotenvConfig({ path: resolve(PROJECT_ROOT, '.env') });

function env(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function envInt(key: string, defaultValue: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : defaultValue;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const v = process.env[key];
  if (!v) return defaultValue;
  return v === 'true' || v === '1';
}

function resolveDir(value: string): string {
  if (isAbsolute(value)) return value;
  return resolve(PROJECT_ROOT, value);
}

/**
 * 默认 LLM 配置（v1.1.0 切换为：阿里云 DashScope Coding · kimi-k2.5）
 */
export const DEFAULT_LLM_BASE_URL = 'https://coding.dashscope.aliyuncs.com/v1';
export const DEFAULT_LLM_MODEL = 'kimi-k2.5';
export const DEFAULT_LLM_PROFILE_NAME = 'DashScope Coding · kimi-k2.5';

/** CORS 允许的来源（M0-6：白名单收敛，替代 v1 的 origin: true 全放行） */
function parseCorsOrigins(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

export function loadConfig(): PlatformConfig {
  return {
    port: envInt('PORT', 3001),
    host: env('HOST', '127.0.0.1'),
    databasePath: resolveDir(env('DATABASE_PATH', './data/coral.db')),
    llmBaseUrl: env('LLM_BASE_URL', DEFAULT_LLM_BASE_URL),
    llmApiKey: env('LLM_API_KEY', ''),
    llmModel: env('LLM_MODEL', DEFAULT_LLM_MODEL),
    llmProfileName: env('LLM_PROFILE_NAME', DEFAULT_LLM_PROFILE_NAME),
    llmMaxRetries: envInt('LLM_MAX_RETRIES', 2),
    llmRetryBaseDelayMs: envInt('LLM_RETRY_BASE_DELAY_MS', 500),
    demoMode: process.argv.includes('--demo') || envBool('CORAL_DEMO_MODE', false),
    shellToolEnabled: envBool('SHELL_TOOL_ENABLED', false),
    corsAllowedOrigins: parseCorsOrigins(
      env('CORS_ALLOWED_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173')
    ),
    skillsDir: resolveDir(env('SKILLS_DIR', './skills')),
    scenarioPacksDir: resolveDir(env('SCENARIO_PACKS_DIR', './scenario-packs')),
    skillWatcherDebounceMs: envInt('SKILL_WATCHER_DEBOUNCE_MS', 300),
    skillDefaultTimeoutMs: envInt('SKILL_DEFAULT_TIMEOUT_MS', 180000),
    sandboxMode: env('SANDBOX_MODE', 'process') as 'process' | 'docker',
    sandboxTimeoutMs: envInt('SANDBOX_TIMEOUT_MS', 30000),
    sandboxMemoryLimitMb: envInt('SANDBOX_MEMORY_LIMIT_MB', 256),
    sandboxNetworkEnabled: envBool('SANDBOX_NETWORK_ENABLED', true),
    maxConcurrentTasks: envInt('MAX_CONCURRENT_TASKS', 50),
    maxConcurrentAgentsPerTask: envInt('MAX_CONCURRENT_AGENTS_PER_TASK', 10),
    agentDefaultTimeoutMs: envInt('AGENT_DEFAULT_TIMEOUT_MS', 300000),
    agentMaxRetries: envInt('AGENT_MAX_RETRIES', 2),
    humanGateTimeoutMs: envInt('HUMAN_GATE_TIMEOUT_MS', 86400000),
    humanGateAutoReject: envBool('HUMAN_GATE_AUTO_REJECT', true),
  };
}

export const platformConfig = loadConfig();
