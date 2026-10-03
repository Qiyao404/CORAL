import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bot, Send, FolderOpen, CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight,
  Plus, History, Square, Wrench, ShieldAlert, ListTodo, Upload, Type, Trash2,
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
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([]);
  // 最终回答全文（run.completed 事件只带 500 字预览，终态后从详情拉全文）
  const [fullFinal, setFullFinal] = useState<string | null>(null);
  // 会话线程：当前会话全部 run（时间升序，含 final_content）— ChatGPT 式连续对话视图
  const [sessionRuns, setSessionRuns] = useState<Array<{ id: string; goal: string; final_content?: string | null; created_at: string }>>([]);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const { events, connected } = useRunStream(activeRunId ?? undefined);
  const view = useMemo(() => deriveRunView(events), [events]);

  // 创新①：流式直播 — 聚合 loop.delta 事件为当前流式文本
  const streamingText = useMemo(() => {
    if (view.runStatus) return ''; // 已终态，finalContent 取代
    const raw = events.filter(e => e.type === 'loop.delta').map(e => e.payload?.delta ?? '').join('');
    // DSML 抑制兜底：退化原文若混入增量，截到第一个特殊标记前
    const cut = raw.indexOf('<｜');
    return cut >= 0 ? raw.slice(0, cut) : raw;
  }, [events, view.runStatus]);
  const uploading = useRef(false);
  // run 到达终态后：清空已上传文件列表 + 拉取最终回答全文（事件只带 500 字预览）
  useEffect(() => {
    if (view.runStatus && ['completed', 'failed', 'cancelled'].includes(view.runStatus)) {
      setUploadedFiles([]);
    }
  }, [view.runStatus]);

  useEffect(() => {
    setFullFinal(null);
    if (!activeRunId || !view.runStatus || !['completed', 'failed', 'cancelled'].includes(view.runStatus)) return;
    let cancelled = false;
    api.getRun(activeRunId).then((d: any) => {
      if (!cancelled && d?.run?.final_content) setFullFinal(d.run.final_content);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeRunId, view.runStatus]);

  const handleUpload = async (file: File) => {
    if (!workspaceId || uploading.current) { if (!workspaceId) alert('请先选择工作区再上传'); return; }
    if (file.size > 1024 * 1024) { alert('文件超过 1MB 上限'); return; }
    uploading.current = true;
    try {
      // 二进制类型走 base64 保真通道（.docx/.xlsx 等）；文本直传
      const binaryExts = /\.(docx|xlsx|pptx|pdf|zip|png|jpe?g|gif|webp|woff2?|ttf|mp3|mp4|sqlite)$/i;
      const isBinary = binaryExts.test(file.name);
      if (isBinary) {
        // 分块 base64（展开运算符对大文件会栈溢出）
        const buf = new Uint8Array(await file.arrayBuffer());
        let b64 = '';
        for (let i = 0; i < buf.length; i += 0x8000) {
          b64 += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        }
        await api.uploadWorkspaceFile(workspaceId, file.name, btoa(b64), 'base64');
      } else {
        await api.uploadWorkspaceFile(workspaceId, file.name, await file.text());
      }
      setUploadedFiles(prev => prev.some(f => f === file.name) ? prev : [...prev, file.name]);
    } catch (err: any) {
      alert('上传失败: ' + err.message);
    } finally {
      uploading.current = false;
    }
  };

  const loadSessions = useCallback(async (): Promise<SessionItem[]> => {
    try {
      const res = await api.listRuns({ limit: 100 });
      const bySession = new Map<string, SessionItem>();
      for (const run of res.items ?? []) {
        const key = run.session_id ?? '(未分组)';
        if (!bySession.has(key)) bySession.set(key, { sessionId: run.session_id, runs: [] });
        bySession.get(key)!.runs.push({ id: run.id, goal: run.goal, status: run.status, createdAt: run.created_at });
      }
      const list = [...bySession.values()].slice(0, 20);
      setSessions(list);
      return list;
    } catch { return []; }
  }, []);

  const loadWorkspaces = useCallback(async () => {
    try {
      const res = await api.listWorkspaces();
      setWorkspaces(res.items ?? []);
    } catch { /* 静默 */ }
  }, []);

  useEffect(() => {
    loadSessions().then(() => {
      // 导航/刷新恢复：未手动新建时，自动续接最近一个会话（多轮对话不因离开页面断开）
      setCurrentSessionId(prev => prev ?? null);
    });
    loadWorkspaces();
  }, [loadSessions, loadWorkspaces]);

  const loadSessionThread = useCallback(async (sid: string | null) => {
    if (!sid) { setSessionRuns([]); return; }
    try {
      const res = await api.listRuns({ sessionId: sid, limit: 100 });
      const items = (res.items ?? [])
        .map((r: any) => ({ id: r.id, goal: r.goal, final_content: r.final_content, created_at: r.created_at }))
        .sort((a: any, b: any) => (a.created_at || '').localeCompare(b.created_at || ''));
      setSessionRuns(items);
    } catch { setSessionRuns([]); }
  }, []);

  useEffect(() => { loadSessionThread(currentSessionId); }, [currentSessionId, loadSessionThread]);

  // 活跃 run 终态后刷新线程（补上它的最终回答）
  useEffect(() => {
    if (view.runStatus && ['completed', 'failed', 'cancelled'].includes(view.runStatus)) {
      loadSessionThread(currentSessionId);
    }
  }, [view.runStatus, currentSessionId, loadSessionThread]);

  // 会话列表加载后，若无当前会话则选中最近的（保持续接）
  useEffect(() => {
    if (!currentSessionId && sessions.length > 0 && !activeRunId) {
      setCurrentSessionId(sessions[0].sessionId);
    }
  }, [sessions, currentSessionId, activeRunId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length, view.finalContent]);

  const submit = async () => {
    if (!goal.trim() || submitting) return;
    setSubmitting(true);
    try {
      // 修复（用户反馈）：无会话时生成一个并记住 — 连续多次对话落在同一会话
      const sid = currentSessionId ?? `sess_${Date.now().toString(36)}`;
      setCurrentSessionId(sid);
      const res = await api.createRun({
        goal: goal.trim(),
        sessionId: sid,
        workspaceId: workspaceId || undefined,
        continueSession: true, // 同会话多轮：带上此前的完整对话上下文
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

  const handleDeleteRun = async (runId: string) => {
    if (!confirm('删除这条对话？（事件与检查点一并删除）')) return;
    try {
      await api.deleteRun(runId);
      if (activeRunId === runId) { setActiveRunId(null); setCurrentSessionId(null); }
      await loadSessions();
    } catch (err: any) { alert('删除失败: ' + err.message); }
  };

  const handleDeleteSession = async (sessionId: string | null) => {
    if (!sessionId) { alert('该对话不属于任何会话，请删除单条对话'); return; }
    if (!confirm('删除整个会话（含全部对话记录）？')) return;
    try {
      await api.deleteSession(sessionId);
      if (currentSessionId === sessionId) { setCurrentSessionId(null); }
      if (activeRunId && sessions.some(s => s.sessionId === sessionId && s.runs.some(r => r.id === activeRunId))) {
        setActiveRunId(null);
      }
      await loadSessions();
    } catch (err: any) { alert('删除失败: ' + err.message); }
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
              <div className="flex items-center justify-between px-2 mb-1">
                <p className="text-[10px] text-fg-disabled truncate flex-1" title={s.sessionId ?? '未分组'}>
                  {s.sessionId ? (s.runs[0]?.goal?.slice(0, 18) || '对话') + `（${s.runs.length}）` : '未分组'}
                </p>
                <button
                  onClick={() => handleDeleteSession(s.sessionId)}
                  title="删除整个会话"
                  className="text-fg-disabled hover:text-status-danger cursor-pointer shrink-0"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
              {s.runs.map(r => (
                <button
                  key={r.id}
                  onClick={() => { setActiveRunId(r.id); setCurrentSessionId(s.sessionId); }}
                  className={`w-full text-left p-2 rounded-lg text-xs transition-colors cursor-pointer ${
                    activeRunId === r.id ? 'bg-brand-soft text-brand' : 'text-fg-secondary hover:bg-bg-elev/40'
                  }`}
                >
                  <p className="truncate">{r.goal}</p>
                  <div className="flex items-center justify-between gap-1 mt-0.5">
                    <p className="text-[10px] text-fg-muted truncate">
                      {statusLabel(r.status)} · {new Date(r.createdAt).toLocaleTimeString('zh-CN')}
                    </p>
                    <button
                      onClick={e => { e.stopPropagation(); handleDeleteRun(r.id); }}
                      title="删除此对话"
                      className="text-fg-disabled hover:text-status-danger cursor-pointer shrink-0"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
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
              <option value="">{workspaces.length === 0 ? "未创建工作区（设置页可创建）" : "不绑定工作区"}</option>
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

          {/* 会话线程：此前的轮次（静态问答气泡）— 多轮对话连续视图 */}
          {sessionRuns
            .filter(r => r.id !== activeRunId)
            .map(r => (
              <div key={r.id} className="space-y-3">
                <div className="flex justify-end">
                  <div className="max-w-[80%] bg-brand text-white rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words">{r.goal}</div>
                </div>
                {(r.final_content || '').trim() && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] glass border border-glass-border rounded-2xl px-4 py-3">
                      <p className="text-sm text-fg-primary whitespace-pre-wrap break-words">{r.final_content}</p>
                    </div>
                  </div>
                )}
              </div>
            ))}
          {activeRunId && <RunLiveView goal={sessions.flatMap(s => s.runs).find(r => r.id === activeRunId)?.goal ?? sessionRuns.find(r => r.id === activeRunId)?.goal ?? ''} view={view} events={events} streamingText={streamingText} fullFinal={fullFinal} onDecide={decide} />}
          <div ref={bottomRef} />
        </div>

        {/* 输入区 */}
        <div className="p-4 glass border-t border-glass-border rounded-none">
          {uploadedFiles.length > 0 && (
            <div className="max-w-4xl mx-auto mb-2 flex flex-wrap gap-1.5">
              {uploadedFiles.map(name => (
                <span key={name} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-status-success/10 text-status-success border border-status-success/30">
                  <Type className="w-3 h-3" /> {name}
                  <button className="text-status-success/60 hover:text-status-danger cursor-pointer" title="从列表移除" onClick={() => setUploadedFiles(prev => prev.filter(f => f !== name))}>×</button>
                </span>
              ))}
            </div>
          )}
          <div className="max-w-4xl mx-auto flex gap-3 items-end">
            <Textarea
              value={goal}
              onChange={e => setGoal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
              placeholder="描述你的目标…（Enter 发送，Shift+Enter 换行）"
              rows={1}
              className="flex-1"
            />
            <label
              className="cursor-pointer p-2 rounded-lg hover:bg-bg-elev/40 text-fg-muted hover:text-brand"
              title={workspaceId ? '上传文件到工作区' : '先在设置页创建工作区，才能上传文件'}
              onClick={e => { if (!workspaceId) { e.preventDefault(); alert('上传需要先绑定工作区：请到「设置」页创建工作区（绑定一个本地文件夹），然后在顶部选择它。'); } }}
            >
              <Upload className="w-4 h-4" />
              <input type="file" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = ''; }} />
            </label>
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
  streamingText,
  fullFinal,
  onDecide,
}: {
  goal: string;
  view: ReturnType<typeof deriveRunView>;
  events: RunEventItem[];
  streamingText: string;
  fullFinal: string | null;
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

      {/* 创新①：流式直播中的回答 */}
      {streamingText && !view.finalContent && (
        <div className="flex justify-start">
          <div className="max-w-[85%] glass border border-glass-border rounded-2xl px-4 py-3">
            <p className="text-sm text-fg-primary whitespace-pre-wrap break-words">{streamingText}<span className="animate-pulse">▍</span></p>
          </div>
        </div>
      )}

      {/* 最终回答 */}
      {(fullFinal ?? view.finalContent) && (
        <div className="flex justify-start">
          <div className="max-w-[85%] glass border border-glass-border rounded-2xl px-4 py-3">
            <p className="text-sm text-fg-primary whitespace-pre-wrap break-words">{fullFinal ?? view.finalContent}</p>
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
