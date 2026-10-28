import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, renameSync } from 'fs';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';

/**
 * 习惯学习管线 — 观察 → 蒸馏 → 置信度强化 → 晋升技能。
 *
 * 三级资产（全部本地文件，透明可编辑）：
 *  · data/habits/observations.jsonl — 追加式观察日志（每次工具调用的确定性记录；
 *    事件是 100% 确定的，这比"让模型自己总结习惯"可靠得多）
 *  · data/habits/habits.json — 习惯库：{trigger, action, confidence, sessions, evidence}
 *  · 晋升产物 — skills/ 目录下由 habit 生成的 SKILL.md（走 skill-writer 原子写）
 *
 * 置信度协议：
 *  · 新习惯 0.3（试探级 — 只出现在蒸馏报告里，不注入提示）
 *  · ≥0.5 出现在提示的"建议"区；≥0.7 自动注入（自动应用级）；0.9 封顶（核心习惯）
 *  · 同一习惯再次被观察且未被纠正 → +0.1；连续 30 天未被观察 → 蒸馏时 -0.1；<0.2 淘汰
 *
 * 防污染（跨项目泛化守卫）：
 *  · 晋升为技能要求 置信度 ≥0.8 且出现在 ≥2 个不同会话 — 单会话的巧合不配成为技能
 */

export interface HabitObservation {
  at: string;
  runId: string;
  sessionId: string;
  agentId: string;
  tool: string;
  ok: boolean;
  /** 工具输入预览（模式识别的原料） */
  inputPreview: string;
  goalPreview: string;
}

export interface Habit {
  id: string;
  /** 触发条件（何时） */
  trigger: string;
  /** 行动（做什么） */
  action: string;
  confidence: number;
  /** 观察到该习惯的会话集合（防污染：晋升需 ≥2） */
  sessions: string[];
  /** 证据（观察摘要，最多 6 条） */
  evidence: string[];
  createdAt: string;
  updatedAt: string;
  /** promoted 后记录生成的技能名 */
  promotedSkill?: string;
}

interface HabitStore {
  habits: Habit[];
  meta: { lastDistillAt: string; distillCount: number };
}

const OBS_ROTATE_BYTES = 2 * 1024 * 1024;
const OBS_TAIL_LINES = 400;
const MAX_HABITS = 40;

function nowIso(): string {
  return new Date().toISOString();
}

function newHabitId(): string {
  return `hb-${randomBytes(4).toString('hex')}`;
}

/** 触发相似度：归一化后词集合重合 ≥60% 视为同一习惯 */
function similarTrigger(a: string, b: string): boolean {
  const wa = new Set(normalizeWords(a));
  const wb = new Set(normalizeWords(b));
  if (wa.size === 0 || wb.size === 0) return false;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / Math.min(wa.size, wb.size) >= 0.6;
}

function normalizeWords(s: string): string[] {
  return String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 1);
}

export class HabitService {
  private dir: string;
  private obsPath: string;
  private habitsPath: string;

  constructor(baseDir: string) {
    this.dir = resolve(baseDir, 'habits');
    this.obsPath = join(this.dir, 'observations.jsonl');
    this.habitsPath = join(this.dir, 'habits.json');
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  // ─── 观察（写入端：run-engine 事件流回调）───────────────────────────────

  /** 记录一次工具观察（追加 JSONL；超 2MB 轮转保留尾部） */
  observe(obs: Omit<HabitObservation, 'at'>): void {
    try {
      this.ensureDir();
      if (existsSync(this.obsPath) && statSync(this.obsPath).size > OBS_ROTATE_BYTES) {
        const lines = readFileSync(this.obsPath, 'utf-8').split('\n').filter(Boolean);
        writeFileSync(this.obsPath, lines.slice(-OBS_TAIL_LINES).join('\n') + '\n', 'utf-8');
      }
      appendFileSync(this.obsPath, JSON.stringify({ ...obs, at: nowIso() }) + '\n', 'utf-8');
    } catch { /* 观察失败绝不影响 run */ }
  }

  /** 自上次蒸馏以来的观察条数（决定是否触发自动蒸馏） */
  observationsSinceLastDistill(): number {
    try {
      if (!existsSync(this.obsPath)) return 0;
      const store = this.loadStore();
      const lines = readFileSync(this.obsPath, 'utf-8').split('\n').filter(Boolean);
      if (!store.meta.lastDistillAt) return lines.length;
      let count = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const o = JSON.parse(lines[i]);
          if (o.at <= store.meta.lastDistillAt) break;
          count++;
        } catch { break; }
      }
      return count;
    } catch {
      return 0;
    }
  }

  private recentObservations(max = 200): HabitObservation[] {
    try {
      if (!existsSync(this.obsPath)) return [];
      const lines = readFileSync(this.obsPath, 'utf-8').split('\n').filter(Boolean);
      return lines.slice(-max).map(l => {
        try { return JSON.parse(l) as HabitObservation; } catch { return null; }
      }).filter((x): x is HabitObservation => Boolean(x));
    } catch {
      return [];
    }
  }

  // ─── 习惯库 ─────────────────────────────────────────────────────────────

  private loadStore(): HabitStore {
    try {
      if (!existsSync(this.habitsPath)) return { habits: [], meta: { lastDistillAt: '', distillCount: 0 } };
      const parsed = JSON.parse(readFileSync(this.habitsPath, 'utf-8'));
      return {
        habits: Array.isArray(parsed.habits) ? parsed.habits : [],
        meta: parsed.meta ?? { lastDistillAt: '', distillCount: 0 },
      };
    } catch {
      return { habits: [], meta: { lastDistillAt: '', distillCount: 0 } };
    }
  }

  private saveStore(store: HabitStore): void {
    this.ensureDir();
    store.habits = store.habits.slice(0, MAX_HABITS);
    writeFileSync(this.habitsPath, JSON.stringify(store, null, 2), 'utf-8');
  }

  list(): Habit[] {
    return this.loadStore().habits;
  }

  get(id: string): Habit | null {
    return this.loadStore().habits.find(h => h.id === id) ?? null;
  }

  /**
   * 蒸馏：把近期观察交给 LLM 找重复模式 → 新建或强化习惯。
   * 返回变更摘要（供事件/API）；失败静默（学习失败不影响主流程）。
   */
  async distill(
    llm: { complete(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, options?: any): Promise<{ content: string }> },
    currentSessionId?: string
  ): Promise<{ created: number; reinforced: number; decayed: number; removed: number; promotedReady: string[] }> {
    const obs = this.recentObservations();
    if (obs.length < 10) {
      return { created: 0, reinforced: 0, decayed: 0, removed: 0, promotedReady: [] };
    }
    const store = this.loadStore();

    // LLM 蒸馏候选
    const candidates = await this.llmDistill(llm, obs, store.habits).catch(() => []);

    let created = 0;
    let reinforced = 0;
    for (const c of candidates) {
      const existing = store.habits.find(h => similarTrigger(h.trigger, c.trigger));
      if (existing) {
        // toFixed 消除浮点累积（0.3+0.1×5 ≠ 0.8 的世界）
        existing.confidence = Math.min(0.9, Number((existing.confidence + 0.1).toFixed(2)));
        existing.evidence = [...existing.evidence, c.evidence].slice(-6);
        existing.updatedAt = nowIso();
        if (currentSessionId && !existing.sessions.includes(currentSessionId)) {
          existing.sessions.push(currentSessionId);
        }
        reinforced++;
      } else {
        store.habits.push({
          id: newHabitId(),
          trigger: c.trigger.slice(0, 200),
          action: c.action.slice(0, 300),
          confidence: 0.3,
          sessions: currentSessionId ? [currentSessionId] : [],
          evidence: [c.evidence].slice(0, 6),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
        created++;
      }
    }

    // 衰减与淘汰：30 天未更新 -0.1；<0.2 淘汰
    const cutoff = Date.now() - 30 * 86_400_000;
    let decayed = 0;
    let removed = 0;
    store.habits = store.habits.filter(h => {
      if (h.promotedSkill) return true; // 已晋升的保留（技能接管了行为）
      if (Date.parse(h.updatedAt) < cutoff) {
        h.confidence -= 0.1;
        decayed++;
        if (h.confidence < 0.2) { removed++; return false; }
      }
      return true;
    });

    store.meta = { lastDistillAt: nowIso(), distillCount: store.meta.distillCount + 1 };
    this.saveStore(store);

    const promotedReady = store.habits
      .filter(h => !h.promotedSkill && h.confidence >= 0.8 && h.sessions.length >= 2)
      .map(h => h.id);
    return { created, reinforced, decayed, removed, promotedReady };
  }

  private async llmDistill(
    llm: { complete(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, options?: any): Promise<{ content: string }> },
    obs: HabitObservation[],
    existing: Habit[]
  ): Promise<Array<{ trigger: string; action: string; evidence: string }>> {
    const obsText = obs
      .map(o => `[${o.at.slice(0, 16)}] goal="${o.goalPreview.slice(0, 60)}" tool=${o.tool} ok=${o.ok} input=${o.inputPreview.slice(0, 80)}`)
      .join('\n')
      .slice(0, 30_000);
    const existingText = existing.map(h => `- "${h.trigger}" → ${h.action}`).join('\n') || '(none)';
    const res = await llm.complete(
      [
        {
          role: 'system',
          content:
            `You distill recurring WORK HABITS from an agent's tool-call observations. A habit is a repeated trigger→action pattern worth applying automatically, e.g. "when summarizing .docx files → use docx_read, not fs_read" or "when user asks for comparison → produce a table".\n` +
            `Rules:\n- Only report patterns seen at least twice in the observations.\n- Ignore one-off task details; ignore failures unless a recovery pattern repeats.\n- If a pattern matches an existing habit, restate it exactly (it will be reinforced).\n` +
            `Output STRICT JSON: {"habits": [{"trigger": "...", "action": "...", "evidence": "one-line observation quote"}]}\nEmpty array if no pattern. No prose, no code fences.`,
        },
        { role: 'user', content: `Existing habits:\n${existingText}\n\n--- OBSERVATIONS (newest last) ---\n${obsText}` },
      ],
      { temperature: 0.2, maxTokens: 1200 }
    );
    const cleaned = res.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try {
      const obj = JSON.parse(cleaned);
      return (Array.isArray(obj.habits) ? obj.habits : [])
        .filter((x: any) => x && typeof x.trigger === 'string' && typeof x.action === 'string')
        .map((x: any) => ({ trigger: x.trigger, action: x.action, evidence: String(x.evidence ?? '').slice(0, 160) }))
        .slice(0, 5);
    } catch {
      return [];
    }
  }

  // ─── 注入与晋升 ─────────────────────────────────────────────────────────

  /** 注入系统提示的习惯（置信度 ≥0.7 自动应用级，最多 5 条，紧凑） */
  toPromptText(): string {
    const habits = this.loadStore().habits
      .filter(h => h.confidence >= 0.7)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);
    if (habits.length === 0) return '';
    const lines = habits.map(h => `- When ${h.trigger}: ${h.action}`);
    return `## 协作习惯（从历史观察中学到，自动应用）\n${lines.join('\n')}`;
  }

  /** 晋升守卫：置信度 ≥0.8 且 ≥2 会话 */
  promotionReady(h: Habit): boolean {
    return !h.promotedSkill && h.confidence >= 0.8 && h.sessions.length >= 2;
  }

  /**
   * 晋升为技能：用 trigger/action 生成 SKILL.md（llm_run 模式的提示型技能）。
   * skillsDir 由调用方注入；写盘走 skill-writer 原子写。
   */
  promote(
    habitId: string,
    skillsDir: string,
    writer: { write(skillsDir: string, name: string, payload: import('../skill-runtime/skill-writer.js').SkillWritePayload, opts?: { overwrite?: boolean }): string }
  ): { skillName: string } {
    const store = this.loadStore();
    const habit = store.habits.find(h => h.id === habitId);
    if (!habit) throw new Error(`习惯不存在: ${habitId}`);
    if (!this.promotionReady(habit)) {
      throw new Error(`未达晋升条件（需置信度 ≥0.8 且 ≥2 个会话；当前 ${habit.confidence.toFixed(1)} / ${habit.sessions.length} 会话）`);
    }
    const skillName = `habit-${habit.id.slice(3)}`;
    const payload = {
      frontmatter: {
        name: skillName,
        version: '1.0.0',
        description: `协作习惯（自动晋升）：${habit.trigger}`,
        execution_mode: 'llm_run',
        domain: 'habits',
        capabilities: ['collaboration-habit'],
      },
      promptContent:
        `# 协作习惯（由行为观察自动晋升）\n\n触发条件：${habit.trigger}\n建议行为：${habit.action}\n\n` +
        `## 观察证据\n${habit.evidence.map(e => `- ${e}`).join('\n')}\n\n` +
        `在符合触发条件的任务中直接应用上述行为，不必重新询问用户。`,
    };
    const written = writer.write(skillsDir, skillName, payload, { overwrite: true });
    habit.promotedSkill = skillName;
    habit.updatedAt = nowIso();
    this.saveStore(store);
    return { skillName: written ? skillName : skillName };
  }

  /** 手动调整置信度（用户纠偏通道：确认 +0.1 / 否决直接降半） */
  adjustConfidence(habitId: string, delta: number): Habit | null {
    const store = this.loadStore();
    const habit = store.habits.find(h => h.id === habitId);
    if (!habit) return null;
    habit.confidence = Math.min(0.9, Math.max(0, Number((habit.confidence + delta).toFixed(2))));
    habit.updatedAt = nowIso();
    this.saveStore(store);
    return habit;
  }
}
