import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { validateSkillName } from '../skill-runtime/skill-writer.js';
import { applyProfileInsights, type ProfileInsight } from './user-profile-service.js';
import type { FilesystemSkillRegistry } from '../skill-runtime/filesystem-registry.js';

/**
 * 运行后蒸馏管线（自进化闭环的落地）：run 正常完成后，至多发起**一次** LLM 蒸馏，
 * 按优先级产生至多一条"演化提议"——
 *
 *  ① skill_revision（技能使用中自改进）：本 run 用过的技能 × 负信号（技能调用失败 /
 *     门禁打回 / 子代理失败 ≥2）→ LLM 起草该技能的修订稿
 *  ② skill_new（复杂任务技能化提议）：步数 ≥12 且工具调用 ≥15 且未走 ① → LLM 从
 *     任务轨迹起草一份新技能草案
 *  ③ profile_update（画像演化提议）：步数 ≥8、距上次 ≥24h 且未走 ①② → LLM 从
 *     轨迹提炼画像增补点
 *
 * 全部提议只入库不动现场：技能修订/新技能需用户在技能页确认后落盘（旧版备份进
 * .history/，热重载即时生效）；画像增补在设置页确认后并入画像。与信任分级哲学
 * 一致——agent 可以提议，人决定采纳。
 */

export type ProposalKind = 'skill_revision' | 'skill_new' | 'profile_update';

export interface EvolutionProposal {
  id: string;
  kind: ProposalKind;
  runId: string;
  /** skill_revision / skill_new：技能名；profile_update：无 */
  skillName?: string;
  /** 给用户看的一段话：为什么提议这个改动 */
  rationale: string;
  /** skill_*：完整 SKILL.md 文本；profile_update：insights 数组 */
  content: string | Array<ProfileInsight>;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  decidedAt?: string;
}

export interface ConsiderRunInput {
  runId: string;
  goal: string;
  steps: number;
  toolCalls: number;
  /** 本 run 用过的技能名（不含 skill_ 前缀） */
  skillsUsed: string[];
  /** 负信号：技能调用失败（tool=skill_ 前缀，含错误摘要） */
  skillFailures: Array<{ tool: string; errorPreview: string }>;
  /** 负信号计数：门禁打回 / 子代理失败 */
  gateRejections: number;
  subagentFailures: number;
  /** 轨迹尾部（供 LLM 蒸馏上下文） */
  transcriptTail: string;
}

interface LlmChat {
  chat(req: { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; jsonMode?: boolean; maxTokens?: number }): Promise<{ content: string }>;
  isDemoMode?(): boolean;
}

const PROFILE_THROTTLE_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_TARGET = 3;
const MAX_TRANSCRIPT_CHARS = 6000;

export class EvolutionService {
  private storePath: string;
  private statePath: string;
  private proposals: EvolutionProposal[] = [];
  private deps: { llm: LlmChat; skillsDir: string; registry: FilesystemSkillRegistry };

  constructor(
    deps: { llm: LlmChat; skillsDir: string; registry: FilesystemSkillRegistry },
    dataDir: string,
  ) {
    this.deps = deps;
    this.storePath = join(dataDir, 'evolution', 'proposals.json');
    this.statePath = join(dataDir, 'evolution', 'state.json');
    this.load();
  }

  /** 依赖补绑（宿主字段初始化先于构造注入时使用） */
  rebind(deps: { llm: LlmChat; skillsDir: string; registry: FilesystemSkillRegistry }): void {
    this.deps = deps;
  }

  private load(): void {
    try {
      if (existsSync(this.storePath)) {
        this.proposals = JSON.parse(readFileSync(this.storePath, 'utf-8'));
      }
    } catch { this.proposals = []; }
  }

  private persist(): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(this.storePath, JSON.stringify(this.proposals, null, 2), 'utf-8');
  }

  private readState(): Record<string, unknown> {
    try {
      if (existsSync(this.statePath)) return JSON.parse(readFileSync(this.statePath, 'utf-8'));
    } catch { /* */ }
    return {};
  }

  private writeState(s: Record<string, unknown>): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(s, null, 2), 'utf-8');
  }

  list(status?: 'pending' | 'accepted' | 'rejected'): EvolutionProposal[] {
    const all = [...this.proposals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return status ? all.filter(p => p.status === status) : all;
  }

  /** run 完成后的入口（fire-and-forget；内部吞错不伤主流程） */
  async considerRun(input: ConsiderRunInput): Promise<void> {
    try {
      if (this.deps.llm.isDemoMode?.()) return;
      const transcript = input.transcriptTail.slice(0, MAX_TRANSCRIPT_CHARS);

      // ① 技能修订：用过技能 + 负信号足够 + 该技能没有未决提议
      const negativeSignals = input.skillFailures.length + input.gateRejections + input.subagentFailures;
      if (input.skillsUsed.length > 0 && negativeSignals >= 2) {
        // 选失败最集中的技能（attribute：失败的 skill_* 调用），否则第一个用过的
        const failCounts = new Map<string, number>();
        for (const f of input.skillFailures) failCounts.set(f.tool, (failCounts.get(f.tool) ?? 0) + 1);
        const target = [...failCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
          ?? `skill_${input.skillsUsed[0]}`;
        const skillName = target.replace(/^skill_/, '');
        if (this.pendingCount('skill_revision', skillName) === 0) {
          const made = await this.draftRevision(input, skillName, transcript);
          if (made) return;
        }
      }

      // ② 新技能提议：复杂任务（步数与调用密度）且无修订
      if (input.steps >= 12 && input.toolCalls >= 15) {
        if (this.pendingCount('skill_new') === 0) {
          const made = await this.draftNewSkill(input, transcript);
          if (made) return;
        }
      }

      // ③ 画像增补：节流 24h
      const state = this.readState();
      const last = Number(state.lastProfileProposalAt ?? 0);
      if (input.steps >= 8 && Date.now() - last > PROFILE_THROTTLE_MS) {
        if (this.pendingCount('profile_update') === 0) {
          const made = await this.draftProfileUpdate(input, transcript);
          if (made) {
            this.writeState({ ...state, lastProfileProposalAt: Date.now() });
          }
        }
      }
    } catch (err: any) {
      console.warn(`[演化管线] run ${input.runId} 蒸馏失败（不影响 run）: ${err?.message ?? err}`);
    }
  }

  private pendingCount(kind: ProposalKind, skillName?: string): number {
    return this.proposals.filter(p =>
      p.status === 'pending' && p.kind === kind &&
      (skillName === undefined || p.skillName === skillName)
    ).length;
  }

  private addProposal(p: Omit<EvolutionProposal, 'id' | 'status' | 'createdAt'>): EvolutionProposal {
    const proposal: EvolutionProposal = {
      ...p,
      id: `evo_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.proposals.push(proposal);
    // 上限保护：全库最多保留 60 条（旧的先清）
    if (this.proposals.length > 60) this.proposals = this.proposals.slice(-60);
    this.persist();
    return proposal;
  }

  private readCurrentSkillMd(skillName: string): string | null {
    try {
      const p = join(this.deps.skillsDir, skillName, 'SKILL.md');
      if (!existsSync(p)) return null;
      return readFileSync(p, 'utf-8');
    } catch { return null; }
  }

  /** ① 技能修订稿 */
  private async draftRevision(input: ConsiderRunInput, skillName: string, transcript: string): Promise<boolean> {
    const current = this.readCurrentSkillMd(skillName);
    if (!current) return false;
    const failures = input.skillFailures
      .map(f => `- ${f.tool}: ${f.errorPreview}`)
      .join('\n')
      .slice(0, 1500);
    const prompt =
      `A skill named "${skillName}" was used in an agent task and hit problems. Draft a REVISED version of its SKILL.md.\n\n` +
      `== Task goal ==\n${input.goal.slice(0, 500)}\n\n` +
      `== Observed failures (negative signals) ==\n${failures || '(indirect: gate rejections / subagent failures while this skill was in play)'}\n` +
      `Gate rejections: ${input.gateRejections}, subagent failures: ${input.subagentFailures}\n\n` +
      `== Transcript tail ==\n${transcript.slice(0, 2500)}\n\n` +
      `== Current SKILL.md ==\n${current.slice(0, 6000)}\n\n` +
      `Return JSON: {"rationale": "1-2 sentences on what to fix and why", "revisedSkillMd": "the complete revised SKILL.md text (keep frontmatter fields; improve instructions/edge cases that caused failures)"}.` +
      ` Keep the skill's language (Chinese stays Chinese). Only revise if you can identify a concrete improvement; otherwise return {"rationale": "skip"}.`;
    const res = await this.deps.llm.chat({ messages: [{ role: 'user', content: prompt }], jsonMode: true, maxTokens: 6000 });
    const parsed = safeJson(res.content);
    if (!parsed?.revisedSkillMd || /skip/i.test(String(parsed.rationale ?? ''))) return false;
    if (typeof parsed.revisedSkillMd !== 'string' || parsed.revisedSkillMd.length < 50) return false;
    this.addProposal({
      kind: 'skill_revision', runId: input.runId, skillName,
      rationale: String(parsed.rationale ?? '').slice(0, 500),
      content: parsed.revisedSkillMd,
    });
    return true;
  }

  /** ② 新技能草案 */
  private async draftNewSkill(input: ConsiderRunInput, transcript: string): Promise<boolean> {
    const existing = new Set(this.deps.registry.listAll().map((s: any) => s.name ?? s.manifest?.name).filter(Boolean));
    const prompt =
      `An agent just completed a complex task. Decide whether the approach is worth persisting as a reusable skill, and draft it.\n\n` +
      `== Task goal ==\n${input.goal.slice(0, 600)}\n\n` +
      `== Steps: ${input.steps}, tool calls: ${input.toolCalls} ==\n` +
      `== Transcript tail ==\n${transcript.slice(0, 3500)}\n\n` +
      `Existing skills (do NOT duplicate): ${[...existing].join(', ')}\n\n` +
      `Return JSON: {"name": "kebab-case-name", "rationale": "why this deserves to be a skill (1-2 sentences)", "skillMd": "complete SKILL.md with frontmatter (name/version/description/domain/capabilities/input_schema/execution_mode: llm_only/status: stable/tags/source: user) and a Chinese instruction body"}.` +
      ` If the task is a one-off not worth persisting, return {"rationale": "skip"}.`;
    const res = await this.deps.llm.chat({ messages: [{ role: 'user', content: prompt }], jsonMode: true, maxTokens: 6000 });
    const parsed = safeJson(res.content);
    if (!parsed?.skillMd || /skip/i.test(String(parsed.rationale ?? ''))) return false;
    let name = String(parsed.name ?? '').trim();
    try { validateSkillName(name); } catch { return false; }
    if (existing.has(name)) return false;
    if (this.pendingCount('skill_new', name) >= MAX_PENDING_PER_TARGET) return false;
    this.addProposal({
      kind: 'skill_new', runId: input.runId, skillName: name,
      rationale: String(parsed.rationale ?? '').slice(0, 500),
      content: String(parsed.skillMd),
    });
    return true;
  }

  /** ③ 画像增补点 */
  private async draftProfileUpdate(input: ConsiderRunInput, transcript: string): Promise<boolean> {
    const prompt =
      `From the transcript tail of a completed agent task, extract at most 2 NEW durable insights about the USER ` +
      `(interests, expertise, working style, goals). Only include what is clearly evident; skip if nothing new.\n\n` +
      `== Task goal ==\n${input.goal.slice(0, 300)}\n\n== Transcript tail ==\n${transcript.slice(0, 3000)}\n\n` +
      `Return JSON: {"insights": [{"field": "one of: interest|expertise|goal|output_format|language|detail_level|tone|role|name", "value": "short value (<=60 chars)", "reason": "evidence in one short sentence"}]}.` +
      ` Empty array if nothing durable.`;
    const res = await this.deps.llm.chat({ messages: [{ role: 'user', content: prompt }], jsonMode: true, maxTokens: 1500 });
    const parsed = safeJson(res.content);
    const insights = Array.isArray(parsed?.insights) ? parsed.insights.slice(0, 2) : [];
    const clean = insights.filter((i: any) => i && typeof i.field === 'string' && typeof i.value === 'string' && i.value.trim());
    if (clean.length === 0) return false;
    this.addProposal({
      kind: 'profile_update', runId: input.runId,
      rationale: clean.map((i: any) => `${i.field}: ${String(i.value).slice(0, 60)}（${String(i.reason ?? '').slice(0, 80)}）`).join('；'),
      content: clean.map((i: any) => ({ field: i.field, value: String(i.value).slice(0, 200), reason: String(i.reason ?? '').slice(0, 200) })),
    });
    return true;
  }

  /** 用户裁决：接受 → 落地（技能写盘 + 热重载 / 画像并入）；拒绝 → 归档 */
  async decide(id: string, accept: boolean): Promise<{ ok: boolean; message: string }> {
    const p = this.proposals.find(x => x.id === id);
    if (!p) return { ok: false, message: '提议不存在' };
    if (p.status !== 'pending') return { ok: false, message: `提议已处于 ${p.status} 状态` };

    if (accept) {
      if (p.kind === 'skill_revision' || p.kind === 'skill_new') {
        const name = p.skillName!;
        try { validateSkillName(name); } catch { return { ok: false, message: `技能名非法: ${name}` }; }
        const skillDir = resolve(this.deps.skillsDir, name);
        const target = join(skillDir, 'SKILL.md');
        mkdirSync(skillDir, { recursive: true });
        // 旧版备份进 .history/（存在才备份）
        if (existsSync(target)) {
          const histDir = join(skillDir, '.history');
          mkdirSync(histDir, { recursive: true });
          copyFileSync(target, join(histDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`));
        }
        writeFileSync(target, String(p.content), 'utf-8');
        try {
          await this.deps.registry.reloadSkill(name);
        } catch (err: any) {
          return { ok: false, message: `技能已写盘但重载失败（下次启动生效）: ${err?.message ?? err}` };
        }
        p.status = 'accepted'; p.decidedAt = new Date().toISOString();
        this.persist();
        return { ok: true, message: `技能 ${name} 已${p.kind === 'skill_revision' ? '更新' : '创建'}并热加载` };
      }
      if (p.kind === 'profile_update') {
        const applied = applyProfileInsights(p.content as Array<ProfileInsight>);
        p.status = 'accepted'; p.decidedAt = new Date().toISOString();
        this.persist();
        return { ok: true, message: applied ? '画像已更新' : '画像无需变更（可能已存在）' };
      }
    }
    p.status = 'rejected'; p.decidedAt = new Date().toISOString();
    this.persist();
    return { ok: true, message: '已拒绝' };
  }
}

function safeJson(text: string): any | null {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* 继续尝试子串 */ }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
  }
  return null;
}
