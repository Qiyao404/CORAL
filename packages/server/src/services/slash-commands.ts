import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import matter from 'gray-matter';

/**
 * 斜杠命令目录 — data/commands/*.md 的用户快捷指令。
 *
 * 形态：聊天输入以 "/" 开头时展开为完整任务描述再进入正常 run。
 *  · 文件 = frontmatter（name/description/argument_hint）+ 正文模板
 *  · 模板占位：$ARGUMENTS（全部参数原文）、$1..$9（按词取参）
 *  · 命令只属于用户（模型看不到命令表 — 与技能的分界：技能给模型用，命令给人用）
 */

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  template: string;
  file: string;
}

const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const MAX_COMMANDS = 50;

export class SlashCommandService {
  private dir: string;

  constructor(baseDir: string) {
    this.dir = resolve(baseDir, 'commands');
  }

  get dirPath(): string {
    return this.dir;
  }

  list(): SlashCommand[] {
    if (!existsSync(this.dir)) return [];
    const out: SlashCommand[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.md')) continue;
      const c = this.parseFile(join(this.dir, f));
      if (c) out.push(c);
      if (out.length >= MAX_COMMANDS) break;
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private parseFile(path: string): SlashCommand | null {
    try {
      const raw = readFileSync(path, 'utf-8');
      const { data: fm, content } = matter(raw);
      const name = String(fm.name ?? '').trim();
      if (!NAME_RE.test(name)) return null;
      const template = content.trim();
      if (!template) return null;
      return {
        name,
        description: String(fm.description ?? '').trim().slice(0, 200) || `命令 ${name}`,
        ...(typeof fm.argument_hint === 'string' && fm.argument_hint.trim() ? { argumentHint: fm.argument_hint.trim().slice(0, 120) } : {}),
        template: template.slice(0, 8000),
        file: path,
      };
    } catch {
      return null;
    }
  }

  /**
   * 展开一条用户输入。输入形如 "/research 量子计算 最新进展"。
   * 命中：返回 {goal: 展开后的任务描述, command: 命名}；未命中 /cmd（无参且存在无参模板）
   * 或非斜杠输入：返回 null（调用方按原文处理）。
   */
  expand(input: string): { goal: string; command: SlashCommand; arguments: string } | null {
    const text = String(input ?? '').trim();
    if (!text.startsWith('/')) return null;
    const spaceIdx = text.indexOf(' ');
    const cmdName = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
    if (!cmdName) return null;
    const cmd = this.list().find(c => c.name === cmdName);
    if (!cmd) return null;
    const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();
    const goal = cmd.template
      .replace(/\$ARGUMENTS/g, args)
      .replace(/\$(\d)/g, (_m, d: string) => args.split(/\s+/)[Number(d) - 1] ?? '');
    return { goal: goal.trim() || cmd.template, command: cmd, arguments: args };
  }
}

// ─── 首启种子（与技能联动的 4 条快捷命令）────────────────────────────────

export const SEED_SLASH_COMMANDS: Array<{ file: string; content: string }> = [
  {
    file: 'research.md',
    content: `---
name: research
description: 深度调研一个主题（多源检索 + 交叉验证 + 带引用报告）
argument_hint: <主题>
---

对"$ARGUMENTS"做一次深度调研（standard 档）：拆子问题、多源检索、交叉验证，产出带引用与置信分级的报告并落盘。使用 skill_deep-research 的方法执行。
`,
  },
  {
    file: 'plan.md',
    content: `---
name: plan
description: 把一句话目标变成可冷启动执行的施工计划（蓝图）
argument_hint: <目标>
---

为以下目标生成施工蓝图（skill_goal-blueprint 的方法）：拆成自包含小步骤、标注依赖与并行组、过对抗评审，并附可直接用于 Workflow 页面的 Graph YAML。目标：$ARGUMENTS
`,
  },
  {
    file: 'review.md',
    content: `---
name: review
description: 双盲会审当前工作区里的指定文件/产出
argument_hint: <文件或产出说明>
---

对$ARGUMENTS做双盲会审（skill_dual_review 或 dual_review 工具）：两个独立评审 + 分歧仲裁，输出通过/失败与问题清单。只挑有证据的问题。
`,
  },
  {
    file: 'brief.md',
    content: `---
name: brief
description: 每日简报：扫一遍工作区与最近运行，总结进展与待办
---

不接参数。基于 past_runs 检索最近 1-2 天的运行，结合工作区文件变化（fs_list），给我一份简报：完成了什么、进行中什么、卡在哪里、建议下一步。
`,
  },
];

/** 目录为空时播种；返回写入数量 */
export function seedSlashCommands(dir: string): number {
  const svc = new SlashCommandService(dir);
  if (!existsSync(svc.dirPath)) mkdirSync(svc.dirPath, { recursive: true });
  if (svc.list().length > 0) return 0;
  let n = 0;
  for (const seed of SEED_SLASH_COMMANDS) {
    try {
      writeFileSync(join(svc.dirPath, seed.file), seed.content, 'utf-8');
      n++;
    } catch { /* 单个失败跳过 */ }
  }
  return n;
}
