import { load as yamlLoad } from 'js-yaml';

/**
 * M2-2：Graph DSL — 确定性 DAG 的声明式定义。
 *
 * YAML 形态（校验后即为引擎的执行契约）：
 *
 * ```yaml
 * name: policy-digest
 * version: "1.0.0"
 * description: 采集政策 → 筛选 → 生成推文
 * max_parallel: 2
 * input:
 *   site: gd.gz.gov.cn        # 运行时可被 POST /api/runs 的 input 覆盖
 * nodes:
 *   - id: scrape
 *     type: skill
 *     skill: policy-scraper
 *     input: { site: "${{ input.site }}" }
 *     on_empty: skip          # skip | fail | continue（上游空产出时的策略）
 *     timeout_ms: 300000
 *     retries: 1
 *     permission: auto        # auto | approval（节点级 HITL，M2-4）
 * edges:
 *   - { from: scrape, to: filter }
 * ```
 *
 * 设计要点：
 *  · 模板引用只在 input 字符串值中展开：`${{ input.x }}` / `${{ nodes.<id>.outputs.x.y }}`
 *  · 校验器纯函数、无 IO — 技能是否存在等运行时事实由调用方（API 层）追加检查
 *  · 环检测用 Kahn 删除法（与调度同构，顺便产出拓扑序供可视化）
 */

export type NodeOnEmpty = 'skip' | 'fail' | 'continue';
export type NodePermission = 'auto' | 'approval';

export interface GraphNodeDefinition {
  id: string;
  type: 'skill';
  /** type=skill 时必填：技能名（执行时经 registry 解析） */
  skill: string;
  /** 静态输入 + 模板引用（执行前展开） */
  input?: Record<string, any>;
  /** 上游空产出（on_empty 判定）时的策略，默认 skip（级联跳过） */
  on_empty?: NodeOnEmpty;
  timeout_ms?: number;
  /** 可重试错误的最大重试次数（节点粒度，A5 修复），默认 0 */
  retries?: number;
  /** 节点级审批（M2-4）：approval = 执行前挂起等待人工（可改参数） */
  permission?: NodePermission;
  /** 节点备注（可视化展示用） */
  note?: string;
}

export interface GraphEdgeDefinition {
  from: string;
  to: string;
}

export interface GraphDefinition {
  name: string;
  version?: string;
  description?: string;
  /** 调度并发上限（默认 3） */
  max_parallel?: number;
  /** 声明运行时输入的默认值（可被启动参数覆盖） */
  input?: Record<string, any>;
  nodes: GraphNodeDefinition[];
  edges: GraphEdgeDefinition[];
}

export interface GraphValidationIssue {
  path: string;
  message: string;
}

export interface GraphValidationResult {
  ok: boolean;
  issues: GraphValidationIssue[];
  /** 校验通过时附带：拓扑序（Kahn 产出，用于可视化/调度一致性检查） */
  topoOrder?: string[];
}

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const NODE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const ON_EMPTY_SET = new Set(['skip', 'fail', 'continue']);
const PERMISSION_SET = new Set(['auto', 'approval']);
const MAX_NODES = 100;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

/** 解析 YAML 文本 → 对象（不校验；校验用 validateGraph）。YAML 语法错误抛异常由调用方包装 */
export function parseGraphYaml(text: string): unknown {
  return yamlLoad(text);
}

/** 松散对象判型（YAML 顶层可能是标量/数组） */
function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 纯结构校验（无 IO）：类型/必填/引用/重复/自环/环检测 */
export function validateGraph(raw: unknown): GraphValidationResult {
  const issues: GraphValidationIssue[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, issues: [{ path: '$', message: 'graph 必须是 YAML 对象（映射）' }] };
  }
  const g = raw as GraphDefinition;

  if (typeof g.name !== 'string' || !NAME_RE.test(g.name)) {
    issues.push({ path: 'name', message: 'name 必填，且匹配 [a-zA-Z][a-zA-Z0-9_-]*' });
  }
  if (g.version !== undefined && typeof g.version !== 'string') {
    issues.push({ path: 'version', message: 'version 须为字符串' });
  }
  if (g.max_parallel !== undefined && (!Number.isInteger(g.max_parallel) || g.max_parallel < 1 || g.max_parallel > 16)) {
    issues.push({ path: 'max_parallel', message: 'max_parallel 须为 1-16 的整数' });
  }
  if (g.input !== undefined && !isPlainObject(g.input)) {
    issues.push({ path: 'input', message: 'input 须为对象（运行时输入默认值）' });
  } else if (isPlainObject(g.input)) {
    // 用户实测（AI 编排产物）：把 JSON Schema 写进了 input 默认值 —
    // 运行时模板会解出 schema 对象本身传给技能（"无效 URL: [object Object]"）
    for (const [k, v] of Object.entries(g.input)) {
      if (
        isPlainObject(v) && typeof v.type === 'string' &&
        (v.items !== undefined || v.properties !== undefined)
      ) {
        issues.push({
          path: `input.${k}`,
          message: `疑似把 JSON Schema 写成了默认值（${JSON.stringify(v).slice(0, 60)}…）— input 是运行时默认值（如 url: https://example.com），不是 schema 定义`,
        });
      }
    }
  }

  // ── 节点 ──
  if (!Array.isArray(g.nodes) || g.nodes.length === 0) {
    issues.push({ path: 'nodes', message: 'nodes 必填且为非空数组' });
    return { ok: false, issues };
  }
  if (g.nodes.length > MAX_NODES) {
    issues.push({ path: 'nodes', message: `节点数超上限（${g.nodes.length} > ${MAX_NODES}）` });
  }

  const nodeIds = new Set<string>();
  g.nodes.forEach((n, i) => {
    const path = `nodes[${i}]`;
    if (!isPlainObject(n)) {
      issues.push({ path, message: '节点必须是对象' });
      return;
    }
    if (typeof n.id !== 'string' || !NODE_ID_RE.test(n.id)) {
      issues.push({ path: `${path}.id`, message: `id 非法: ${JSON.stringify(n.id)}（须匹配 [a-zA-Z][a-zA-Z0-9_-]*）` });
    } else if (nodeIds.has(n.id)) {
      issues.push({ path: `${path}.id`, message: `节点 id 重复: ${n.id}` });
    } else {
      nodeIds.add(n.id);
    }
    if (n.type !== 'skill') {
      issues.push({ path: `${path}.type`, message: `type 必须是 "skill"（当前: ${JSON.stringify(n.type)}）` });
    }
    if (typeof n.skill !== 'string' || !n.skill.trim()) {
      issues.push({ path: `${path}.skill`, message: 'skill 必填（技能名）' });
    }
    if (n.input !== undefined && !isPlainObject(n.input)) {
      issues.push({ path: `${path}.input`, message: 'input 须为对象' });
    }
    if (n.on_empty !== undefined && !ON_EMPTY_SET.has(n.on_empty)) {
      issues.push({ path: `${path}.on_empty`, message: `on_empty 须为 skip/fail/continue（当前: ${JSON.stringify(n.on_empty)}）` });
    }
    if (n.timeout_ms !== undefined && (!Number.isInteger(n.timeout_ms) || n.timeout_ms < 1000 || n.timeout_ms > MAX_TIMEOUT_MS)) {
      issues.push({ path: `${path}.timeout_ms`, message: `timeout_ms 须为 1000-${MAX_TIMEOUT_MS} 的整数（毫秒）` });
    }
    if (n.retries !== undefined && (!Number.isInteger(n.retries) || n.retries < 0 || n.retries > 5)) {
      issues.push({ path: `${path}.retries`, message: 'retries 须为 0-5 的整数' });
    }
    if (n.permission !== undefined && !PERMISSION_SET.has(n.permission)) {
      issues.push({ path: `${path}.permission`, message: `permission 须为 auto/approval（当前: ${JSON.stringify(n.permission)}）` });
    }
  });

  // ── 边 ──
  const edges: Array<{ from: string; to: string }> = [];
  if (g.edges !== undefined) {
    if (!Array.isArray(g.edges)) {
      issues.push({ path: 'edges', message: 'edges 须为数组' });
    } else {
      g.edges.forEach((e, i) => {
        const path = `edges[${i}]`;
        if (!isPlainObject(e) || typeof e.from !== 'string' || typeof e.to !== 'string') {
          issues.push({ path, message: '边必须是 { from, to } 对象' });
          return;
        }
        if (!nodeIds.has(e.from)) issues.push({ path: `${path}.from`, message: `引用不存在的节点: ${e.from}` });
        if (!nodeIds.has(e.to)) issues.push({ path: `${path}.to`, message: `引用不存在的节点: ${e.to}` });
        if (e.from === e.to) issues.push({ path, message: `自环: ${e.from}` });
        edges.push({ from: e.from, to: e.to });
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  // ── 环检测（Kahn 删除法；顺带产出拓扑序）──
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) {
    indeg.set(id, 0);
    adj.set(id, []);
  }
  for (const { from, to } of edges) {
    indeg.set(to, (indeg.get(to) ?? 0) + 1);
    adj.get(from)!.push(to);
  }
  const queue = [...nodeIds].filter(id => (indeg.get(id) ?? 0) === 0);
  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    topoOrder.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = indeg.get(next)! - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (topoOrder.length !== nodeIds.size) {
    const cyclic = [...nodeIds].filter(id => (indeg.get(id) ?? 0) > 0);
    issues.push({ path: 'edges', message: `存在环（涉及节点: ${cyclic.join(', ')}）— graph 必须是 DAG` });
    return { ok: false, issues };
  }

  return { ok: true, issues: [], topoOrder };
}

/** 便捷入口：YAML 文本 → 校验后的定义（语法错/结构错统一为 issues） */
export function parseAndValidateGraphYaml(text: string): GraphValidationResult & { graph?: GraphDefinition } {
  let raw: unknown;
  try {
    raw = parseGraphYaml(text);
  } catch (err: any) {
    return { ok: false, issues: [{ path: '$', message: `YAML 语法错误: ${err?.message ?? String(err)}` }] };
  }
  const result = validateGraph(raw);
  return { ...result, graph: result.ok ? (raw as GraphDefinition) : undefined };
}

// ── 模板展开（引擎执行前调用；DSL 层提供纯函数便于单测）─────────────────

const TEMPLATE_RE = /\$\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/** 点路径取值：a.b.0.c；不存在返回 undefined */
export function resolveDotPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const seg of dotted.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

export interface TemplateContext {
  /** 运行时输入（graph.input 默认值已被启动参数覆盖后的最终值） */
  input: Record<string, any>;
  /** 已完成节点的产出（nodeId → outputs） */
  nodes: Record<string, Record<string, any>>;
}

export interface TemplateResult {
  value: any;
  /** 展开过程中遇到的未解析引用（用于 on_empty 判定与诊断） */
  missing: string[];
}

/** 递归展开 input 树中的 ${{ ... }} 引用；整串引用保留原类型（非字符串拼接） */
export function expandTemplates(node: unknown, ctx: TemplateContext): TemplateResult {
  const missing: string[] = [];
  const walk = (v: any): any => {
    if (typeof v === 'string') {
      const whole = v.match(/^\$\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/);
      if (whole) {
        const resolved = resolveRef(whole[1]);
        return resolved;
      }
      return v.replace(TEMPLATE_RE, (_m, ref: string) => {
        const resolved = resolveRef(ref);
        return resolved === undefined ? '' : String(resolved);
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, any> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  const resolveRef = (ref: string): any => {
    if (ref.startsWith('input.')) {
      const v = resolveDotPath(ctx.input, ref.slice('input.'.length));
      if (v === undefined) missing.push(ref);
      return v;
    }
    if (ref.startsWith('nodes.')) {
      const v = resolveDotPath({ nodes: ctx.nodes }, ref);
      if (v === undefined) missing.push(ref);
      return v;
    }
    missing.push(ref);
    return undefined;
  };
  return { value: walk(node), missing };
}
