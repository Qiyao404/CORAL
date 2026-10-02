import { describe, it, expect } from 'vitest';
import { buildSandboxEnv } from '../sandbox-env.js';

const BASE: Record<string, string | undefined> = {
  PATH: '/usr/bin',
  TEMP: '/tmp',
  LLM_API_KEY: 'sk-secret-should-not-leak',
  DATABASE_PATH: './data/coral.db',
  LLM_BASE_URL: 'https://coding.dashscope.aliyuncs.com/v1',
  OPENAI_API_KEY: 'sk-another-secret',
  HTTP_PROXY: 'http://127.0.0.1:7890',
  SYSTEMROOT: 'C:\\Windows',
  CORAL_SKILL_NAME: '宿主同名变量应被覆盖',
};

describe('buildSandboxEnv — 沙箱环境变量白名单（M0-6 / A13）', () => {
  const env = buildSandboxEnv({ name: 'my-skill' }, { taskId: 't1', agentId: 'a1' }, BASE);

  it('机密绝不透传（LLM key / 数据库路径等）', () => {
    expect(env.LLM_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.LLM_BASE_URL).toBeUndefined();
    expect(env.DATABASE_PATH).toBeUndefined();
  });

  it('运行时必需项透传', () => {
    expect(env.PATH).toBe('/usr/bin');
    expect(env.TEMP).toBe('/tmp');
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    expect(env.SYSTEMROOT).toBe('C:\\Windows');
  });

  it('白名单中存在但 baseEnv 没有的变量不出现', () => {
    expect(env.TMP).toBeUndefined();
    expect(env.APPDATA).toBeUndefined();
  });

  it('平台上下文以 CORAL_* 注入并覆盖宿主同名变量；Python 编码强制', () => {
    expect(env.CORAL_SKILL_NAME).toBe('my-skill');
    expect(env.CORAL_TASK_ID).toBe('t1');
    expect(env.CORAL_AGENT_ID).toBe('a1');
    expect(env.PYTHONIOENCODING).toBe('utf-8');
    expect(env.PYTHONUNBUFFERED).toBe('1');
  });

  it('空 baseEnv 也能产出最小可用环境（仅注入项）', () => {
    const minimal = buildSandboxEnv({ name: 'x' }, { taskId: 't', agentId: 'a' }, {});
    expect(Object.keys(minimal).sort()).toEqual(
      ['CORAL_AGENT_ID', 'CORAL_SKILL_NAME', 'CORAL_TASK_ID', 'PYTHONIOENCODING', 'PYTHONUNBUFFERED'].sort()
    );
  });
});
