import { parseAndValidateGraphYaml, type GraphDefinition } from './dsl.js';

/**
 * M2-3：graph-compiler — goal → GraphDefinition 的可选编译（LLM 辅助）。
 *
 * v1 planning-engine 的 A9 业务硬编码（政策编排链 prompt、reference.md 站点别名正则）
 * 全部剥离：编译器只认识「技能清单 + DSL 规则」，站点别名等业务提示走各 skill
 * manifest 的 `x-planning` 扩展字段随清单注入。
 *
 * A8 教训（零校验/静默降级）在此不重演：
 *  · LLM 输出必须过 validateGraph，引用不存在的技能直接报错
 *  · 解析失败不降级为单节点兜底 — 返回错误（调用方决定下一步）
 *  · 校验失败带错误反馈重试一次（模型自愈机会），再失败才报错
 */

export interface SkillPlanningHint {
  name: string;
  description: string;
  inputSchema?: Record<string, any>;
  /** 输出字段（模板引用键名的依据：\${{ nodes.<id>.outputs.<key> }}） */
  outputSchema?: Record<string, any>;
  /** x-planning 扩展（站点别名/典型用法等，原样序列化进提示） */
  xPlanning?: Record<string, any>;
}

export interface CompilerLLM {
  complete(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: any
  ): Promise<{ content: string }>;
}

export type CompileResult =
  | { ok: true; graph: GraphDefinition; yaml: string; attempts: number }
  | { ok: false; error: string; issues?: string[] };

const SYSTEM_PROMPT = `You compile a user goal into a CORAL workflow graph (a DAG of skill nodes).

Output rules:
- Output ONLY one YAML code block (no prose before or after) using this schema:
  name: <kebab-case-name>
  description: <one line>
  max_parallel: <optional 1-16>
  input: <optional object of run-level inputs the goal implies>
  nodes:
    - id: <short snake/camel id>
      type: skill
      skill: <EXACT skill name from the catalog>
      input: <object; reference earlier outputs with \${{ nodes.<id>.outputs.<path> }} and run inputs with \${{ input.<key> }}>
      on_empty: skip|fail|continue   # optional, default skip
      timeout_ms: <optional>
      retries: <optional 0-5>
      permission: auto|approval      # approval = ask a human before running (use for destructive/costly steps)
  edges:
    - { from: <id>, to: <id> }
- Use ONLY skills from the catalog. Never invent a skill name.
- The graph 'input:' block holds DEFAULT VALUES ONLY (e.g. url: https://example.com) — NEVER JSON Schema definitions (no type/items/properties there).
- Every node input field MUST match the skill's input_schema type: a string field gets ONE string (pick \${{ input.urls.0 }} for the first of a list, or emit one node per URL), a number gets a number. Never wire an array/object into a string field.
- Reference upstream outputs ONLY by the keys listed in that skill's output_fields (e.g. \${{ nodes.read.outputs.content }}) — never invent keys like 'markdown' or 'text'.
- Web skills only READ given URLs — there is no web-search skill. If the goal says 'search', put concrete seed URLs in input defaults (e.g. a search results page or the site's index) and say so in the description.
- Keep graphs minimal: fewest nodes that accomplish the goal (usually 1-4).
- Wire data flow through input templates; avoid nodes with no meaningful input.
- The graph must be a DAG (no cycles).`;

function catalogSection(skills: SkillPlanningHint[]): string {
  return skills
    .map(s => {
      const lines = [`- ${s.name}: ${s.description}`];
      if (s.inputSchema && Object.keys(s.inputSchema).length > 0) {
        lines.push(`  input_schema: ${JSON.stringify(s.inputSchema)}`);
      }
      if (s.outputSchema?.properties && Object.keys(s.outputSchema.properties).length > 0) {
        lines.push(`  output_fields: ${JSON.stringify(Object.keys(s.outputSchema.properties))}`);
      }
      if (s.xPlanning && Object.keys(s.xPlanning).length > 0) {
        lines.push(`  x-planning: ${JSON.stringify(s.xPlanning)}`);
      }
      return lines.join('\n');
    })
    .join('\n');
}

/** 从 LLM 回答中提取 YAML 代码块（容错：裸 YAML 也接受） */
export function extractYamlBlock(content: string): string {
  const fenced = content.match(/```(?:ya?ml)?\s*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return content.trim();
}

/** 编译入口：goal + 技能清单 → 校验通过的 GraphDefinition */
export async function compileGoalToGraph(
  goal: string,
  skills: SkillPlanningHint[],
  llm: CompilerLLM
): Promise<CompileResult> {
  if (!goal.trim()) return { ok: false, error: 'goal 为空' };
  if (skills.length === 0) return { ok: false, error: '技能清单为空 — 无法编译 graph' };

  const catalog = catalogSection(skills);
  const skillNames = new Set(skills.map(s => s.name));
  let feedback = '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    const userPrompt = [
      `Goal: ${goal}`,
      '',
      'Skill catalog:',
      catalog,
      ...(feedback ? ['', `Your previous attempt had these validation errors — fix them:\n${feedback}`] : []),
    ].join('\n');

    let content: string;
    try {
      const r = await llm.complete(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        { temperature: 0.2 }
      );
      content = r.content;
    } catch (err: any) {
      return { ok: false, error: `LLM 调用失败: ${err?.message ?? String(err)}` };
    }

    const yamlText = extractYamlBlock(content);
    const parsed = parseAndValidateGraphYaml(yamlText);
    if (!parsed.ok) {
      feedback = parsed.issues.map(i => `${i.path}: ${i.message}`).join('\n');
      continue; // 重试一次（带错误反馈）
    }
    // 引用的技能必须存在（A8：不静默替换）
    const unknown = [...new Set(parsed.graph!.nodes.map(n => n.skill))].filter(s => !skillNames.has(s));
    if (unknown.length > 0) {
      feedback = `引用了目录中不存在的技能: ${unknown.join(', ')}（只能使用目录内技能）`;
      continue;
    }
    return { ok: true, graph: parsed.graph!, yaml: yamlText, attempts: attempt };
  }
  return {
    ok: false,
    error: 'graph 编译失败（两次尝试均未通过校验）',
    issues: feedback ? [feedback] : undefined,
  };
}
