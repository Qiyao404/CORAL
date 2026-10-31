import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';

/**
 * 个性化服务 — "越用越懂你"的六个维度，全部默认关闭，用户在设置页按需开启。
 *
 * 设计原则（用户明确要求）：
 *  · 默认全关 — 不猜不准就别猜，猜错了体验比不猜更差
 *  · 设置页开关 — 用户自主选择哪些维度启用
 *  · 可随时清零 — 用户可以删除所有个性化数据
 *
 * 六个维度：
 *  1. interest_tags    动态兴趣标签（从用户搜索/提问中提取主题标签）
 *  2. style_adaptive   交互风格自适应（回答长度/格式/语气从纠正中学）
 *  3. rhythm_aware     工作节奏感知（按时段调整响应策略）
 *  4. knowledge_graph  跨会话知识图谱（关联不同会话中的概念）
 *  5. proactive        主动推荐（基于历史推荐下一步操作）
 *  6. implicit_prefs   隐式偏好推断（从拒绝/纠正行为中学，不问用户）
 */

export interface PersonalizationSettings {
  interestTags: boolean;
  styleAdaptive: boolean;
  rhythmAware: boolean;
  knowledgeGraph: boolean;
  proactive: boolean;
  implicitPrefs: boolean;
}

export interface InterestTag {
  tag: string;
  score: number;      // 递增权重
  lastSeen: string;   // ISO 时间
  source: string;     // "goal" | "search" | "file" | "correction"
}

export interface StyleProfile {
  avgAnswerLength: 'short' | 'medium' | 'long';
  prefersBullet: boolean;
  prefersTable: boolean;
  language: 'zh' | 'en' | 'mixed';
  formality: 'casual' | 'neutral' | 'formal';
  corrections: Array<{ issue: string; at: string }>;
}

export interface RhythmPattern {
  hourly: Record<number, number>;       // hour → count
  weekday: Record<number, number>;      // 0-6 → count
  avgSessionLength: number;             // minutes
}

export interface KnowledgeNode {
  concept: string;
  relatedTo: string[];
  sessionId: string;
  at: string;
}

export interface ImplicitPreference {
  key: string;
  value: string;
  evidence: string;
  confidence: number;
  at: string;
}

const DEFAULT_SETTINGS: PersonalizationSettings = {
  interestTags: false,
  styleAdaptive: false,
  rhythmAware: false,
  knowledgeGraph: false,
  proactive: false,
  implicitPrefs: false,
};

export class PersonalizationService {
  private dir: string;

  constructor(baseDir: string) {
    this.dir = join(resolve(baseDir), 'personalization');
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  // ─── 设置管理 ─────────────────────────────────────────────────────────────

  getSettings(): PersonalizationSettings {
    try {
      const p = join(this.dir, 'settings.json');
      if (!existsSync(p)) return { ...DEFAULT_SETTINGS };
      return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(p, 'utf-8')) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  updateSettings(patch: Partial<PersonalizationSettings>): PersonalizationSettings {
    const cur = this.getSettings();
    const next = { ...cur, ...patch };
    writeFileSync(join(this.dir, 'settings.json'), JSON.stringify(next, null, 2), 'utf-8');
    return next;
  }

  resetAll(): void {
    for (const f of ['interest-tags.json', 'style-profile.json', 'rhythm.json', 'knowledge-graph.json', 'implicit-prefs.json']) {
      try {
        const p = join(this.dir, f);
        if (existsSync(p)) writeFileSync(p, this.emptyFor(f), 'utf-8');
      } catch { /* ignore */ }
    }
  }

  private emptyFor(f: string): string {
    if (f.includes('interest')) return '[]';
    if (f.includes('style')) return JSON.stringify({ avgAnswerLength: 'medium', prefersBullet: false, prefersTable: false, language: 'zh', formality: 'neutral', corrections: [] });
    if (f.includes('rhythm')) return JSON.stringify({ hourly: {}, weekday: {}, avgSessionLength: 0 });
    if (f.includes('knowledge')) return '[]';
    if (f.includes('implicit')) return '[]';
    return '{}';
  }

  // ─── 1. 动态兴趣标签 ─────────────────────────────────────────────────────

  recordInterest(topic: string, source: string): void {
    if (!this.getSettings().interestTags) return;
    const tags = this.loadTags();
    const existing = tags.find(t => t.tag.toLowerCase() === topic.toLowerCase());
    if (existing) {
      existing.score = Math.min(100, existing.score + 1);
      existing.lastSeen = new Date().toISOString();
      existing.source = source;
    } else if (tags.length < 50) {
      tags.push({ tag: topic, score: 1, lastSeen: new Date().toISOString(), source });
    }
    writeFileSync(join(this.dir, 'interest-tags.json'), JSON.stringify(tags, null, 2), 'utf-8');
  }

  getTopTags(n = 5): InterestTag[] {
    return this.loadTags().sort((a, b) => b.score - a.score).slice(0, n);
  }

  /** 注入系统提示的兴趣标签文本（interestTags 开启时） */
  interestPrompt(): string {
    if (!this.getSettings().interestTags) return '';
    const tags = this.getTopTags(5);
    if (tags.length === 0) return '';
    return `## 用户兴趣领域（自动观察，仅供参考）\n用户近期关注：${tags.map(t => t.tag).join('、')}。回答时可以适当关联这些领域。`;
  }

  private loadTags(): InterestTag[] {
    try {
      const p = join(this.dir, 'interest-tags.json');
      if (!existsSync(p)) return [];
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch { return []; }
  }

  // ─── 2. 交互风格自适应 ───────────────────────────────────────────────────

  recordCorrection(issue: string): void {
    if (!this.getSettings().styleAdaptive) return;
    const profile = this.loadStyle();
    profile.corrections.push({ issue, at: new Date().toISOString() });
    // 从纠正中推断
    if (issue.includes('太长')) profile.avgAnswerLength = 'short';
    if (issue.includes('太短')) profile.avgAnswerLength = 'long';
    if (issue.includes('列表')) profile.prefersBullet = true;
    if (issue.includes('表格')) profile.prefersTable = true;
    if (issue.includes('口语')) profile.formality = 'formal';
    if (issue.includes('太正式')) profile.formality = 'casual';
    writeFileSync(join(this.dir, 'style-profile.json'), JSON.stringify(profile, null, 2), 'utf-8');
  }

  /** 注入系统提示的风格指引（styleAdaptive 开启时） */
  stylePrompt(): string {
    if (!this.getSettings().styleAdaptive) return '';
    const p = this.loadStyle();
    if (p.corrections.length === 0) return '';
    const parts: string[] = ['## 用户交互偏好（从历史纠正中学到）'];
    if (p.avgAnswerLength === 'short') parts.push('- 用户偏好简洁回答，控制在 200 字内');
    if (p.avgAnswerLength === 'long') parts.push('- 用户偏好详细回答，可以展开');
    if (p.prefersBullet) parts.push('- 用户偏好列表格式');
    if (p.prefersTable) parts.push('- 用户偏好表格格式');
    if (p.formality === 'casual') parts.push('- 用户偏好轻松语气');
    if (p.formality === 'formal') parts.push('- 用户偏好正式语气');
    return parts.length > 1 ? parts.join('\n') : '';
  }

  private loadStyle(): StyleProfile {
    try {
      const p = join(this.dir, 'style-profile.json');
      if (!existsSync(p)) return { avgAnswerLength: 'medium', prefersBullet: false, prefersTable: false, language: 'zh', formality: 'neutral', corrections: [] };
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      return { avgAnswerLength: 'medium', prefersBullet: false, prefersTable: false, language: 'zh', formality: 'neutral', corrections: [] };
    }
  }

  // ─── 3. 工作节奏感知 ─────────────────────────────────────────────────────

  recordActivity(): void {
    if (!this.getSettings().rhythmAware) return;
    const rhythm = this.loadRhythm();
    const now = new Date();
    const h = now.getHours();
    const d = now.getDay();
    rhythm.hourly[h] = (rhythm.hourly[h] ?? 0) + 1;
    rhythm.weekday[d] = (rhythm.weekday[d] ?? 0) + 1;
    writeFileSync(join(this.dir, 'rhythm.json'), JSON.stringify(rhythm, null, 2), 'utf-8');
  }

  /** 注入系统提示的节奏指引（rhythmAware 开启时） */
  rhythmPrompt(): string {
    if (!this.getSettings().rhythmAware) return '';
    const r = this.loadRhythm();
    const total = Object.values(r.hourly).reduce((a, b) => a + b, 0);
    if (total < 10) return ''; // 样本不足
    const peakHour = Object.entries(r.hourly).sort((a, b) => b[1] - a[1])[0]?.[0];
    return `## 用户工作节奏（自动观察）\n用户活跃高峰在 ${peakHour}:00 左右。当前时段的响应策略：简洁高效。`;
  }

  private loadRhythm(): RhythmPattern {
    try {
      const p = join(this.dir, 'rhythm.json');
      if (!existsSync(p)) return { hourly: {}, weekday: {}, avgSessionLength: 0 };
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch { return { hourly: {}, weekday: {}, avgSessionLength: 0 }; }
  }

  // ─── 4. 跨会话知识图谱 ───────────────────────────────────────────────────

  recordKnowledge(concept: string, relatedTo: string[], sessionId: string): void {
    if (!this.getSettings().knowledgeGraph) return;
    const nodes = this.loadKnowledge();
    const existing = nodes.find(n => n.concept.toLowerCase() === concept.toLowerCase());
    if (existing) {
      existing.relatedTo = [...new Set([...existing.relatedTo, ...relatedTo])];
      existing.at = new Date().toISOString();
    } else if (nodes.length < 200) {
      nodes.push({ concept, relatedTo, sessionId, at: new Date().toISOString() });
    }
    writeFileSync(join(this.dir, 'knowledge-graph.json'), JSON.stringify(nodes, null, 2), 'utf-8');
  }

  /** 注入系统提示的关联知识（knowledgeGraph 开启时） */
  knowledgePrompt(currentTopic: string): string {
    if (!this.getSettings().knowledgeGraph) return '';
    const nodes = this.loadKnowledge();
    const related = nodes.filter(n =>
      n.concept.toLowerCase().includes(currentTopic.toLowerCase()) ||
      n.relatedTo.some(r => r.toLowerCase().includes(currentTopic.toLowerCase()))
    ).slice(0, 5);
    if (related.length === 0) return '';
    return `## 相关知识背景（跨会话观察）\n用户之前讨论过与"${currentTopic}"相关的：${related.map(n => n.concept).join('、')}`;
  }

  private loadKnowledge(): KnowledgeNode[] {
    try {
      const p = join(this.dir, 'knowledge-graph.json');
      if (!existsSync(p)) return [];
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch { return []; }
  }

  // ─── 5. 主动推荐 ─────────────────────────────────────────────────────────

  /** 基于当前上下文推荐下一步操作（proactive 开启时） */
  proactiveSuggestion(context: string): string | null {
    if (!this.getSettings().proactive) return null;
    const tags = this.getTopTags(3);
    if (tags.length === 0) return null;
    // 简单启发式：根据兴趣标签推荐
    const t = tags[0].tag;
    if (context.includes('报告') || context.includes('总结')) return `需要我帮你把结果做成 PPT 或表格吗？`;
    if (context.includes('论文') || context.includes(t)) return `要建立${t}相关的文献库吗？`;
    return null;
  }

  // ─── 6. 隐式偏好推断 ─────────────────────────────────────────────────────

  recordImplicitPreference(key: string, value: string, evidence: string): void {
    if (!this.getSettings().implicitPrefs) return;
    const prefs = this.loadImplicitPrefs();
    const existing = prefs.find(p => p.key === key);
    if (existing) {
      existing.value = value;
      existing.evidence = evidence;
      existing.confidence = Math.min(1.0, existing.confidence + 0.1);
      existing.at = new Date().toISOString();
    } else if (prefs.length < 30) {
      prefs.push({ key, value, evidence, confidence: 0.5, at: new Date().toISOString() });
    }
    writeFileSync(join(this.dir, 'implicit-prefs.json'), JSON.stringify(prefs, null, 2), 'utf-8');
  }

  /** 注入系统提示的隐式偏好（implicitPrefs 开启且置信度 ≥0.7 时） */
  implicitPrompt(): string {
    if (!this.getSettings().implicitPrefs) return '';
    const prefs = this.loadImplicitPrefs().filter(p => p.confidence >= 0.7);
    if (prefs.length === 0) return '';
    const lines = prefs.map(p => `- ${p.key}: ${p.value}`);
    return `## 用户隐性偏好（从行为推断，高置信度）\n${lines.join('\n')}`;
  }

  private loadImplicitPrefs(): ImplicitPreference[] {
    try {
      const p = join(this.dir, 'implicit-prefs.json');
      if (!existsSync(p)) return [];
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch { return []; }
  }

  // ─── 组合注入（run-engine 每次构建系统提示时调用）──────────────────────

  /** 汇总所有已开启维度的注入文本 */
  buildInjection(goal: string): string {
    const parts = [
      this.interestPrompt(),
      this.stylePrompt(),
      this.rhythmPrompt(),
      this.knowledgePrompt(goal.slice(0, 50)),
      this.implicitPrompt(),
    ].filter(Boolean);
    return parts.length > 0 ? parts.join('\n\n') : '';
  }
}
