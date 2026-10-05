import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bot, Send, FolderOpen, CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight,
  Plus, History, Square, Wrench, ShieldAlert, ListTodo, Upload, Type, Trash2, MessageSquare,
  FolderPlus, Activity, ChevronDown as ChevronDownIcon, GitBranch,
} from 'lucide-react';
import { api } from '../api/client';
import { Button, Card, Tag, Textarea, Select, EmptyState, Modal, Input } from '../components/ui';
import { useRunStream, deriveRunView, type RunEventItem } from '../hooks/useRunStream';

/**
 * M1-8：Chat 页升级 — 真 agent 会话。
 *  · 提交 → POST /api/runs（带 sessionId / workspaceId）→ 事件流内联直播
 *  · 工具调用卡片（输入/结果可展开）、todo checklist、审批 diff 卡片
 *  · 左侧：历史会话（runs 按 sessionId 分组）
 */

interface SessionItem {
  sessionId: string | null;
  runs: Array<{ id: string; goal: string; status: string; createdAt: string; parentId?: string | null }>;
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
  // 工作区选择持久化：刷新/重开浏览器不丢（存在性在列表加载后校验）
  const [workspaceId, setWorkspaceId] = useState<string>(() => localStorage.getItem('coral.workspaceId') ?? '');
  const [wsModal, setWsModal] = useState<{ open: boolean; name: string; dir: string; permission: string; error: string }>({ open: false, name: '', dir: '', permission: 'ask', error: '' });
  // 附件暂存（staging）语义：uploadedFiles 只代表"将随下一条消息发送"的文件 —
  // 发送成功即消耗并转移到对应消息上（runAttachments 供线程展示），不再跨轮累积注入。
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([]);
  const [runAttachments, setRunAttachments] = useState<Record<string, string[]>>({});
  // 最终回答全文（run.completed 事件只带 500 字预览，终态后从详情拉全文）
  const [fullFinal, setFullFinal] = useState<string | null>(null);
  // 会话线程：当前会话全部 run（时间升序，含 final_content）— ChatGPT 式连续对话视图
  const [sessionRuns, setSessionRuns] = useState<Array<{ id: string; goal: string; final_content?: string | null; created_at: string; parent_run_id?: string | null; fork_from_seq?: number | null }>>([]);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const { events, connected } = useRunStream(activeRunId ?? undefined);
  const view = useMemo(() => deriveRunView(events), [events]);

  // 创新①：流式直播 — 聚合 loop.delta 事件为当前流式文本
  const streamingText = useMemo(() => {
    if (view.runStatus) return ''; // 已终态，finalContent 取代
    const raw = events.filter(e => e.type === 'loop.delta').map(e => e.payload?.delta ?? '').join('');
    // DSML 抑制兜底：退化原文若混入增量，截到第一个标记前（全角/ASCII 双形态）
    let cut = raw.indexOf('<｜');
    const cut2 = raw.indexOf('<<');
    if (cut2 >= 0 && (cut < 0 || cut2 < cut)) cut = cut2;
    return cut >= 0 ? raw.slice(0, cut) : raw;
  }, [events, view.runStatus]);
  const uploading = useRef(false);
  // 拉取最终回答全文（事件只带 500 字预览，终态后从详情拉全文）
  useEffect(() => {
    setFullFinal(null);
    if (!activeRunId || !view.runStatus || !['completed', 'failed', 'cancelled'].includes(view.runStatus)) return;
    let cancelled = false;
    api.getRun(activeRunId).then((d: any) => {
      if (!cancelled && d?.run?.final_content) setFullFinal(d.run.final_content);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeRunId, view.runStatus]);

  const handleCreateWorkspace = async () => {
    setWsModal(m => ({ ...m, error: '' }));
    try {
      const ws = await api.createWorkspace({ name: wsModal.name, dir: wsModal.dir, permission: wsModal.permission });
      setWsModal({ open: false, name: '', dir: '', permission: 'ask', error: '' });
      await loadWorkspaces();
      setWorkspaceId(ws.id);
    } catch (err: any) {
      setWsModal(m => ({ ...m, error: err.message }));
    }
  };

  const changePermission = async (perm: string) => {
    if (!workspaceId) return;
    try {
      await api.updateWorkspace(workspaceId, { permission: perm });
      await loadWorkspaces();
    } catch (err: any) { alert('权限修改失败: ' + err.message); }
  };

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

  // 会话集：fork 出的新会话经 parent_run_id 血缘归入源会话的集合（主题相同 = 一个合集）
  const [collections, setCollections] = useState<Array<{ root: string; sessions: SessionItem[]; topic: string }>>([]);
  const [expandedSets, setExpandedSets] = useState<Set<string>>(new Set()); // 对话集折叠状态
  const loadSessions = useCallback(async (): Promise<SessionItem[]> => {
    try {
      const res = await api.listRuns({ limit: 100 });
      const allRuns = (res.items ?? []).filter((r: any) => r.mode !== 'graph');
      const bySession = new Map<string, SessionItem>();
      const runSession = new Map<string, string | null>(allRuns.map((r: any) => [r.id, r.session_id]));
      for (const run of allRuns) {
        const key = run.session_id ?? '(未分组)';
        if (!bySession.has(key)) bySession.set(key, { sessionId: run.session_id, runs: [] });
        bySession.get(key)!.runs.push({ id: run.id, goal: run.goal, status: run.status, createdAt: run.created_at, parentId: run.parent_run_id });
      }
      // 血缘求根：会话内任一 run 的 parent 指向别的会话 → 根 = 那个会话的根
      const rootOf = (sid: string | null, seen = new Set<string>()): string => {
        const key = sid ?? '(未分组)';
        if (!sid || seen.has(key)) return key;
        seen.add(key);
        const s = bySession.get(key);
        const forkRun = s?.runs.find(r => r.parentId);
        if (forkRun) {
          const ps = runSession.get(forkRun.parentId!);
          if (ps && ps !== sid) return rootOf(ps, seen);
        }
        return key;
      };
      const byRoot = new Map<string, SessionItem[]>();
      for (const [sid, s] of bySession) {
        const root = rootOf(sid);
        if (!byRoot.has(root)) byRoot.set(root, []);
        byRoot.get(root)!.push(s);
      }
      const cols = [...byRoot.values()]
        .map(group => {
          // 集合内会话线按首 run 时间排序（源对话在上，分支对话在下）
          group.sort((a, b) => (a.runs[0]?.createdAt ?? '').localeCompare(b.runs[0]?.createdAt ?? ''));
          // 集合头主题取最新会话的首 goal（最接近当前话题）
          const latest = group[group.length - 1];
          return { root: group[0].sessionId ?? '(未分组)', sessions: group, topic: latest.runs[0]?.goal ?? '' };
        })
        .sort((a, b) => (b.sessions.at(-1)?.runs.at(-1)?.createdAt ?? '').localeCompare(a.sessions.at(-1)?.runs.at(-1)?.createdAt ?? ''))
        .slice(0, 20);
      setCollections(cols);
      const list = [...bySession.values()].slice(0, 20);
      setSessions(list);
      return list;
    } catch { return []; }
  }, []);

  const loadWorkspaces = useCallback(async () => {
    try {
      const res = await api.listWorkspaces();
      const items = res.items ?? [];
      setWorkspaces(items);
      // 已存的选中项失效（被删）则清空
      setWorkspaceId(prev => (prev && !items.some((w: any) => w.id === prev) ? '' : prev));
    } catch { /* 静默 */ }
  }, []);

  useEffect(() => {
    if (workspaceId) localStorage.setItem('coral.workspaceId', workspaceId);
    else localStorage.removeItem('coral.workspaceId');
  }, [workspaceId]);

  useEffect(() => {
    // 导航/刷新恢复：自动续接最近会话的逻辑在下方 effect（sessions 变化时）
    loadSessions();
    loadWorkspaces();
  }, [loadSessions, loadWorkspaces]);

  const loadSessionThread = useCallback(async (sid: string | null) => {
    if (!sid) { setSessionRuns([]); return; }
    try {
      const res = await api.listRuns({ sessionId: sid, limit: 100 });
      const items = (res.items ?? []).filter((r: any) => r.mode !== 'graph')
        .map((r: any) => ({ id: r.id, goal: r.goal, final_content: r.final_content, created_at: r.created_at, parent_run_id: r.parent_run_id, fork_from_seq: r.fork_from_seq }))
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
      // 上传上下文注入：明确告诉 agent 用户刚传了哪些文件（消除与磁盘旧文件的歧义）
      const attached = uploadedFiles; // 发送瞬间的快照（await 期间新上传的不属于本条消息）
      const uploadNote = attached.length > 0
        ? `## 用户刚上传的文件（工作区根目录）\n${attached.map(f => `- ${f}`).join('\n')}\n当用户提到"这份文件 / 我上传的文件 / 刚传的文件"时，优先指上述文件（而非工作区里的其他旧文件）。`
        : undefined;
      const res = await api.createRun({
        goal: goal.trim(),
        sessionId: sid,
        workspaceId: workspaceId || undefined,
        continueSession: true, // 同会话多轮：带上此前的完整对话上下文
        extraSystem: uploadNote,
      });
      // 附件已随本条消息消耗：转到消息上展示，暂存区移除（后续轮次靠会话历史关联文件）
      if (attached.length > 0) {
        setRunAttachments(prev => ({ ...prev, [res.runId]: attached }));
        setUploadedFiles(prev => prev.filter(f => !attached.includes(f)));
      }
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

  // 预算超限后续接：同会话新 run，checkpoint 续接上一轮进度，预算按 run 重置。
  // 不注入 uploadNote — 续接围绕上一轮任务，附件若需要会由用户随下一条消息再发。
  const continueRun = async () => {
    if (!currentSessionId || submitting) return;
    setSubmitting(true);
    try {
      const res = await api.createRun({
        // 终审 P2：续接 goal 聚焦"完成剩余项"（配合 checkpoint 续接，模型直接从断点继续）
        goal: '继续：上一轮因预算中断，请直接从上次进度继续（已完成的部分不要重做），完成剩余步骤并产出最终成果。若中途需要长篇输出，请分步写盘再合并，避免单次超长。',
        sessionId: currentSessionId,
        workspaceId: workspaceId || undefined,
        continueSession: true,
      });
      setActiveRunId(res.runId);
      loadSessions();
    } catch (err: any) {
      alert('续接失败: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    if (!activeRunId) return;
    try {
      await api.cancelRun(activeRunId);
    } catch { /* ignore */ }
  };

  /** 侧栏单条会话条目（集合内嵌入时缩进） */
  const renderSessionItem = (s: SessionItem, nested = false) => {
    const isSession = Boolean(s.sessionId);
    const active = isSession ? currentSessionId === s.sessionId : activeRunId === s.runs[0]?.id;
    const title = s.runs[0]?.goal?.slice(0, 24) || '对话';
    return (
      <div
        key={s.sessionId ?? `ungrouped-${s.runs[0]?.id}`}
        className={`group flex items-center gap-2 w-full text-left p-2.5 text-xs transition-colors cursor-pointer ${nested ? 'pl-4' : ''} ${
          active ? 'bg-brand-soft text-brand border border-brand/20' : 'text-fg-secondary hover:bg-bg-elev/40 border border-transparent'
        }`}
        onClick={() => {
          if (isSession) {
            setCurrentSessionId(s.sessionId);
            setActiveRunId(s.runs.at(-1)?.id ?? null);
          } else {
            setActiveRunId(s.runs[0]?.id ?? null);
            setCurrentSessionId(null);
          }
        }}
      >
        <MessageSquare className="w-3.5 h-3.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="truncate">{title}</p>
          <p className="text-[10px] text-fg-muted mt-0.5">
            {s.runs.length > 1 ? `${s.runs.length} 轮 · ` : ''}{statusLabel(s.runs.at(-1)?.status ?? '')} · {new Date(s.runs.at(-1)?.createdAt ?? 0).toLocaleDateString('zh-CN')}
          </p>
        </div>
        <button
          onClick={e => {
            e.stopPropagation();
            if (isSession) handleDeleteSession(s.sessionId);
            else handleDeleteRun(s.runs[0]?.id ?? '');
          }}
          title={isSession ? '删除此条对话线' : '删除此对话'}
          className="opacity-0 group-hover:opacity-100 text-fg-disabled hover:text-status-danger cursor-pointer shrink-0 transition-opacity"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  };

  return (
    <div className="flex h-screen">
      {/* 左侧：历史会话 */}
      <aside className="w-64 shrink-0 border-r border-glass-border glass rounded-none flex flex-col">
        <div className="p-3 border-b border-glass-border flex items-center justify-between">
          <span className="text-xs text-fg-muted flex items-center gap-1"><History className="w-3.5 h-3.5" /> 历史会话</span>
          <button
            onClick={() => { setActiveRunId(null); setCurrentSessionId(`sess_${Date.now().toString(36)}`); setUploadedFiles([]); }}
            className="text-xs text-brand hover:text-brand-hover flex items-center gap-1 cursor-pointer"
            title="开始新会话"
          >
            <Plus className="w-3.5 h-3.5" /> 新建
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sessions.length === 0 && <p className="text-xs text-fg-muted p-2">暂无历史</p>}
          {collections.map(col => {
            // 单会话 = 单条目；多会话 = 可折叠对话集（点开看全部对话线：原对话 + 分支）
            if (col.sessions.length <= 1) {
              const s = col.sessions[0];
              return renderSessionItem(s);
            }
            const expanded = expandedSets.has(col.root);
            const totalRuns = col.sessions.reduce((n, s) => n + s.runs.length, 0);
            return (
              <div key={col.root} className="rounded-lg border border-glass-border/60 overflow-hidden">
                <button
                  onClick={() => setExpandedSets(prev => {
                    const next = new Set(prev);
                    next.has(col.root) ? next.delete(col.root) : next.add(col.root);
                    return next;
                  })}
                  className="w-full px-2.5 py-1.5 bg-bg-elev/40 text-[11px] text-fg-secondary flex items-center gap-1.5 cursor-pointer hover:bg-bg-elev/60 text-left">
                  {expanded ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
                  <GitBranch className="w-3 h-3 text-brand shrink-0" />
                  <span className="truncate flex-1 font-medium">{col.topic.slice(0, 22)}…</span>
                  <span className="text-fg-muted shrink-0">{col.sessions.length} 线 · {totalRuns} 轮</span>
                </button>
                {expanded && (
                  <div className="pb-1">
                    <p className="px-3 pt-1 text-[10px] text-fg-muted">对话线（互不影响，可独立打开/删除）：</p>
                    {col.sessions.map(s => renderSessionItem(s, true))}
                  </div>
                )}
              </div>
            );
          })}
          {/* 旧渲染已由 collections 取代 */}
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
          {/* 工作区选择器 + 快捷新建 + 权限快改 */}
          <div className="flex items-center gap-2 text-xs">
            <FolderOpen className="w-4 h-4 text-fg-muted" />
            <Select
              value={workspaceId}
              onChange={e => {
                if (e.target.value === '__new__') { setWsModal({ open: true, name: '', dir: '', permission: 'ask', error: '' }); return; }
                setWorkspaceId(e.target.value);
              }}
              className="!w-52 text-xs"
            >
              <option value="">{workspaces.length === 0 ? '未绑定工作区' : '不绑定工作区'}</option>
              {workspaces.map(w => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
              <option value="__new__">＋ 新建工作区…</option>
            </Select>
            {workspaceId && (
              <Select
                value={workspaces.find(w => w.id === workspaceId)?.permission ?? 'ask'}
                onChange={e => changePermission(e.target.value)}
                className="!w-24 text-xs"
                title="工作区权限档：写改是否需要审批"
              >
                <option value="readonly">只读</option>
                <option value="ask">写改询问</option>
                <option value="auto">全自动</option>
              </Select>
            )}
            <button
              onClick={() => setWsModal({ open: true, name: '', dir: '', permission: 'ask', error: '' })}
              className="p-1 rounded-md text-fg-muted hover:text-brand hover:bg-bg-elev/40 cursor-pointer"
              title="新建工作区"
            >
              <FolderPlus className="w-4 h-4" />
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
              <div key={r.id} className={`space-y-3 ${r.parent_run_id ? 'ml-8 border-l-2 border-brand/30 pl-3' : ''}`}>
                {r.parent_run_id && (
                  <div className="text-[11px] text-brand/80 font-mono">🌿 分支（{r.parent_run_id.slice(0, 12)}…{r.fork_from_seq != null ? `第${r.fork_from_seq}步起` : ''}）</div>
                )}
                <div className="flex justify-end">
                  <div className="max-w-[80%] bg-brand text-white rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words">{r.goal}</div>
                </div>
                <SentAttachments names={runAttachments[r.id]} />
                <ProcessSection runId={r.id} defaultOpen={false} />
                {(r.final_content || '').trim() && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] glass border border-glass-border rounded-2xl px-4 py-3">
                      <p className="text-sm text-fg-primary whitespace-pre-wrap break-words">{r.final_content}</p>
                    </div>
                  </div>
                )}
              </div>
            ))}
          {activeRunId && <RunLiveView goal={sessions.flatMap(s => s.runs).find(r => r.id === activeRunId)?.goal ?? sessionRuns.find(r => r.id === activeRunId)?.goal ?? ''} attachments={runAttachments[activeRunId]} view={view} events={events} streamingText={streamingText} fullFinal={fullFinal} onDecide={decide} onContinue={continueRun} />}
          <div ref={bottomRef} />
        </div>

        {/* 输入区 */}
        <div className="p-4 glass border-t border-glass-border rounded-none">
          {uploadedFiles.length > 0 && (
            <div className="max-w-4xl mx-auto mb-2 flex flex-wrap gap-1.5 items-center">
              {uploadedFiles.map(name => (
                <span key={name} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-status-success/10 text-status-success border border-status-success/30">
                  <Type className="w-3 h-3" /> {name}
                  <button className="text-status-success/60 hover:text-status-danger cursor-pointer" title="从列表移除" onClick={() => setUploadedFiles(prev => prev.filter(f => f !== name))}>×</button>
                </span>
              ))}
              <span className="text-[11px] text-fg-muted ml-1">将随下一条消息一并发送，发送后自动移除</span>
            </div>
          )}
          <div className="max-w-4xl mx-auto flex gap-3 items-end">
            <Textarea
              value={goal}
              onChange={e => {
                setGoal(e.target.value);
                // 输入框自适应高度（2~12 行）
                const el = e.target as HTMLTextAreaElement;
                el.style.height = 'auto';
                el.style.height = Math.min(el.scrollHeight, 288) + 'px';
              }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
              placeholder="描述你的目标…（Enter 发送，Shift+Enter 换行）"
              rows={2}
              className="flex-1 resize-none"
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

        {/* 新建工作区弹窗 */}
        <Modal
          open={wsModal.open}
          onClose={() => setWsModal(m => ({ ...m, open: false }))}
          title="新建工作区"
          footer={
            <>
              <Button variant="ghost" onClick={() => setWsModal(m => ({ ...m, open: false }))}>取消</Button>
              <Button onClick={handleCreateWorkspace} disabled={!wsModal.name.trim() || !wsModal.dir.trim()}>创建并使用</Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <div>
              <label className="block text-xs text-fg-muted mb-1">名称</label>
              <Input value={wsModal.name} onChange={e => setWsModal(m => ({ ...m, name: e.target.value }))} placeholder="我的项目" />
            </div>
            <div>
              <label className="block text-xs text-fg-muted mb-1">本地文件夹完整路径（须已存在）</label>
              <Input value={wsModal.dir} onChange={e => setWsModal(m => ({ ...m, dir: e.target.value }))} placeholder="D:\\projects\\my-notes" />
              <p className="text-[10px] text-fg-muted mt-1">提示：资源管理器地址栏复制路径粘贴即可</p>
            </div>
            <div>
              <label className="block text-xs text-fg-muted mb-1">权限档</label>
              <Select value={wsModal.permission} onChange={e => setWsModal(m => ({ ...m, permission: e.target.value }))}>
                <option value="ask">询问（默认，写改弹 diff 批准）</option>
                <option value="readonly">只读</option>
                <option value="auto">全自动（写改直接执行）</option>
              </Select>
            </div>
            {wsModal.error && <p className="text-xs text-status-danger">{wsModal.error}</p>}
          </div>
        </Modal>
      </div>
    </div>
  );
}

/**
 * 执行过程区块（深度思考式）：liveView 提供时 = 活跃 run 直播（终态自动折叠）；
 * 否则 = 历史轮次，首次展开时从 API 拉事件回放。
 */
function ProcessSection({
  runId,
  liveView,
  defaultOpen = false,
}: {
  runId?: string;
  liveView?: ReturnType<typeof deriveRunView>;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [loaded, setLoaded] = useState<ReturnType<typeof deriveRunView> | null>(null);

  useEffect(() => {
    if (!open || liveView || loaded || !runId) return;
    let cancelled = false;
    api.getRun(runId).then((d: any) => {
      if (!cancelled) setLoaded(deriveRunView(d.events ?? []));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [open, runId, liveView, loaded]);

  const isTerminal = Boolean(liveView?.runStatus && ['completed', 'failed', 'cancelled'].includes(liveView.runStatus));
  const prevTerminal = useRef(false);
  useEffect(() => {
    if (isTerminal && !prevTerminal.current) setOpen(false);
    prevTerminal.current = isTerminal;
  }, [isTerminal]);

  const v = liveView ?? loaded;
  const toolCount = v?.toolCards.length ?? 0;
  const running = Boolean(liveView) && !liveView!.runStatus;

  return (
    <div className="glass rounded-xl border border-glass-border overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-xs cursor-pointer text-left hover:bg-bg-elev/30"
        onClick={() => setOpen(o => !o)}
      >
        {running
          ? <Loader2 className="w-3.5 h-3.5 text-status-info animate-spin shrink-0" />
          : <Activity className="w-3.5 h-3.5 text-fg-muted shrink-0" />}
        <span className="text-fg-secondary font-medium">{running ? '正在执行…' : '执行过程'}</span>
        {v && (
          <span className="text-fg-muted">
            {toolCount} 次工具调用{v.todos.length > 0 ? ' · ' + v.todos.filter(t => t.status === 'completed').length + '/' + v.todos.length + ' 项任务' : ''}
          </span>
        )}
        <span className="flex-1" />
        {open ? <ChevronDownIcon className="w-3.5 h-3.5 text-fg-muted" /> : <ChevronRight className="w-3.5 h-3.5 text-fg-muted" />}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 max-h-[480px] overflow-y-auto">
          {!v && <p className="text-xs text-fg-muted py-2">加载事件中…</p>}
          {v && <ToolCardsView view={v} running={running} />}
        </div>
      )}
    </div>
  );
}

/** 已发送消息的附件标记（只读、弱化样式 — 告诉用户文件跟着哪条消息走了） */
function SentAttachments({ names }: { names?: string[] }) {
  if (!names || names.length === 0) return null;
  return (
    <div className="flex justify-end">
      <div className="flex flex-wrap gap-1.5 justify-end">
        {names.map(name => (
          <span key={name} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] text-fg-muted bg-bg-elev/40 border border-glass-border">
            <Upload className="w-3 h-3" /> {name}
          </span>
        ))}
      </div>
    </div>
  );
}

/** todo 清单 + 工具卡片（ProcessSection 内容体，直播/回放共用） */
function ToolCardsView({ view, running }: { view: ReturnType<typeof deriveRunView>; running?: boolean }) {
  const [openCards, setOpenCards] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpenCards(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <>
      {view.todos.length > 0 && (
        <div className="pt-1">
          <h4 className="text-[10px] text-fg-muted mb-1 flex items-center gap-1"><ListTodo className="w-3 h-3" /> 任务清单</h4>
          <ul className="space-y-1">
            {view.todos.map((t, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                {t.status === 'completed' ? <CheckCircle2 className="w-3.5 h-3.5 text-status-success shrink-0 mt-0.5" />
                  : t.status === 'in_progress' ? <Loader2 className="w-3.5 h-3.5 text-status-info animate-spin shrink-0 mt-0.5" />
                  : <span className="w-3.5 h-3.5 rounded-full border border-glass-borderStrong shrink-0 mt-0.5" />}
                <span className={t.status === 'completed' ? 'text-fg-muted line-through' : 'text-fg-primary'}>{t.content}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {view.todos.length === 0 && running && (
        <p className="text-[11px] text-fg-muted py-0.5">任务清单创建中 — agent 开工后会先列出计划步骤…</p>
      )}
      {view.toolCards.map(card => {
        const open = openCards.has(card.callId);
        const subAgent = card.agentId !== 'main';
        return (
          <div key={card.callId} className={'rounded-lg border ' + (card.status === 'failed' ? 'border-status-danger/30' : 'border-glass-border') + ' bg-bg-panel/40' + (subAgent ? ' ml-4' : '')}>
            <button className="w-full flex items-center gap-2 px-2.5 py-2 cursor-pointer text-left" onClick={() => toggle(card.callId)}>
              {card.status === 'running' ? <Loader2 className="w-3.5 h-3.5 text-status-info animate-spin shrink-0" />
                : card.status === 'ok' ? <CheckCircle2 className="w-3.5 h-3.5 text-status-success shrink-0" />
                : <XCircle className="w-3.5 h-3.5 text-status-danger shrink-0" />}
              <Wrench className="w-3 h-3 text-fg-muted shrink-0" />
              <span className="text-xs font-medium text-fg-primary flex-1 truncate">{card.tool}</span>
              {subAgent && <Tag variant="brand">{card.agentId}</Tag>}
              {open ? <ChevronDown className="w-3.5 h-3.5 text-fg-muted" /> : <ChevronRight className="w-3.5 h-3.5 text-fg-muted" />}
            </button>
            {open && (
              <div className="px-2.5 pb-2 space-y-1.5">
                {card.inputPreview && (
                  <div>
                    <p className="text-[10px] text-fg-muted mb-0.5">输入</p>
                    <pre className="bg-bg-panel/70 rounded p-1.5 text-[10px] font-mono text-fg-secondary overflow-auto max-h-32 whitespace-pre-wrap break-all">{card.inputPreview}</pre>
                  </div>
                )}
                {card.resultPreview && (
                  <div>
                    <p className="text-[10px] text-fg-muted mb-0.5">结果</p>
                    <pre className="bg-bg-panel/70 rounded p-1.5 text-[10px] font-mono text-fg-secondary overflow-auto max-h-40 whitespace-pre-wrap break-all">{card.resultPreview}</pre>
                  </div>
                )}
                {card.error && <p className="text-[10px] text-status-danger">{card.error}</p>}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function statusLabel(s: string): string {
  return ({ created: '已创建', running: '运行中', waiting_human: '等待审批', completed: '已完成', failed: '已失败', cancelled: '已取消' } as Record<string, string>)[s] ?? s;
}

/** 单个 run 的直播视图（goal + todo + 工具卡 + 审批 + 最终回答） */
function RunLiveView({
  goal,
  attachments,
  view,
  events,
  streamingText,
  fullFinal,
  onDecide,
  onContinue,
}: {
  goal: string;
  attachments?: string[];
  view: ReturnType<typeof deriveRunView>;
  events: RunEventItem[];
  streamingText: string;
  fullFinal: string | null;
  onDecide: (approvalId: string, approved: boolean) => void;
  onContinue?: () => void;
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
      <SentAttachments names={attachments} />

      {/* 执行过程（深度思考式：运行中实时展开，完成后折叠可回看） */}
      <ProcessSection liveView={view} defaultOpen={!view.runStatus} />

      {/* 工具卡片（保留用于直播中紧跟过程展示 — ProcessSection 已含，此块留空防重复） */}
      {false && view.toolCards.map(card => {
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
              <div className="mt-2 flex items-center gap-2">
                <p className="text-xs text-status-warn">⚠ 预算达到上限，以上为部分成果总结</p>
                {onContinue && (
                  <Button size="sm" variant="secondary" onClick={onContinue}>继续执行</Button>
                )}
              </div>
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
