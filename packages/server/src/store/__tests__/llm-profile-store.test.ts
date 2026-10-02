import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDb, type DB } from '../db.js';
import { LlmProfileStore } from '../llm-profile-store.js';
import type { LLMConfigProfile } from '../../types/index.js';

const tmp = mkdtempSync(join(tmpdir(), 'coral-llm-test-'));
let db: DB;

afterAll(() => {
  db?.close();
  rmSync(tmp, { recursive: true, force: true });
});

function makeStore(): LlmProfileStore {
  if (!db) db = createDb(join(tmp, 'llm.db'));
  return new LlmProfileStore(() => db);
}

function profile(overrides: Partial<LLMConfigProfile> = {}): LLMConfigProfile {
  return {
    profileId: 'p1',
    name: 'DashScope · kimi-k2.5',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    apiKey: 'sk-test-123456',
    model: 'kimi-k2.5',
    isActive: true,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

describe('LlmProfileStore — llm_profiles 表映射', () => {
  it('insert → getAll：isActive 布尔 ↔ is_active 整数往返', () => {
    const store = makeStore();
    store.insert(profile());
    store.insert(profile({ profileId: 'p2', name: '备用', isActive: false }));

    const all = store.getAll();
    expect(all).toHaveLength(2);
    const p1 = all.find(p => p.profileId === 'p1')!;
    expect(p1.isActive).toBe(true);
    expect(p1.apiKey).toBe('sk-test-123456');
    expect(all.find(p => p.profileId === 'p2')!.isActive).toBe(false);
  });

  it('update 部分合并（apiKey 留空保旧值的场景）', () => {
    const store = makeStore();
    const updated = store.update('p1', { name: '改名了', apiKey: 'sk-new-999' });
    expect(updated?.name).toBe('改名了');
    expect(updated?.apiKey).toBe('sk-new-999');
    expect(updated?.baseUrl).toBe('https://coding.dashscope.aliyuncs.com/v1');
    expect(store.get('p1')?.isActive).toBe(true); // 未动的字段保留

    expect(store.update('nope', { name: 'x' })).toBeNull();
  });

  it('delete + count + find', () => {
    const store = makeStore();
    expect(store.count()).toBe(2);
    expect(store.delete('p2')).toBe(true);
    expect(store.count()).toBe(1);
    expect(store.find(p => p.isActive).map(p => p.profileId)).toEqual(['p1']);
  });
});
