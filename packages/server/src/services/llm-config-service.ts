import { nanoid } from 'nanoid';
import { platformConfig, DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL, DEFAULT_LLM_PROFILE_NAME } from './config.js';
import { llmConfigStore } from '../store/index.js';
import type { LLMConfigProfile } from '../types/index.js';

interface SaveLlmConfigInput {
  profileId?: string;
  name: string;
  provider?: 'openai-compat' | 'anthropic';
  baseUrl: string;
  model: string;
  apiKey?: string;
  setActive?: boolean;
}

const LEGACY_HOSTNAMES = ['api.siliconflow.cn'];

function nowIso(): string {
  return new Date().toISOString();
}

function maskApiKey(apiKey: string): string {
  if (!apiKey) return '';
  if (apiKey.length <= 4) return '*'.repeat(apiKey.length);
  return apiKey.replace(/.(?=.{4})/g, '*');
}

function buildDefaultProfile(): LLMConfigProfile {
  const now = nowIso();
  return {
    profileId: nanoid(),
    name: platformConfig.llmProfileName || DEFAULT_LLM_PROFILE_NAME,
    provider: 'openai-compat',
    baseUrl: platformConfig.llmBaseUrl || DEFAULT_LLM_BASE_URL,
    apiKey: platformConfig.llmApiKey,
    model: platformConfig.llmModel || DEFAULT_LLM_MODEL,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * v1.1.0 启动迁移：
 *  · 若不存在任何配置 → 写入默认（来自 .env 的 dashscope coding · kimi-k2.5）
 *  · 若已有配置但全部是旧 SiliconFlow（v1.0.0 留下）→ 追加新 dashscope 配置并设为 active；
 *    旧配置保留不动（用户可手动激活回去）
 *  · 若已有 dashscope coding 配置 → 不重复添加
 *  · 若没有任何 active → 选最新更新时间设为 active
 */
export function ensureLlmConfigsInitialized(): void {
  const all = llmConfigStore.getAll();
  if (all.length === 0) {
    llmConfigStore.insert(buildDefaultProfile());
    return;
  }

  const hasActive = all.some(p => p.isActive);
  const desiredBase = (platformConfig.llmBaseUrl || DEFAULT_LLM_BASE_URL).trim();
  const desiredModel = (platformConfig.llmModel || DEFAULT_LLM_MODEL).trim();

  // 先检查是否已存在相同 baseUrl + model 的配置
  const desiredAlready = all.find(p =>
    p.baseUrl.trim() === desiredBase && p.model.trim() === desiredModel
  );

  // 全部都是旧的 SiliconFlow？需要迁移
  const allLegacy = all.every(p => LEGACY_HOSTNAMES.some(h => p.baseUrl.includes(h)));

  if (allLegacy && !desiredAlready) {
    const now = nowIso();
    // 把旧配置全部置为 inactive
    for (const item of all) {
      if (item.isActive) {
        llmConfigStore.update(item.profileId, { isActive: false, updatedAt: now });
      }
    }
    // 写入新 dashscope 配置并设为 active
    const fresh: LLMConfigProfile = {
      profileId: nanoid(),
      name: platformConfig.llmProfileName || DEFAULT_LLM_PROFILE_NAME,
      provider: 'openai-compat',
      baseUrl: desiredBase,
      apiKey: platformConfig.llmApiKey,
      model: desiredModel,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    llmConfigStore.insert(fresh);
    console.log(`[LLM 迁移] 检测到旧 SiliconFlow 配置，已自动加入 ${fresh.name} 并设为生效`);
    return;
  }

  if (!hasActive) {
    const latest = [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    llmConfigStore.update(latest.profileId, { isActive: true, updatedAt: nowIso() });
  }
}

export function getActiveLlmConfig(): LLMConfigProfile {
  ensureLlmConfigsInitialized();
  const active = llmConfigStore.getAll().find(p => p.isActive);
  if (active) return active;
  const fallback = buildDefaultProfile();
  llmConfigStore.insert(fallback);
  return fallback;
}

export function listLlmConfigs(): Array<Omit<LLMConfigProfile, 'apiKey'> & { apiKeyMasked: string; hasApiKey: boolean }> {
  ensureLlmConfigsInitialized();
  return llmConfigStore
    .getAll()
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.updatedAt.localeCompare(a.updatedAt))
    .map(profile => ({
      profileId: profile.profileId,
      name: profile.name,
      provider: profile.provider ?? 'openai-compat',
      baseUrl: profile.baseUrl,
      model: profile.model,
      isActive: profile.isActive,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      apiKeyMasked: maskApiKey(profile.apiKey),
      hasApiKey: Boolean(profile.apiKey),
    }));
}

export function saveLlmConfig(input: SaveLlmConfigInput): LLMConfigProfile {
  ensureLlmConfigsInitialized();
  const now = nowIso();

  if (input.profileId) {
    const existing = llmConfigStore.get(input.profileId);
    if (!existing) throw new Error('配置不存在');
    const nextApiKey = typeof input.apiKey === 'string' && input.apiKey.length > 0
      ? input.apiKey
      : existing.apiKey;
    const updated = llmConfigStore.update(existing.profileId, {
      name: input.name,
      provider: input.provider ?? existing.provider,
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey: nextApiKey,
      updatedAt: now,
    });
    if (!updated) throw new Error('配置保存失败');
    if (input.setActive) {
      return activateLlmConfig(updated.profileId);
    }
    return updated;
  }

  const profileId = nanoid();
  const all = llmConfigStore.getAll();
  const created: LLMConfigProfile = {
    profileId,
    name: input.name,
    provider: input.provider ?? 'openai-compat',
    baseUrl: input.baseUrl,
    model: input.model,
    apiKey: input.apiKey || '',
    isActive: all.length === 0 || Boolean(input.setActive),
    createdAt: now,
    updatedAt: now,
  };
  llmConfigStore.insert(created);

  if (created.isActive) {
    return activateLlmConfig(created.profileId);
  }
  return created;
}

export function activateLlmConfig(profileId: string): LLMConfigProfile {
  ensureLlmConfigsInitialized();
  const target = llmConfigStore.get(profileId);
  if (!target) throw new Error('配置不存在');

  const now = nowIso();
  for (const item of llmConfigStore.getAll()) {
    if (item.profileId !== profileId && item.isActive) {
      llmConfigStore.update(item.profileId, { isActive: false, updatedAt: now });
    }
  }

  const active = llmConfigStore.update(profileId, { isActive: true, updatedAt: now });
  if (!active) throw new Error('配置激活失败');
  return active;
}

export function deleteLlmConfig(profileId: string): { deletedId: string; nextActiveProfileId?: string } {
  ensureLlmConfigsInitialized();
  const all = llmConfigStore.getAll();
  if (all.length <= 1) throw new Error('至少保留一个配置');

  const target = llmConfigStore.get(profileId);
  if (!target) throw new Error('配置不存在');

  llmConfigStore.delete(profileId);

  if (!target.isActive) {
    return { deletedId: profileId };
  }

  const remaining = llmConfigStore.getAll().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const next = remaining[0];
  if (!next) {
    return { deletedId: profileId };
  }
  const activated = activateLlmConfig(next.profileId);
  return { deletedId: profileId, nextActiveProfileId: activated.profileId };
}
