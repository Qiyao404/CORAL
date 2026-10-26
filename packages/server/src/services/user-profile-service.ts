import { resolve } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { PROJECT_ROOT } from './config.js';
import type { UserProfile } from '../types/index.js';

/**
 * 个人画像（原公司画像 → 个人画像，开源个人轻量级定位）。
 *
 * 与长期记忆的分工：
 *  · 长期记忆（memory/）= 事实条目（"用户喜欢表格"）— Agent 主动记忆/检索
 *  · 个人画像（user_profile.json）= 结构化偏好（字段化、LLM 提示注入、Settings 页编辑）
 *
 * 个人画像通过 distillMemory 自动丰富 — 每次会话结束 LLM 提炼用户特征，
 * 越聊越懂用户（不断进化），同时用户可在设置页手动编辑。
 */

const PROFILE_PATH = resolve(PROJECT_ROOT, 'data', 'user_profile.json');

/** 默认画像种子（首次启动） */
export const DEFAULT_USER_PROFILE: UserProfile = {
  version: 2,
  name: '',
  role: '',
  interests: [],
  expertise: [],
  workStyle: {
    outputFormat: '',
    language: '',
    detailLevel: '',
    tone: '',
  },
  preferences: {
    likeKeywords: [],
    avoidKeywords: [],
    preferredTools: [],
  },
  background: '',
  goals: [],
  updatedAt: new Date().toISOString(),
};

export function getUserProfile(): UserProfile {
  if (!existsSync(PROFILE_PATH)) return { ...DEFAULT_USER_PROFILE };
  try {
    const raw = readFileSync(PROFILE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    // 旧版（公司画像）自动迁移：保留可映射字段
    if (parsed.version === 1) {
      return migrateFromCompany(parsed);
    }
    return { ...DEFAULT_USER_PROFILE, ...parsed };
  } catch {
    return { ...DEFAULT_USER_PROFILE };
  }
}

export function putUserProfile(patch: Partial<UserProfile>): UserProfile {
  const current = getUserProfile();
  const next: UserProfile = {
    ...current,
    ...patch,
    version: 2,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(resolve(PROFILE_PATH, '..'), { recursive: true });
  writeFileSync(PROFILE_PATH, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

export function resetUserProfile(): UserProfile {
  writeFileSync(PROFILE_PATH, JSON.stringify(DEFAULT_USER_PROFILE, null, 2), 'utf-8');
  return { ...DEFAULT_USER_PROFILE };
}

/** 从旧公司画像迁移（v1 → v2） */
function migrateFromCompany(old: any): UserProfile {
  return {
    ...DEFAULT_USER_PROFILE,
    name: old.companyName ?? '',
    interests: old.industries ?? [],
    expertise: old.coreBusinesses ?? [],
    preferences: {
      ...DEFAULT_USER_PROFILE.preferences,
      likeKeywords: old.focusKeywords ?? [],
      avoidKeywords: old.excludeKeywords ?? [],
    },
    background: old.description ?? '',
  };
}

/**
 * 个人画像 → 系统提示注入文本（Agent 越来越了解用户的数据源）
 * 供 run-engine 在每次 LLM 调用时注入
 */
export function userProfileToPrompt(profile: UserProfile): string {
  const parts: string[] = [];
  if (profile.name) parts.push(`- Name: ${profile.name}`);
  if (profile.role) parts.push(`- Role: ${profile.role}`);
  if (profile.interests.length > 0) parts.push(`- Interests: ${profile.interests.join(', ')}`);
  if (profile.expertise.length > 0) parts.push(`- Expertise: ${profile.expertise.join(', ')}`);
  if (profile.background) parts.push(`- Background: ${profile.background}`);
  if (profile.goals.length > 0) parts.push(`- Goals: ${profile.goals.join('; ')}`);
  const ws = profile.workStyle;
  const wsParts: string[] = [];
  if (ws.outputFormat) wsParts.push(`output format: ${ws.outputFormat}`);
  if (ws.language) wsParts.push(`language: ${ws.language}`);
  if (ws.detailLevel) wsParts.push(`detail level: ${ws.detailLevel}`);
  if (ws.tone) wsParts.push(`tone: ${ws.tone}`);
  if (wsParts.length > 0) parts.push(`- Work style: ${wsParts.join(', ')}`);
  if (profile.preferences.likeKeywords.length > 0) parts.push(`- Likes: ${profile.preferences.likeKeywords.join(', ')}`);
  if (profile.preferences.avoidKeywords.length > 0) parts.push(`- Avoids: ${profile.preferences.avoidKeywords.join(', ')}`);

  if (parts.length === 0) return '';
  return `## User Profile (learned from conversations — adapt your responses accordingly)\n${parts.join('\n')}`;
}

/**
 * 从 distill 输出更新个人画像（LLM 提炼的用户特征自动丰富画像）
 */
export function enrichUserProfileFromDistill(
  insights: Array<{ field: string; value: string }>
): boolean {
  if (insights.length === 0) return false;
  const profile = getUserProfile();
  let changed = false;
  for (const { field, value } of insights) {
    const v = value.trim().slice(0, 200);
    if (!v) continue;
    switch (field) {
      case 'name':
        if (!profile.name) { profile.name = v; changed = true; }
        break;
      case 'role':
        if (!profile.role || profile.role !== v) { profile.role = v; changed = true; }
        break;
      case 'interest':
        if (!profile.interests.includes(v) && profile.interests.length < 20) {
          profile.interests.push(v); changed = true;
        }
        break;
      case 'expertise':
        if (!profile.expertise.includes(v) && profile.expertise.length < 20) {
          profile.expertise.push(v); changed = true;
        }
        break;
      case 'output_format':
        if (profile.workStyle.outputFormat !== v) { profile.workStyle.outputFormat = v; changed = true; }
        break;
      case 'language':
        if (profile.workStyle.language !== v) { profile.workStyle.language = v; changed = true; }
        break;
      case 'detail_level':
        if (profile.workStyle.detailLevel !== v) { profile.workStyle.detailLevel = v; changed = true; }
        break;
      case 'tone':
        if (profile.workStyle.tone !== v) { profile.workStyle.tone = v; changed = true; }
        break;
      case 'goal':
        if (!profile.goals.includes(v) && profile.goals.length < 10) {
          profile.goals.push(v); changed = true;
        }
        break;
    }
  }
  if (changed) {
    profile.updatedAt = new Date().toISOString();
    mkdirSync(resolve(PROFILE_PATH, '..'), { recursive: true });
    writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2), 'utf-8');
  }
  return changed;
}
