import { nanoid } from 'nanoid';
import type { ExecutionPlan, PlannedAgent, DependencyEdge } from '../types/index.js';
import { llmClient } from '../services/llm-client.js';
import type { FilesystemSkillRegistry } from '../skill-runtime/filesystem-registry.js';
import { eventBus } from '../event/event-bus.js';
import { getCompanyProfile, mergeCompanyProfile } from '../services/company-profile-service.js';

/**
 * 规划引擎 — 将自然语言目标分解为可并发执行的 Agent DAG
 * v1.1.0 升级（T-210）：
 *   · 注入 input_schema 关键字段、capabilities、tags 给 LLM 选择
 *   · 注入站点别名表（policy-scraper reference.md 中维护）
 *   · 注入公司业务画像，辅助参数提取（如 information-filter 的 focusKeywords）
 *   · 输出的 skillInputTemplates 必须包含从自然语言提取的具体参数
 *   · 缺参兜底：LLM 没填必填字段 → 任务 failed，error.reason 列出缺哪些参数
 *   · 优雅短路：依赖 dag-scheduler 的 empty_when 判定（在 scheduler 中实现）
 */
export class PlanningEngine {
  private registry: FilesystemSkillRegistry;

  constructor(registry: FilesystemSkillRegistry) {
    this.registry = registry;
  }

  async plan(taskId: string, goal: string, constraints?: Record<string, any>, signal?: AbortSignal): Promise<ExecutionPlan> {
    eventBus.emit('task.planning', { taskId, goal });
    signal?.throwIfAborted?.();

    if (constraints?.skillName) {
      const plan = this.buildFastPath(taskId, constraints.skillName, goal, constraints);
      if (plan) {
        eventBus.emit('task.plan_ready', { taskId, planId: plan.planId, fastPath: true });
        return plan;
      }
    }

    try {
      const plan = await this.llmPlan(taskId, goal, constraints, signal);
      eventBus.emit('task.plan_ready', { taskId, planId: plan.planId, fastPath: false });
      return plan;
    } catch (err: any) {
      // 取消必须向上传播 — 不能落入降级方案继续执行（M0-2）
      // P3 加固：模型输出损坏（解析失败/循环依赖）也向上传播 — 静默 fallback 会让用户
      // 看到莫名其妙的任务；降级只留给「API 不可用」类传输错误
      if (err?.permanent || signal?.aborted || err?.name === 'AbortError') throw err;
      console.warn(`[规划引擎] LLM 规划失败，使用降级方案: ${err.message}`);
      return this.buildFallbackPlan(taskId, goal);
    }
  }

  private buildFastPath(taskId: string, skillName: string, goal: string, constraints: Record<string, any>): ExecutionPlan | null {
    const skill = this.registry.getByName(skillName);
    if (!skill) return null;

    const planId = nanoid();
    const agentId = nanoid();

    return {
      planId,
      taskId,
      version: 1,
      agents: [{
        agentId,
        name: `${skill.description.slice(0, 20)} 执行器`,
        role: `直接执行 ${skill.name} Skill`,
        assignedSkills: [skillName],
        skillInputTemplates: { [skillName]: constraints.input || {} },
        dependsOn: [],
        priority: 0,
        estimatedDurationMs: skill.estimatedDurationMs,
      }],
      edges: [],
      estimatedDurationMs: skill.estimatedDurationMs,
      plannerModel: 'fast-path',
      plannerReasoning: `快速路径: 用户指定了 Skill "${skillName}"，直接执行`,
      createdAt: new Date().toISOString(),
    };
  }

  private async llmPlan(taskId: string, goal: string, constraints?: Record<string, any>, signal?: AbortSignal): Promise<ExecutionPlan> {
    signal?.throwIfAborted?.();
    const skills = this.registry.listAvailable();
    const profile = mergeCompanyProfile(getCompanyProfile(), constraints?.companyProfileOverride);
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth() + 1;

    const skillList = skills.map(s => ({
      name: s.name,
      description: s.description,
      domain: s.domain,
      capabilities: s.capabilities,
      input_keys: s.inputKeys || Object.keys(s.inputSchema?.properties || {}),
      output_keys: Object.keys(s.outputSchema?.properties || {}),
      execution_mode: s.executionMode,
      consumes_company_profile: s.consumesCompanyProfile || false,
      tags: s.tags,
      default: s.defaultInput,
      empty_when: s.emptyWhen,
    }));

    // 站点别名表：从 policy-scraper/reference.md 解析
    const siteAliases = this.loadSiteAliases();

    const prompt = `你是 CORAL 平台的规划引擎。把用户目标分解为可并发执行的 Agent DAG。

# 当前日期
${today.toISOString().slice(0, 10)}（年=${currentYear}, 月=${currentMonth}）

# 可用 Skills（含 input_keys / output_keys / 默认值 / consumes_company_profile）
${JSON.stringify(skillList, null, 2)}

# 站点别名表（仅当任务涉及 policy-scraper 时使用）
${JSON.stringify(siteAliases, null, 2)}

# 公司业务画像（仅当任务涉及 information-filter / 业务相关筛选时使用）
${JSON.stringify(profile, null, 2)}

# 用户目标
${goal}

# 约束条件
${constraints ? JSON.stringify(constraints, null, 2) : '无特殊约束'}

# 输出格式（严格 JSON，不要包含 Markdown 代码块标记）
{
  "reasoning": "你的规划思路（含识别到的意图、参数提取过程）",
  "agents": [
    {
      "agentId": "a1",
      "name": "智能体名称",
      "role": "角色描述",
      "assignedSkills": ["skill-name"],
      "skillInputTemplates": { "skill-name": { "参数名": "从用户目标中提取的实际值" } },
      "dependsOn": [],
      "priority": 0,
      "estimatedDurationMs": 10000
    }
  ],
  "edges": [
    { "from": "a1", "to": "a2", "dataMapping": { "上游output字段": "下游input字段" } }
  ],
  "missing_params": []
}

# 关键规则（FR-I：组合任务理解）
1. 没有相互依赖的 Agent 标记为可并行（dependsOn 为空或仅依赖已存在 Agent）
2. 每个 Agent 至少分配一个 Skill；只使用可用 Skills 列表中存在的 Skill
3. **极其重要**：skillInputTemplates 必须包含从用户目标中提取的具体数据，绝对不能传空对象 {}
4. 用户提到具体站点名（如"广东工信厅 / 佛山住建局"），用 site_aliases 转换为站点 ID 数组传给 policy-scraper.sites
5. 用户描述模糊（如"最近的政策"）→ 使用 Skill 自身 default 字段（如 month=当前月-1, sites=all）并在 reasoning 中说明
6. 用户提到"筛选 / 挑出与公司相关 / 过滤"必须加入 information-filter（公司画像由平台自动注入，不需要在 input 里传）
7. 串接顺序：采集类（policy-scraper）→ 筛选类（information-filter）→ 输出类（policy-to-post / summarize-document）
8. dataMapping 推断：scraper 输出 md_path → filter 输入 md_path → toPost 输入 md_path
9. 当上游 Skill 标注了 empty_when，下游应继续生成（scheduler 会自动短路），不要在 plan 阶段就跳过下游

# 自然语言参数提取示例
- "广东工信厅 3 月" → policy-scraper 输入 { year: ${currentYear}, month: 3, sites: ["gdii"] }
- "采集广东工信厅和佛山住建局 2026 年 2 月" → { year: 2026, month: 2, sites: ["gdii", "fszj"] }
- "采集… 筛选与公司相关的… 做成推文" → 3 节点 DAG（scraper → filter → toPost）
- "把这段政策转推文：xxxxx" → 直接 policy-to-post.md_content 注入文本

# 缺参兜底
当用户描述实在过于模糊（连默认值都无法兜底），把缺失字段加入 missing_params，平台会让任务以 failed 结束并提示用户补充。`;

    const { content, tokensUsed } = await llmClient.complete(
      [
        { role: 'system', content: prompt },
        { role: 'user', content: `请为以下目标生成执行计划: ${goal}` },
      ],
      { temperature: 0.3, maxTokens: 3000, signal }
    );

    const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    // P3 加固：解析失败不再静默 — 带上 LLM 原始输出片段，向上传播为明确的任务失败
    let parsed: any;
    try {
      parsed = JSON.parse(cleanContent);
    } catch {
      const err = new Error(
        `规划输出解析失败：LLM 返回的不是合法 JSON（开头 120 字符: "${cleanContent.slice(0, 120)}"）`
      );
      (err as any).permanent = true;
      throw err;
    }

    if (Array.isArray(parsed.missing_params) && parsed.missing_params.length > 0) {
      const planId = nanoid();
      // 插入一个失败占位 plan，让 task.routes 能捕获 error
      throw new Error(`缺少必填参数: ${parsed.missing_params.join(', ')}`);
    }

    const plan = this.buildPlanFromLlmOutput(taskId, parsed, tokensUsed);

    if (plan.agents.length === 0) {
      console.warn('[规划引擎] LLM 返回了空计划，使用降级方案');
      return this.buildFallbackPlan(taskId, goal);
    }

    return plan;
  }

  private buildPlanFromLlmOutput(
    taskId: string,
    llmOutput: any,
    _tokensUsed: number
  ): ExecutionPlan {
    const planId = nanoid();

    const agents: PlannedAgent[] = (llmOutput.agents || []).map((a: any) => ({
      agentId: a.agentId || nanoid(),
      name: a.name || '未命名智能体',
      role: a.role || '',
      assignedSkills: a.assignedSkills || [],
      skillInputTemplates: a.skillInputTemplates || {},
      dependsOn: a.dependsOn || [],
      priority: a.priority ?? 0,
      estimatedDurationMs: a.estimatedDurationMs || 10000,
    }));

    const edges: DependencyEdge[] = (llmOutput.edges || []).map((e: any) => ({
      from: e.from,
      to: e.to,
      dataMapping: e.dataMapping,
    }));

    if (!this.validateDAG(agents, edges)) {
      const err = new Error('生成的执行计划包含循环依赖');
      (err as any).permanent = true;
      throw err;
    }

    return {
      planId,
      taskId,
      version: 1,
      agents,
      edges,
      estimatedDurationMs: this.estimateTotalDuration(agents, edges),
      plannerModel: llmClient.isDemoMode() ? 'demo-mode' : llmClient.getCurrentConfig().model,
      plannerReasoning: llmOutput.reasoning || '',
      createdAt: new Date().toISOString(),
    };
  }

  private buildFallbackPlan(taskId: string, goal: string): ExecutionPlan {
    console.warn('[规划引擎] 使用降级 Mock 执行计划');
    const planId = nanoid();
    const skills = this.registry.listAvailable();
    const defaultSkill = skills[0]?.name || 'summarize-document';

    return {
      planId,
      taskId,
      version: 1,
      agents: [
        {
          agentId: 'fallback-a1',
          name: '数据处理智能体',
          role: '处理输入数据',
          assignedSkills: [defaultSkill],
          skillInputTemplates: { [defaultSkill]: { text: goal } },
          dependsOn: [],
          priority: 0,
          estimatedDurationMs: 5000,
        },
      ],
      edges: [],
      estimatedDurationMs: 5000,
      plannerModel: 'fallback',
      plannerReasoning: '[降级方案] LLM 规划失败或 API 不可用，回退到单 Skill 执行',
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * 从 policy-scraper/reference.md 加载 site_aliases
   * 格式约定：YAML 块内 site_aliases 字典；解析失败 → 返回 {}
   */
  private loadSiteAliases(): Record<string, { names: string[]; url: string }> {
    const scraper = this.registry.getByName('policy-scraper');
    if (!scraper?.referenceContent) return {};
    const ref = scraper.referenceContent;
    const m = ref.match(/site_aliases\s*:\s*\n([\s\S]*?)(?:\n#|\n[A-Za-z_][\w-]*\s*:|\n```|\Z)/);
    if (!m) return {};

    const out: Record<string, { names: string[]; url: string }> = {};
    let current: { id: string; names: string[]; url: string } | null = null;
    const lines = m[1].split(/\r?\n/);
    for (const raw of lines) {
      if (!raw.trim()) continue;
      // 顶层 id（缩进 2 空格）
      const idMatch = raw.match(/^\s{2}([a-z][a-z0-9_]*)\s*:\s*$/);
      if (idMatch) {
        if (current) out[current.id] = { names: current.names, url: current.url };
        current = { id: idMatch[1], names: [], url: '' };
        continue;
      }
      const nm = raw.match(/^\s{4}names\s*:\s*\[([^\]]*)\]/);
      if (nm && current) {
        current.names = nm[1]
          .split(',')
          .map(s => s.replace(/^['"]|['"]$/g, '').trim())
          .filter(Boolean);
        continue;
      }
      const um = raw.match(/^\s{4}url\s*:\s*['"]?([^'"\n]+)['"]?/);
      if (um && current) {
        current.url = um[1].trim();
        continue;
      }
    }
    if (current) out[current.id] = { names: current.names, url: current.url };
    return out;
  }

  private validateDAG(agents: PlannedAgent[], edges: DependencyEdge[]): boolean {
    const adj = new Map<string, string[]>();
    const inDeg = new Map<string, number>();

    for (const a of agents) {
      adj.set(a.agentId, []);
      inDeg.set(a.agentId, 0);
    }
    for (const e of edges) {
      adj.get(e.from)?.push(e.to);
      inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
    }

    const queue: string[] = [];
    for (const [id, deg] of inDeg) {
      if (deg === 0) queue.push(id);
    }

    let visited = 0;
    while (queue.length > 0) {
      const node = queue.shift()!;
      visited++;
      for (const next of (adj.get(node) || [])) {
        const newDeg = (inDeg.get(next) || 1) - 1;
        inDeg.set(next, newDeg);
        if (newDeg === 0) queue.push(next);
      }
    }

    return visited === agents.length;
  }

  private estimateTotalDuration(agents: PlannedAgent[], edges: DependencyEdge[]): number {
    if (agents.length === 0) return 0;
    if (edges.length === 0) {
      return Math.max(...agents.map(a => a.estimatedDurationMs));
    }
    return agents.reduce((sum, a) => sum + a.estimatedDurationMs, 0);
  }
}
