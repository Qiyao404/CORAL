import { useEffect, useMemo, useRef, useState } from 'react';
import {
  GitBranch, Play, CheckCircle2, XCircle, Loader2, ShieldAlert, RotateCcw,
  AlertTriangle, Trash2, FileCode2, Sparkles, HelpCircle, ChevronDown, ChevronRight, Package,
} from 'lucide-react';
import { api } from '../api/client';
import { useRunStream, type RunEventItem } from '../hooks/useRunStream';
import { AgentDag } from '../components/dag/AgentDag';
import { Tag } from '../components/ui';
import { useI18n } from '../i18n';

/**
 * M2-6：Workflow 页 — Graph 模式的创作与运行台。
 * YAML 编辑（本地草稿）→ 服务端校验（拓扑序回显）→ 运行（SSE 直播节点状态 DAG）
 * → 节点审批卡（改参数后继续）→ 结果面板（节点产出）→ 中断 run 一键 resume（M2-5 DoD）。
 */

type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting_human';

interface GraphNodeView {
  id: string;
  skill: string;
  status: NodeStatus;
  error?: string;
  outputs?: unknown;
}

/** 从事件流派生节点状态（graph.node_* + node.approval_*）与终态产出 */
function deriveGraphView(events: RunEventItem[], graphYamlNodes: GraphNodeView[]) {
  const nodes = new Map<string, GraphNodeView>(
    graphYamlNodes.map(n => [n.id, { ...n }])
  );
  let runStatus: string | null = null;
  let runError: string | null = null;
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
          if (ev.type === 'graph.node_completed' && p.outputs !== undefined) n.outputs = p.outputs;
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
        if (p.error) runError = String(p.error);
        break;
    }
  }
  return { nodes: [...nodes.values()], runStatus, runError, approval: currentApproval };
}

/** 从 YAML 文本提取节点骨架（编辑态预览；运行态以服务端 graph 为准） */
function nodesFromYaml(text: string): GraphNodeView[] {
  const out: GraphNodeView[] = [];
  const blocks = text.split(/^\s*-\s*id:/m);
  blocks.forEach((b, i) => {
    if (i === 0) return;
    const id = b.trim().split(/\s+/)[0]?.replace(/:.*/, '');
    if (!id) return;
    const sm = b.match(/^\s*.*?\bskill:\s*(\S+)/m);
    out.push({ id, skill: sm?.[1] ?? '', status: 'pending' });
  });
  return out;
}

/** 使用指引（M2 概念解释 — 用户实测反馈"没看懂"） */
function GuidePanel() {
  const { t } = useI18n();
  const [open, setOpen] = useState(() => localStorage.getItem('coral.guide.dismissed') !== '1');
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-fg-muted flex items-center gap-1 cursor-pointer hover:text-brand">
        <HelpCircle className="w-3.5 h-3.5" /> {t('workflow.guideOpen')}
      </button>
    );
  }
  return (
    <div className="glass rounded-xl border border-glass-border p-4 text-xs text-fg-secondary leading-6">
      <div className="flex items-center gap-2 mb-2">
        <HelpCircle className="w-4 h-4 text-brand" />
        <span className="font-medium text-fg-primary">{t('workflow.guideTitle')}</span>
        <span className="flex-1" />
        <button onClick={() => { setOpen(false); localStorage.setItem('coral.guide.dismissed', '1'); }}
          className="text-fg-muted hover:text-fg-primary cursor-pointer">{t('workflow.collapse')}</button>
      </div>
      <p><b>{t('workflow.guideDiffTitle')}</b>{t('workflow.guideDiffA')}<b>{t('workflow.guideDiffB')}</b>{t('workflow.guideDiffC')}</p>
      <p className="mt-2"><b>{t('workflow.guideStepsTitle')}</b>{t('workflow.guideStepsA')}<b>{t('workflow.aiCompose')}</b>{t('workflow.guideStepsB')}<b>{t('workflow.validate')}</b>{t('workflow.guideStepsC')}<b>{t('workflow.runGraph')}</b>{t('workflow.guideStepsD')}</p>
      <p className="mt-2"><b>{t('workflow.guideApprovalTitle')}</b>{t('workflow.guideApprovalA')}<code className="text-brand">permission: approval</code>{t('workflow.guideApprovalB')}<b>{t('workflow.guideApprovalPause')}</b>{t('workflow.guideApprovalC')}<b>{t('workflow.guideApprovalOps')}</b>{t('workflow.guideApprovalD')}</p>
      <p className="mt-2"><b>{t('workflow.guideResumeTitle')}</b>{t('workflow.guideResumeA')}<b>{t('workflow.guideResumeB')}</b>{t('workflow.guideResumeC')}</p>
    </div>
  );
}

export default function WorkflowPage() {
  const { t } = useI18n();
  const [yaml, setYaml] = useState<string>(() => localStorage.getItem('coral.graph.draft') ?? t('workflow.defaultYaml'));
  const [validation, setValidation] = useState<{ ok: boolean; issues: Array<{ path: string; message: string }>; topoOrder?: string[] } | null>(null);
  const [validating, setValidating] = useState(false);
  const [goal, setGoal] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runGoal, setRunGoal] = useState('');
  const [runGraphNodes, setRunGraphNodes] = useState<GraphNodeView[]>([]);
  const [resumable, setResumable] = useState<Array<{ runId: string; goal: string; createdAt: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [runInput, setRunInput] = useState(''); // graph.input 运行时覆盖（JSON）
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [workspaceId, setWorkspaceId] = useState<string>(() => localStorage.getItem('coral.graph.workspaceId') ?? '');
  const [inputDraft, setInputDraft] = useState(''); // 审批改参数的 JSON 草稿
  const [openOutputs, setOpenOutputs] = useState<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const { events: sseEvents, connected } = useRunStream(activeRunId ?? undefined);
  const [polledEvents, setPolledEvents] = useState<RunEventItem[]>([]);
  // SSE 事件 + 轮询权威事件合并（eventId 去重在 push 内做不了 — 这里做）
  const events = useMemo(() => {
    const byId = new Map<string, RunEventItem>();
    for (const e of polledEvents) byId.set(e.eventId, e);
    for (const e of sseEvents) byId.set(e.eventId, e);
    return [...byId.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }, [sseEvents, polledEvents]);
  const view = useMemo(() => deriveGraphView(events, runGraphNodes), [events, runGraphNodes]);

  // 终审修复（用户实测：审批通过后节点不更新 / doc·papers 一直转圈）：
  // SSE 事件可能丢失或迟到 — 每 5s 用 run 详情的**权威事件表**合并兜底，
  // 保证节点状态/结果面板最终一致。
  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    if (!activeRunId) return;
    pollRef.current = window.setInterval(async () => {
      if (document.hidden) return; // 后台标签不轮询
      try {
        const d = await api.getRun(activeRunId);
        const run = d?.run;
        if (!run) return;
        // 用服务端权威事件合并（eventId 去重已内置）
        for (const ev of d.events ?? []) {
          // 只补 graph/node/run 级事件（delta 类太大会打爆窗口）
          if (String(ev.type).startsWith('loop.')) continue;
          (ev as any).__poll = true;
        }
        setPolledEvents((d.events ?? []) as any);
      } catch { /* 轮询失败静默 */ }
    }, 5000);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [activeRunId]);

  useEffect(() => { localStorage.setItem('coral.graph.draft', yaml); }, [yaml]);
  useEffect(() => {
    api.listResumable().then((d: any) => setResumable(d.items ?? [])).catch(() => {});
    api.listWorkspaces().then((d: any) => setWorkspaces(d.items ?? [])).catch(() => {});
  }, []);
  useEffect(() => {
    if (workspaceId) localStorage.setItem('coral.graph.workspaceId', workspaceId);
    else localStorage.removeItem('coral.graph.workspaceId');
  }, [workspaceId]);
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
    if (!goal.trim()) { setError(t('workflow.errGoalRequired')); return; }
    setCompiling(true);
    setError(null);
    try {
      const res = await api.compileGraph(goal.trim());
      setYaml(res.yaml);
      setValidation({ ok: true, issues: [], topoOrder: res.graph?.nodes?.map((n: any) => n.id) });
    } catch (err: any) {
      setError(t('workflow.errCompileFailed', { msg: err.message || '' }));
    } finally {
      setCompiling(false);
    }
  };

  const run = async () => {
    setError(null);
    setValidation(null);
    let input: Record<string, any> | undefined;
    if (runInput.trim()) {
      try { input = JSON.parse(runInput); } catch { setError(t('workflow.errRunInputJson')); return; }
    }
    try {
      setPolledEvents([]); // P1-5: 清空旧 run 事件防污染
      const res = await api.createGraphRun({ goal: goal.trim() || yaml.match(/^name:\s*(\S+)/m)?.[1] || 'graph run', graph: yaml, input, workspaceId: workspaceId || undefined });
      setActiveRunId(res.runId);
      setRunGoal(goal.trim() || 'graph run');
      setRunGraphNodes(nodesFromYaml(yaml));
      setInputDraft('');
      setOpenOutputs(new Set());
    } catch (err: any) {
      setError(err.message || t('workflow.errCreateFailed'));
    }
  };

  const resume = async (runId: string) => {
    setError(null);
    try {
      setPolledEvents([]); // P1-5
      await api.resumeRun(runId);
      setActiveRunId(runId);
      setResumable(prev => prev.filter(r => r.runId !== runId));
      // 节点骨架从 run 详情取（保证与服务端一致）
      const d = await api.getRun(runId);
      const g = d?.run?.graph;
      if (g?.nodes) setRunGraphNodes(g.nodes.map((n: any) => ({ id: n.id, skill: n.skill, status: 'pending' as NodeStatus })));
      setRunGoal(d?.run?.goal ?? '');
      // 终审 P2：resume 后节点真实状态由 SSE 快速回填（graph.node_* 事件在断线重连时
      // 通过 afterSeq 补拉一次性到达）— 无需手动恢复快照
    } catch (err: any) {
      setError(err.message);
    }
  };

  const decide = async (approvalId: string, approved: boolean) => {
    if (!activeRunId) return;
    let input: any;
    if (approved && inputDraft.trim()) {
      try { input = JSON.parse(inputDraft); } catch { setError(t('workflow.errParamJson')); return; }
    }
    try {
      await api.resolveApproval(activeRunId, approvalId, approved, input);
    } catch (err: any) {
      setError(err.message);
    }
  };

  // 审查 P2：审批对象切换时清空参数草稿（防把上一个审批的参数发给下一个）
  useEffect(() => { setInputDraft(''); }, [(view as any).approval?.approvalId]);

  const toggleOutput = (id: string) => setOpenOutputs(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const previewNodes = useMemo(() => nodesFromYaml(yaml), [yaml]);
  const completedNodes = view.nodes.filter(n => n.status === 'completed');

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-brand-soft rounded-xl flex items-center justify-center border border-brand/30">
          <GitBranch className="w-5 h-5 text-brand" />
        </div>
        <div>
          <h1 className="text-xl font-heading font-medium text-fg-primary">Workflow</h1>
          <p className="text-xs text-fg-muted">{t('workflow.subtitle')}</p>
        </div>
      </div>

      <GuidePanel />

      {/* 中断 run 恢复条（M2-5） */}
      {resumable.length > 0 && (
        <div className="glass rounded-xl border border-status-warning/30 p-3 space-y-2">
          <p className="text-xs text-fg-secondary flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-status-warning" />
            {t('workflow.resumableDetected', { n: resumable.length })}
          </p>
          {resumable.map(r => (
            <div key={r.runId} className="flex items-center gap-2 text-xs">
              <span className="text-fg-primary truncate flex-1">{r.goal}</span>
              <span className="text-fg-muted">{new Date(r.createdAt).toLocaleString()}</span>
              <button onClick={() => resume(r.runId)} className="px-2 py-1 rounded-lg bg-brand text-white text-xs flex items-center gap-1 cursor-pointer hover:bg-brand-hover">
                <RotateCcw className="w-3 h-3" /> {t('workflow.resume')}
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
            <span className="text-xs font-medium text-fg-secondary flex-1">{t('workflow.yamlTitle')}</span>
            <button onClick={validate} disabled={validating}
              className="px-2.5 py-1 rounded-lg text-xs glass border border-glass-border hover:border-brand/40 text-fg-secondary cursor-pointer flex items-center gap-1">
              {validating ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />} {t('workflow.validate')}
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
                ? t('workflow.validateOk', { order: (validation.topoOrder ?? []).join(' → ') })
                : validation.issues.map((i, n) => <div key={n}>✗ {i.path}: {i.message}</div>)}
            </div>
          )}
        </div>

        {/* 运行面板 */}
        <div className="glass rounded-xl border border-glass-border p-4 space-y-3 flex flex-col">
          <div className="text-xs font-medium text-fg-secondary">{t('workflow.run')}</div>
          <input
            value={goal}
            onChange={e => setGoal(e.target.value)}
            placeholder={t('workflow.goalPlaceholder')}
            className="w-full glass border border-glass-border rounded-lg px-3 py-2 text-sm text-fg-primary outline-none focus:border-brand/40"
          />
          <textarea
            value={runInput}
            onChange={e => setRunInput(e.target.value)}
            placeholder={t('workflow.runInputPlaceholder')}
            spellCheck={false}
            className="w-full h-14 glass border border-glass-border rounded-lg p-2 font-mono text-xs text-fg-primary outline-none focus:border-brand/40 resize-none"
          />
          <div className="flex items-center gap-2 text-xs">
            <span className="text-fg-muted shrink-0">{t('workflow.artifactDir')}</span>
            <select
              value={workspaceId}
              onChange={e => setWorkspaceId(e.target.value)}
              className="flex-1 glass border border-glass-border rounded-lg px-2 py-1.5 text-xs text-fg-primary outline-none focus:border-brand/40"
            >
              <option value="">{t('workflow.wsTemp')}</option>
              {workspaces.map(w => <option key={w.id} value={w.id}>{t('workflow.wsOption', { name: w.name })}</option>)}
            </select>
          </div>
          {workspaceId && (
            <p className="text-[11px] text-fg-muted">{t('workflow.wsHint')}</p>
          )}
          <div className="flex gap-2 flex-wrap">
            <button onClick={compile} disabled={compiling}
              className="px-3 py-1.5 rounded-lg glass border border-glass-border text-xs text-fg-secondary flex items-center gap-1.5 cursor-pointer hover:border-brand/40">
              {compiling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} {t('workflow.aiCompose')}
            </button>
            <button onClick={run}
              className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs flex items-center gap-1.5 cursor-pointer hover:bg-brand-hover">
              <Play className="w-3.5 h-3.5" /> {t('workflow.runGraph')}
            </button>
            {activeRunId && (
              <button onClick={async () => { await api.cancelRun(activeRunId).catch(() => {}); }}
                className="px-3 py-1.5 rounded-lg glass border border-glass-border text-xs text-fg-secondary flex items-center gap-1.5 cursor-pointer hover:border-status-danger/40">
                <Trash2 className="w-3.5 h-3.5" /> {t('workflow.cancel')}
              </button>
            )}
          </div>
          {error && (
            <div className="text-xs text-status-danger bg-status-danger/10 border border-status-danger/30 rounded-lg px-2.5 py-2 break-all">
              {error}
            </div>
          )}

          {/* 编辑态预览（未运行时） */}
          {!activeRunId && previewNodes.length > 0 && (
            <div className="text-xs text-fg-muted">
              {t('workflow.nodePreview', { nodes: previewNodes.map(n => n.id).join(' → ') || t('workflow.noNodes') })}
            </div>
          )}

          {/* 运行态：节点 DAG + 状态 + 结果 */}
          {activeRunId && (
            <div className="space-y-3 flex-1">
              <div className="flex items-center gap-2 text-xs">
                <span className={connected ? 'text-status-success' : 'text-fg-muted'}>
                  {connected ? t('workflow.connected') : t('workflow.connecting')}
                </span>
                {view.runStatus
                  ? <Tag variant={view.runStatus === 'completed' ? 'success' : view.runStatus === 'failed' ? 'danger' : 'info'}>{view.runStatus}</Tag>
                  : <Tag variant="info">{t('workflow.running')}</Tag>}
                <span className="text-fg-muted truncate flex-1">{runGoal}</span>
              </div>

              {/* 失败详情（用户实测：失败后"什么都没有"） */}
              {view.runStatus === 'failed' && (
                <div className="text-xs text-status-danger bg-status-danger/10 border border-status-danger/30 rounded-lg px-2.5 py-2 space-y-1">
                  <p className="font-medium">{t('workflow.runFailedTitle')}</p>
                  {view.nodes.filter(n => n.status === 'failed').map(n => (
                    <p key={n.id}>{t('workflow.nodePrefix')}<b>{n.id}</b>{t('workflow.nodeFailedSkill', { skill: n.skill })}{n.error ?? t('workflow.unknownError')}</p>
                  ))}
                  {view.runError && <p className="text-fg-muted">{view.runError}</p>}
                  <p className="text-fg-muted">{t('workflow.commonCauses')}</p>
                </div>
              )}

              {runGraphNodes.length > 0 && (
                <div className="h-[240px] rounded-xl border border-glass-border overflow-hidden">
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

              {/* 结果面板：每个完成节点的产出（用户实测：成功后"什么都没有"） */}
              {view.runStatus === 'completed' && completedNodes.length > 0 && (
                <div className="glass rounded-xl border border-status-success/25 p-3 space-y-2">
                  <p className="text-xs font-medium text-fg-secondary flex items-center gap-1.5">
                    <Package className="w-3.5 h-3.5 text-status-success" /> {t('workflow.resultsTitle', { n: completedNodes.length })}
                  </p>
                  {completedNodes.map(n => {
                    const open = openOutputs.has(n.id);
                    const text = typeof n.outputs === 'string' ? n.outputs : JSON.stringify(n.outputs ?? {}, null, 2);
                    return (
                      <div key={n.id} className="text-xs">
                        <button onClick={() => toggleOutput(n.id)} className="flex items-center gap-1.5 w-full text-left cursor-pointer text-fg-primary hover:text-brand">
                          {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
                          <span className="font-medium">{n.id}</span>
                          <span className="text-fg-muted truncate flex-1">{text.slice(0, 80)}</span>
                        </button>
                        {open && (
                          <pre className="mt-1 max-h-52 overflow-y-auto glass border border-glass-border rounded-lg p-2 whitespace-pre-wrap break-words text-fg-secondary">{text}</pre>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 节点审批卡（M2-4：改参数后继续） */}
              {view.approval && (
                <div className="glass rounded-xl border border-status-warning/40 p-3 space-y-2">
                  <p className="text-xs text-fg-secondary flex items-center gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5 text-status-warning" />
                    {t('workflow.nodePrefix')}<b>{view.approval.node}</b>{t('workflow.approvalWaiting')}
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
                      <CheckCircle2 className="w-3.5 h-3.5" /> {t('workflow.approve')}
                    </button>
                    <button onClick={() => decide(view.approval!.approvalId, false)}
                      className="px-3 py-1.5 rounded-lg bg-status-danger/90 text-white text-xs cursor-pointer hover:bg-status-danger flex items-center gap-1">
                      <XCircle className="w-3.5 h-3.5" /> {t('workflow.reject')}
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
