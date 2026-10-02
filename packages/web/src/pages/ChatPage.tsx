import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bot, Send, FolderOpen, CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight,
  Plus, History, Square, Wrench, ShieldAlert, ListTodo,
} from 'lucide-react';
import { api } from '../api/client';
import { Button, Card, Tag, Textarea, Select, EmptyState } from '../components/ui';
import { useRunStream, deriveRunView, type RunEventItem } from '../hooks/useRunStream';

/**
 * M1-8：Chat 页升级 — 真 agent 会话。
 *  · 提交 → POST /api/runs（带 sessionId / workspaceId）→ 事件流内联直播
 *  · 工具调用卡片（输入/结果可展开）、todo checklist、审批 diff 卡片
 *  · 左侧：历史会话（runs 按 sessionId 分组）
 */

interface SessionItem {
  sessionId: string | null;
  runs: Array<{ id: string; goal: string; status: string; createdAt: string }>;
}

interface Workspace {
  id: string;
  name: string;
  permission: string;
}

export default function ChatPage() {
  const navigate = useNavigate();
  const [goal, setGoal] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const { events, connected } = useRunStream(activeRunId ?? undefined);
  const view = useMemo(() => deriveRunView(events), [events]);

  const loadSessions = useCallback(async () => {
    try {
      const res = await api.listRuns({ limit: 100 });
      const bySession = new Map<string, SessionItem>();
      for (const run of res.items ?? []) {
        const key = run.session_id ?? '(未分组)';
        if (!bySession.has(key)) bySession.set(key, { sessionId: run.session_id, runs: [] });
        bySession.get(key)!.runs.push({ id: run.id, goal: run.goal, status: run.status, createdAt: run.created_at });
      }
      setSessions([...bySession.values()].slice(0, 20));
    } catch { /* 后端不可用静默 */ }
  }, []);

  const loadWorkspaces = useCallback(async () => {
    try {
      const res = await api.listWorkspaces();
      setWorkspaces(res.items ?? []);
    } catch { /* 静默 */ }
  }, []);

  useEffect(() => {
    loadSessions();
    loadWorkspaces();
  }, [loadSessions, loadWorkspaces]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length, view.finalContent]);

  const submit = async () => {
    if (!goal.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await api.createRun({
        goal: goal.trim(),
        sessionId: currentSessionId ?? undefined,
        workspaceId: workspaceId || undefined,
      });
      setGoal('');
      setActiveRunId(res.runId);
      loadSessions();
    } catch (err: any) {
      alert(`创建失败: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const decide = async (approvalId: string, approved: boolean) => {
    if (!activeRunId) return;
    try {
      await api.resolveApproval(activeRunId, approvalId, approved);
    } catch (err: any) {
      alert(`审批失败: ${err.message}`);
    }
  };

  const cancel = async () => {
    if (!activeRunId) return;
    try {
      await api.cancelRun(activeRunId);
    } catch { /* ignore */ }
  };

  return (
    <div className="flex h-screen">
      {/* 左侧：历史会话 */}
      <aside className="w-64 shrink-0 border-r border-glass-border glass rounded-none flex flex-col">
        <div className="p-3 border-b border-glass-border flex items-center justify-between">
          <span className="text-xs text-fg-muted flex items-center gap-1"><History className="w-3.5 h-3.5" /> 历史会话</span>
          <button
            onClick={() => { setActiveRunId(null); setCurrentSessionId(`sess_${Date.now().toString(36)}`); }}
            className="text-xs text-brand hover:text-brand-hover flex items-center gap-1 cursor-pointer"
            title="开始新会话"
          >
            <Plus className="w-3.5 h-3.5" /> 新建
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          {sessions.length === 0 && <p className="text-xs text-fg-muted p-2">暂无历史</p>}
          {sessions.map(s => (
            <div key={s.sessionId}>
              <p className="text-[10px] text-fg-disabled px-2 mb-1">{s.sessionId ?? '未分组'}</p>
              {s.runs.map(r => (
                <button
                  key={r.id}
                  onClick={() => { setActiveRunId(r.id); setCurrentSessionId(s.sessionId); }}
                  className={`w-full text-left p-2 rounded-lg text-xs transition-colors cursor-pointer ${
                    activeRunId === r.id ? 'bg-brand-soft text-brand' : 'text-fg-secondary hover:bg-bg-elev/40'
                  }`}
                >
                  <p className="truncate">{r.goal}</p>
                  <p className="text-[10px] text-fg-muted mt-0.5">
                    {statusLabel(r.status)} · {new Date(r.createdAt).toLocaleTimeString('zh-CN')}
                  </p>
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>

      {/* 主区 */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="p-5 border-b border-glass-border glass rounded-none flex items-center gap-3">
          <Bot className="w-6 h-6 text-brand" />
          <div className="flex-1">
            <h1 className="text-lg font-heading font-bold text-fg-primary">Agent 会话</h1>
            <p className="text-xs text-fg-muted">
              自主规划 · 工具调用 · 全程可观测 {connected ? '· 实时已连接' : ''}
            </p>
          </div>
          {/* 工作区选择器 */}
          <div className="flex items-center gap-2 text-xs">
            <FolderOpen className="w-4 h-4 text-fg-muted" />
            <Select
              value={workspaceId}
              onChange={e => setWorkspaceId(e.target.value)}
              className="!w-56 text-xs"
            >
              <option value="">不绑定工作区</option>
              {workspaces.map(w => (
                <option key={w.id} value={w.id}>
                  {w.name}（{w.permission}）
                </option>
              ))}
            </Select>
            <button
              onClick={() => navigate('/settings')}
              className="text-fg-muted hover:text-brand cursor-pointer"
              title="管理工作区（设置页）"
            >
              管理
            </button>
          </div>
        </div>

        {/* 运行视图 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {!activeRunId && (
            <div className="text-center py-16">
              <div className="w-14 h-14 bg-brand-soft rounded-2xl flex items-center justify-center mx-auto mb-3 border border-brand/30">
                <Bot className="w-7 h-7 text-brand" />
              </div>
              <h2 className="text-base font-heading font-medium text-fg-primary mb-1">描述你的目标</h2>
              <p className="text-fg-muted text-sm mb-5">Agent 会自主调用工具完成；绑定工作区后可读写本地文件</p>
              <div className="flex flex-wrap justify-center gap-2 max-w-xl mx-auto">
                {['总结 https://example.com 的要点', '看看工作区里有什么文件', '把笔记整理成表格'].map(ex => (
                  <button key={ex} onClick={() => setGoal(ex)}
                    className="px-3 py-1.5 glass border border-glass-border rounded-full text-xs text-fg-secondary hover:border-brand/40 hover:text-brand cursor-pointer">
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeRunId && <RunLiveView goal={sessions.flatMap(s => s.runs).find(r => r.id === activeRunId)?.goal ?? ''} view={view} events={events} onDecide={decide} />}
          <div ref={bottomRef} />
        </div>

        {/* 输入区 */}
        <div className="p-4 glass border-t border-glass-border rounded-none">
          <div className="max-w-4xl mx-auto flex gap-3 items-end">
            <Textarea
              value={goal}
              onChange={e => setGoal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
              placeholder="描述你的目标…（Enter 发送，Shift+Enter 换行）"
              rows={1}
              className="flex-1"
            />
            {activeRunId && view.runStatus === 'running' ? (
              <Button variant="danger" onClick={cancel} icon={<Square className="w-4 h-4" />}>停止</Button>
            ) : (
              <Button onClick={submit} loading={submitting} icon={<Send className="w-4 h-4" />}>发送</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function statusLabel(s: string): string {
  return ({ created: '已创建', running: '运行中', waiting_human: '等待审批', completed: '已完成', failed: '已失败', cancelled: '已取消' } as Record<string, string>)[s] ?? s;
}

/** 单个 run 的直播视图（goal + todo + 工具卡 + 审批 + 最终回答） */
function RunLiveView({
  goal,
  view,
  events,
  onDecide,
}: {
  goal: string;
  view: ReturnType<typeof deriveRunView>;
  events: RunEventItem[];
  onDecide: (approvalId: string, approved: boolean) => void;
}) {
  const [openCards, setOpenCards] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpenCards(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const statusTag = view.runStatus
    ? <Tag variant={view.runStatus === 'completed' ? 'success' : view.runStatus === 'failed' ? 'danger' : 'info'}>{statusLabel(view.runStatus)}</Tag>
    : <Tag variant="info">运行中</Tag>;

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      {/* 目标 */}
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-brand text-white rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words">{goal}</div>
      </div>

      {/* todo checklist */}
      {view.todos.length > 0 && (
        <Card className="!p-4">
          <h3 className="text-xs font-semibold text-fg-primary mb-2 flex items-center gap-1"><ListTodo className="w-4 h-4 text-brand" /> 任务清单</h3>
          <ul className="space-y-1.5">
            {view.todos.map((t, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                {t.status === 'completed' ? <CheckCircle2 className="w-4 h-4 text-status-success shrink-0 mt-0.5" />
                  : t.status === 'in_progress' ? <Loader2 className="w-4 h-4 text-status-info animate-spin shrink-0 mt-0.5" />
                  : <span className="w-4 h-4 rounded-full border border-glass-borderStrong shrink-0 mt-0.5" />}
                <span className={t.status === 'completed' ? 'text-fg-muted line-through' : 'text-fg-primary'}>{t.content}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* 工具卡片 */}
      {view.toolCards.map(card => {
        const open = openCards.has(card.callId);
        const subAgent = card.agentId !== 'main';
        return (
          <div key={card.callId} className={`glass rounded-xl border ${card.status === 'failed' ? 'border-status-danger/30' : 'border-glass-border'} ${subAgent ? 'ml-6' : ''}`}>
            <button className="w-full flex items-center gap-2 p-3 cursor-pointer text-left" onClick={() => toggle(card.callId)}>
              {card.status === 'running' ? <Loader2 className="w-4 h-4 text-status-info animate-spin shrink-0" />
                : card.status === 'ok' ? <CheckCircle2 className="w-4 h-4 text-status-success shrink-0" />
                : <XCircle className="w-4 h-4 text-status-danger shrink-0" />}
              <Wrench className="w-3.5 h-3.5 text-fg-muted shrink-0" />
              <span className="text-sm font-medium text-fg-primary flex-1 truncate">{card.tool}</span>
              {subAgent && <Tag variant="brand">{card.agentId}</Tag>}
              {open ? <ChevronDown className="w-4 h-4 text-fg-muted" /> : <ChevronRight className="w-4 h-4 text-fg-muted" />}
            </button>
            {open && (
              <div className="px-3 pb-3 space-y-2">
                {card.inputPreview && (
                  <div>
                    <p className="text-[10px] text-fg-muted mb-0.5">输入</p>
                    <pre className="bg-bg-panel/60 rounded p-2 text-[11px] font-mono text-fg-secondary overflow-auto max-h-40 whitespace-pre-wrap break-all">{card.inputPreview}</pre>
                  </div>
                )}
                {card.resultPreview && (
                  <div>
                    <p className="text-[10px] text-fg-muted mb-0.5">结果</p>
                    <pre className="bg-bg-panel/60 rounded p-2 text-[11px] font-mono text-fg-secondary overflow-auto max-h-56 whitespace-pre-wrap break-all">{card.resultPreview}</pre>
                  </div>
                )}
                {card.error && <p className="text-xs text-status-danger">{card.error}</p>}
              </div>
            )}
          </div>
        );
      })}

      {/* 审批卡片 */}
      {view.pendingApprovals.map(a => (
        <Card key={a.approvalId} className="!p-4 border-status-warn/40">
          <h3 className="text-sm font-semibold text-status-warn mb-2 flex items-center gap-1.5">
            <ShieldAlert className="w-4 h-4" /> 需要你的批准：{a.tool}
          </h3>
          {a.diff ? (
            <pre className="bg-bg-panel/60 rounded-lg p-3 text-[11px] font-mono overflow-auto max-h-64 whitespace-pre-wrap break-all border border-glass-border">
              {a.diff.split('\n').map((line, i) => (
                <div key={i} className={
                  line.startsWith('+') ? 'text-status-success bg-status-success/5' :
                  line.startsWith('-') ? 'text-status-danger bg-status-danger/5' : 'text-fg-secondary'
                }>{line || ' '}</div>
              ))}
            </pre>
          ) : (
            <pre className="bg-bg-panel/60 rounded-lg p-3 text-[11px] font-mono text-fg-secondary overflow-auto max-h-40 whitespace-pre-wrap break-all">
              {JSON.stringify(a.input, null, 2)}
            </pre>
          )}
          <div className="flex gap-2 mt-3 justify-end">
            <Button size="sm" variant="ghost" onClick={() => onDecide(a.approvalId, false)}>拒绝</Button>
            <Button size="sm" onClick={() => onDecide(a.approvalId, true)}>批准执行</Button>
          </div>
        </Card>
      ))}

      {/* 最终回答 */}
      {view.finalContent && (
        <div className="flex justify-start">
          <div className="max-w-[85%] glass border border-glass-border rounded-2xl px-4 py-3">
            <p className="text-sm text-fg-primary whitespace-pre-wrap break-words">{view.finalContent}</p>
            {view.endReason === 'budget_exceeded' && (
              <p className="text-xs text-status-warn mt-2">⚠ 预算达到上限，以上为部分成果总结</p>
            )}
          </div>
        </div>
      )}

      {/* 事件计数 */}
      {events.length > 0 && (
        <p className="text-center text-[10px] text-fg-disabled">
          {events.length} 个事件 · {view.toolCards.length} 次工具调用
        </p>
      )}
      {events.length === 0 && (
        <EmptyState title="等待事件…" description="run 已创建，正在等待第一条事件" />
      )}
    </div>
  );
}
