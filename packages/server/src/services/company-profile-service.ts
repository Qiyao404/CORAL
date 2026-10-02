import { resolve } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { eventBus } from '../event/event-bus.js';
import { PROJECT_ROOT } from './config.js';
import type { CompanyProfile } from '../types/index.js';

const PROFILE_PATH = resolve(PROJECT_ROOT, 'data', 'company_profile.json');

/** 默认画像种子（DESIGN §17.2） */
export const DEFAULT_COMPANY_PROFILE: CompanyProfile = {
  version: 1,
  companyName: '示例公司（请在设置中替换）',
  industries: ['制造业', '高新技术'],
  coreBusinesses: [
    '中试平台建设',
    '科技成果转化',
    '产业创新',
    '数字化转型',
  ],
  focusKeywords: [
    '中试',
    '概念验证中心',
    '科技成果转化',
    '机器人',
    '人工智能',
    '生物医药',
    '新材料',
    '技术改造',
    '专精特新',
    '首台套',
    '奖补',
    '专项资金',
  ],
  excludeKeywords: ['公示', '名单', '结果', '人事任命', '招标公告'],
  policyTypes: {
    keep: [
      '办法', '措施', '意见', '规划', '行动计划',
      '指引', '条例', '申报', '征集', '组织开展',
    ],
    exclude: ['公示', '名单', '拟认定', '通过', '通报'],
  },
  description: '',
  updatedAt: new Date().toISOString(),
};

let cache: CompanyProfile | null = null;

function ensureLoaded(): CompanyProfile {
  if (cache) return cache;
  try {
    if (existsSync(PROFILE_PATH)) {
      cache = JSON.parse(readFileSync(PROFILE_PATH, 'utf-8'));
      return cache!;
    }
  } catch {
    // 损坏的文件 → 用默认覆盖
  }
  cache = { ...DEFAULT_COMPANY_PROFILE, updatedAt: new Date().toISOString() };
  flush();
  return cache;
}

function flush(): void {
  if (!cache) return;
  const dir = resolve(PROJECT_ROOT, 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(PROFILE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

export function getCompanyProfile(): CompanyProfile {
  return ensureLoaded();
}

export function putCompanyProfile(input: Partial<CompanyProfile>): CompanyProfile {
  const current = ensureLoaded();
  const next: CompanyProfile = {
    ...current,
    ...input,
    version: (current.version || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  cache = next;
  flush();
  eventBus.emit('company_profile.updated', {
    version: next.version,
    companyName: next.companyName,
  });
  return next;
}

export function resetCompanyProfile(): CompanyProfile {
  cache = { ...DEFAULT_COMPANY_PROFILE, version: 1, updatedAt: new Date().toISOString() };
  flush();
  eventBus.emit('company_profile.updated', {
    version: cache.version,
    companyName: cache.companyName,
    reset: true,
  });
  return cache;
}

/**
 * 深合并：在任务级 override 下，列表会被「替换」而不是合并（避免漂移）
 * 简单字段以 override 为准。
 */
export function mergeCompanyProfile(
  base: CompanyProfile,
  override?: Partial<CompanyProfile>
): CompanyProfile {
  if (!override) return base;
  return {
    ...base,
    ...override,
    policyTypes: {
      ...base.policyTypes,
      ...(override.policyTypes || {}),
    },
  };
}
