import { useEffect, useMemo, useRef, useState } from 'react';
import {
  GitBranch, Play, CheckCircle2, XCircle, Loader2, ShieldAlert, RotateCcw,
  AlertTriangle, Trash2, FileCode2, Sparkles,
} from 'lucide-react';
import { api } from '../api/client';
import { useRunStream, type RunEventItem } from '../hooks/useRunStream';
import { AgentDag } from '../components/dag/AgentDag';
import { Tag } from '../components/ui';

/**
 * M2-6：Workflow 页 — Graph 模式的创作与运行台。
 * YAML 编辑（本地草稿）→ 服务端校验（拓扑序回显）→ 运行（SSE 直播节点状态 DAG）
 * → 节点审批卡（改参数后继续）→ 中断 run 一键 resume（M2-5 DoD）。
 */

const DEFAULT_YAML = `name: my-workflow
description: 示例：读取网页并总结（替换为你的技能编排）
max_parallel: 2
input:
  url: https://example.com
nodes:
  - id: read
    type: skill
    skill: web-reader
    input:
      url: "\${{ input.url }}"
  - id: summarize
    type: skill
    skill: summarize-document
    input:
      text: "\${{ nodes.read.outputs.text }}"
    retries: 1
edges:
  - { from: read, to: summarize }
`;

type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting_human';

interface GraphNodeView {
  id: string;
  skill: string;
  status: NodeStatus;
  error?: string;
}

/** 从事件流派生节点状态（graph.node_* + node.approval_*） */
function deriveGraphView(events: RunEventItem[], graphYamlNodes: GraphNodeView[]) {
  const nodes = new Map<string, GraphNodeView>(
    graphYamlNodes.map(n => [n.id, { ...n }])
  );
  let runStatus: string | null = null;
  const approval: { approvalId: string; node: string; input: any } | null = null;
  let currentApproval: { approvalId: string; node: string; input: any } | null = null;

  for (const ev of events) {
    const p = ev.payload ?? {};
    switch (ev.type) {
      case 'graph.node_running':
      case 'graph.node_completed':
      case 'graph.node_failed':
      case 'graph.node_skipped': {
        const id = String(p.node ?? '');
        const n = nodes.get(id);
        if (n) {
          n.status = ev.type.replace('graph.node_', '') as NodeStatus;
          if (p.error) n.error = String(p.error);
        }
        break;
      }
      case 'node.approval_required':
        currentApproval = { approvalId: String(p.approvalId), node: String(p.node), input: p.input };
        {
          const n = nodes.get(String(p.node));
          if (n) n.status = 'waiting_human';
        }
        break;
      case 'node.approval_resolved':
        if (currentApproval && currentApproval.approvalId === p.approvalId) currentApproval = null;
        break;
      case 'run.completed':
      case 'run.failed':
      case 'run.cancelled':
        runStatus = ev.type.replace('run.', '');
        break;
    }
  }
  return { nodes: [...nodes.values()], runStatus, approval: currentApproval };
}

/** 从 YAML 文本提取节点骨架（编辑态预览；运行态以服务端 graph 为准） */
function nodesFromYaml(text: string): GraphNodeView[] {
  const out: GraphNodeView[] = [];
  for (const m of text.matchAll(/^\s*-\s*id:\s*(\S+)[\s\S]*?(?=^\s*-\s*id:|^\s*\w+:|$)/gm)) {
    out.push({ id: m[1], skill: '', status: 'pending' });
  }
  // skill 名（同段的 skill: 行）
  const blocks = text.split(/^\s*-\s*id:/m);
  blocks.forEach((b, i) => {
    if (i === 0 || out[i - 1] === undefined) return;
    const sm = b.match(/^\s*.*?\bskill:\s*(\S+)/m);
    if (sm) out[i - 1].skill = sm[1];
  });
  return out;
}

export default function WorkflowPage() {
  const [yaml, setYaml] = useState<string>(() => localStorage.getItem('coral.graph.draft') ?? DEFAULT_YAML);
  const [validation, setValidation] = useState<{ ok: boolean; issues: Array<{ path: string; message: string }>; topoOrder?: string[] } | null>(null);
  const [validating, setValidating] = useState(false);
  const [goal, setGoal] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runGoal, setRunGoal] = useState('');
  const [runGraphNodes, setRunGraphNodes] = useState<GraphNodeView[]>([]);
  const [resumable, setResumable] = useState<Array<{ runId: string; goal: string; createdAt: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [inputDraft, setInputDraft] = useState(''); // 审批改参数的 JSON 草稿
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const { events, connected } = useRunStream(activeRunId ?? undefined);
  const view = useMemo(() => deriveGraphView(events, runGraphNodes), [events, runGraphNodes]);

  useEffect(() => { localStorage.setItem('coral.graph.draft', yaml); }, [yaml]);
  useEffect(() => {
    api.listResumable().then((d: any) => setResumable(d.items ?? [])).catch(() => {});
  }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [events.length]);

  const validate = async () => {
    setValidating(true);
    setValidation(null);
    try {
      setValidation(await api.validateGraph(yaml));
    } catch (err: any) {
      setValidation({ ok: false, issues: [{ path: '$', message: err.message }] });
    } finally {
      setValidating(false);
    }
  };

  /** M2-3：一句话 → AI 编排为 graph YAML（服务端校验 + 自愈重试后返回） */
  const compile = async () => {
    if (!goal.trim()) { setError('请先在运行面板填写目标描述'); return; }
    setCompiling(true);
    setError(null);
    try {
      const res = await api.compileGraph(goal.trim());
      setYaml(res.yaml);
      setValidation({ ok: true, issues: [], topoOrder: res.graph?.nodes?.map((n: any) => n.id) });
    } catch (err: any) {
      setError('AI 编排失败: ' + (err.message || ''));
    } finally {
      setCompiling(false);
    }
  };

  const run = async () => {
    setError(null);
    try {
      const res = await api.createGraphRun({ goal: goal.trim() || yaml.match(/^name:\s*(\S+)/m)?.[1] || 'graph run', graph: yaml });
      setActiveRunId(res.runId);
      setRunGoal(goal.trim() || 'graph run');
      setRunGraphNodes(nodesFromYaml(yaml));
      setInputDraft('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const resume = async (runId: string) => {
    setError(null);
    try {
      await api.resumeRun(runId);
      setActiveRunId(runId);
      setResumable(prev => prev.filter(r => r.runId !== runId));
      // 节点骨架从 run 详情取（保证与服务端一致）
      const d = await api.getRun(runId);
      const g = d?.run?.graph;
      if (g?.nodes) setRunGraphNodes(g.nodes.map((n: any) => ({ id: n.id, skill: n.skill, status: 'pending' as NodeStatus })));
      setRunGoal(d?.run?.goal ?? '');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const decide = async (approvalId: string, approved: boolean) => {
    if (!activeRunId) return;
    let input: any;
    if (approved && inputDraft.trim()) {
      try { input = JSON.parse(inputDraft); } catch { setError('参数 JSON 不合法'); return; }
    }
    try {
      await api.resolveApproval(activeRunId, approvalId, approved, input);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const previewNodes = useMemo(() => nodesFromYaml(yaml), [yaml]);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-brand-soft rounded-xl flex items-center justify-center border border-brand/30">
          <GitBranch className="w-5 h-5 text-brand" />
        </div>
        <div>
          <h1 className="text-xl font-heading font-medium text-fg-primary">Workflow</h1>
          <p className="text-xs text-fg-muted">Graph 模式 — 确定性 DAG · 节点级审批 · 断点恢复</p>
        </div>
      </div>

      {/* 中断 run 恢复条（M2-5） */}
      {resumable.length > 0 && (
        <div className="glass rounded-xl border border-status-warning/30 p-3 space-y-2">
          <p className="text-xs text-fg-secondary flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-status-warning" />
            检测到 {resumable.length} 个因服务重启中断的 graph run（已完成节点不会重跑）
          </p>
          {resumable.map(r => (
            <div key={r.runId} className="flex items-center gap-2 text-xs">
              <span className="text-fg-primary truncate flex-1">{r.goal}</span>
              <span className="text-fg-muted">{new Date(r.createdAt).toLocaleString()}</span>
              <button onClick={() => resume(r.runId)} className="px-2 py-1 rounded-lg bg-brand text-white text-xs flex items-center gap-1 cursor-pointer hover:bg-brand-hover">
                <RotateCcw className="w-3 h-3" /> 恢复
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* YAML 编辑器 */}
        <div className="glass rounded-xl border border-glass-border overflow-hidden flex flex-col">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-glass-border">
            <FileCode2 className="w-4 h-4 text-fg-muted" />
            <span className="text-xs font-medium text-fg-secondary flex-1">Graph YAML（草稿自动保存）</span>
            <button onClick={validate} disabled={validating}
              className="px-2.5 py-1 rounded-lg text-xs glass border border-glass-border hover:border-brand/40 text-fg-secondary cursor-pointer flex items-center gap-1">
              {validating ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />} 校验
            </button>
          </div>
          <textarea
            value={yaml}
            onChange={e => setYaml(e.target.value)}
            spellCheck={false}
            className="flex-1 min-h-[340px] bg-transparent p-3 font-mono text-xs text-fg-primary resize-y outline-none leading-5"
          />
          {validation && (
            <div className={`px-3 py-2 text-xs border-t ${validation.ok ? 'border-status-success/30 text-status-success' : 'border-status-danger/30 text-status-danger'}`}>
              {validation.ok
                ? `✓ 校验通过 · 拓扑序: ${(validation.topoOrder ?? []).join(' → ')}`
                : validation.issues.map((i, n) => <div key={n}>✗ {i.path}: {i.message}</div>)}
            </div>
          )}
        </div>

        {/* 运行面板 */}
        <div className="glass rounded-xl border border-glass-border p-4 space-y-3 flex flex-col">
          <div className="text-xs font-medium text-fg-secondary">运行</div>
          <input
            value={goal}
            onChange={e => setGoal(e.target.value)}
            placeholder="目标描述（可选，默认取 graph 名）"
            className="w-full glass border border-glass-border rounded-lg px-3 py-2 text-sm text-fg-primary outline-none focus:border-brand/40"
          />
          <div className="flex gap-2 flex-wrap">
            <button onClick={compile} disabled={compiling}
              className="px-3 py-1.5 rounded-lg glass border border-glass-border text-xs text-fg-secondary flex items-center gap-1.5 cursor-pointer hover:border-brand/40">
              {compiling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} AI 编排
            </button>
            <button onClick={run}
              className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs flex items-center gap-1.5 cursor-pointer hover:bg-brand-hover">
              <Play className="w-3.5 h-3.5" /> 运行 Graph
            </button>
            {activeRunId && (
              <button onClick={async () => { await api.cancelRun(activeRunId).catch(() => {}); }}
                className="px-3 py-1.5 rounded-lg glass border border-glass-border text-xs text-fg-secondary flex items-center gap-1.5 cursor-pointer hover:border-status-danger/40">
                <Trash2 className="w-3.5 h-3.5" /> 取消
              </button>
            )}
          </div>
          {error && <p className="text-xs text-status-danger">{error}</p>}

          {/* 编辑态预览（未运行时） */}
          {!activeRunId && previewNodes.length > 0 && (
            <div className="text-xs text-fg-muted">
              节点预览: {previewNodes.map(n => n.id).join(' → ') || '（未识别到节点）'}
            </div>
          )}

          {/* 运行态：节点 DAG + 状态 */}
          {activeRunId && (
            <div className="space-y-3 flex-1">
              <div className="flex items-center gap-2 text-xs">
                <span className={connected ? 'text-status-success' : 'text-fg-muted'}>
                  {connected ? '● 已连接' : '○ 连接中…'}
                </span>
                {view.runStatus
                  ? <Tag variant={view.runStatus === 'completed' ? 'success' : view.runStatus === 'failed' ? 'danger' : 'info'}>{view.runStatus}</Tag>
                  : <Tag variant="info">运行中</Tag>}
                <span className="text-fg-muted truncate flex-1">{runGoal}</span>
              </div>
              {runGraphNodes.length > 0 && (
                <div className="h-[280px] rounded-xl border border-glass-border overflow-hidden">
                  <AgentDag
                    agents={view.nodes.map(n => ({ agentId: n.id, name: n.id, role: 'skill', skill: n.skill || 'skill' }))}
                    edges={[]}
                    agentStatuses={Object.fromEntries(view.nodes.map(n => [n.id, n.status === 'skipped' || n.status === 'waiting_human' ? 'pending' : n.status]))}
                    progressByAgent={{}}
                  />
                </div>
              )}
              {/* 节点状态列表（含 skipped/waiting_human 等 DAG 之外的态） */}
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {view.nodes.map(n => (
                  <div key={n.id} className="flex items-center gap-2 text-xs">
                    {n.status === 'completed' ? <CheckCircle2 className="w-3.5 h-3.5 text-status-success shrink-0" />
                      : n.status === 'running' ? <Loader2 className="w-3.5 h-3.5 text-status-info animate-spin shrink-0" />
                      : n.status === 'failed' ? <XCircle className="w-3.5 h-3.5 text-status-danger shrink-0" />
                      : n.status === 'waiting_human' ? <ShieldAlert className="w-3.5 h-3.5 text-status-warning shrink-0" />
                      : <span className="w-3.5 h-3.5 rounded-full border border-glass-borderStrong shrink-0" />}
                    <span className={n.status === 'skipped' ? 'text-fg-muted line-through' : 'text-fg-primary'}>{n.id}</span>
                    <span className="text-fg-muted">{n.skill}</span>
                    {n.error && <span className="text-status-danger truncate">{n.error}</span>}
                  </div>
                ))}
              </div>

              {/* 节点审批卡（M2-4：改参数后继续） */}
              {view.approval && (
                <div className="glass rounded-xl border border-status-warning/40 p-3 space-y-2">
                  <p className="text-xs text-fg-secondary flex items-center gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5 text-status-warning" />
                    节点 <b>{view.approval.node}</b> 等待审批 — 可修改参数后通过
                  </p>
                  <textarea
                    value={inputDraft || JSON.stringify(view.approval.input ?? {}, null, 2)}
                    onChange={e => setInputDraft(e.target.value)}
                    spellCheck={false}
                    className="w-full h-28 glass border border-glass-border rounded-lg p-2 font-mono text-xs text-fg-primary outline-none focus:border-brand/40 resize-none"
                  />
                  <div className="flex gap-2">
                    <button onClick={() => decide(view.approval!.approvalId, true)}
                      className="px-3 py-1.5 rounded-lg bg-status-success/90 text-white text-xs cursor-pointer hover:bg-status-success flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" /> 通过并继续
                    </button>
                    <button onClick={() => decide(view.approval!.approvalId, false)}
                      className="px-3 py-1.5 rounded-lg bg-status-danger/90 text-white text-xs cursor-pointer hover:bg-status-danger flex items-center gap-1">
                      <XCircle className="w-3.5 h-3.5" /> 拒绝
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
