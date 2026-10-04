import { useCallback, useEffect, useMemo, useState } from 'react';
import { History, GitBranch, Loader2, CornerUpLeft, ChevronDown, ChevronRight, Scan, HelpCircle, Eye, EyeOff, Trash2, ArrowLeft, MessageSquare } from 'lucide-react';
import { api } from '../api/client';
import { Tag } from '../components/ui';

/**
 * M4-1：Time-Travel — 两级导航（对话 → run/分支 → checkpoint）+ fork。
 * 用户实测迭代：
 * · v3 两级导航：先选对话（会话），再选该对话里的 run/分支 — 分支归属一目了然
 * · fork 生成新对话 B（继承上下文），A 不变；B 与 A 在对话页归入同一对话集
 * · 轮询热更新：fork 后 status running → completed 自动刷新
 */

interface RunItem { id: string; goal: string; status: string; mode: string; session_id: string | null; parent_run_id: string | null; fork_from_seq?: number | null; created_at: string }
interface SessionGroup { sessionId: string; runs: RunItem[]; branchCount: number; topic: string; lastAt: string }
interface CpPreviewMsg { role: string; toolName: string | null; contentPreview: string; toolCalls?: string[] }
interface CpItem { seq: number; kind: string; label: string; createdAt: string; messageCount: number; preview: CpPreviewMsg[] }

function describeTool(toolName: string, resultPreview: string): string {
  const path = (resultPreview.match(/"path"\s*:\s*"([^"]{1,80})"/) || [])[1];
  const url = (resultPreview.match(/"url"\s*:\s*"([^"]{1,80})"/) || [])[1];
  if (toolName === 'fs_read' || toolName === 'docx_read') return `读取 ${path ?? '文件'}`;
  if (toolName === 'fs_write') return `写入文件 ${path ?? ''}`;
  if (toolName === 'fs_edit') return `编辑文件 ${path ?? ''}`;
  if (toolName === 'docx_write') return `生成 Word ${path ?? ''}`;
  if (toolName === 'fs_list') return '查看文件列表';
  if (toolName === 'fs_search') return `搜索文件${path ? `（${path}）` : ''}`;
  if (toolName === 'http_fetch') return `抓取网页 ${url ?? ''}`;
  if (toolName === 'todo_write') return '更新任务清单';
  if (toolName === 'memory_search') return '查找长期记忆';
  if (toolName === 'memory_write' || toolName === 'memory_read' || toolName === 'memory_list') return '读写长期记忆';
  if (toolName === 'shell_run') return '执行命令';
  if (toolName === 'agent_spawn') return '派出子代理';
  if (toolName.startsWith('skill_')) return `执行技能 ${toolName.replace(/^skill_/, '')}`;
  return `调用 ${toolName}`;
}

interface StoryLine { icon: string; text: string }

function messagesToStory(msgs: CpPreviewMsg[]): StoryLine[] {
  const lines: StoryLine[] = [];
  let lastToolDesc = '';
  let toolRun = 0;
  const flushTools = () => {
    if (toolRun > 0) lines.push({ icon: '🔧', text: lastToolDesc + (toolRun > 1 ? ` ×${toolRun}` : '') });
    toolRun = 0;
  };
  for (const m of msgs) {
    const content = m.contentPreview ?? '';
    if (m.role === 'tool') {
      if (!m.toolName) continue;
      const desc = describeTool(m.toolName, content);
      if (desc === lastToolDesc) toolRun++;
      else { flushTools(); lastToolDesc = desc; toolRun = 1; }
      continue;
    }
    flushTools();
    if (m.role === 'user') {
      if (content.startsWith('[system]')) continue;
      lines.push({ icon: '👤', text: `你说：${content.slice(0, 80)}` });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.toolCalls?.length) continue;
      const trimmed = content.trim();
      if (!trimmed || trimmed.startsWith('[调用工具')) continue;
      const firstLine = trimmed.split('\n').find(l => l.trim()) ?? trimmed;
      lines.push({ icon: '🤖', text: `Agent 回答：${firstLine.slice(0, 80)}` });
    }
  }
  flushTools();
  return lines;
}

function classifyCheckpoint(preview: CpPreviewMsg[]): { badge: string; cls: string; hint: string } {
  const last = preview[preview.length - 1];
  const isNarration = (t: string) =>
    /^(I'll|I will|Let me|Now I|Next I|First,? I|I'm going to|Now,? let|我来|我将|接下来|让我)/i.test(t.trim()) && t.length < 300;
  const lastIsAssistantAnswer = last?.role === 'assistant' && !last.toolCalls
    && !(last.contentPreview ?? '').startsWith('[调用工具')
    && !isNarration(last?.contentPreview ?? 'x'.repeat(400));
  if (preview.length <= 2) {
    return { badge: '起点', cls: 'text-fg-muted border-glass-borderStrong', hint: '刚收到目标 — 从这里 fork 等于重来一遍' };
  }
  if (lastIsAssistantAnswer) {
    return { badge: '✅ 阶段完成点 · 最适合分叉', cls: 'text-status-success border-status-success/40', hint: 'Agent 刚交付了一轮结果 — 在此写新指令，它会带着全部已有成果换方向' };
  }
  return { badge: '执行中段', cls: 'text-fg-muted border-glass-borderStrong', hint: '当时正在连续调用工具 — 从这里 fork 会重试未完成的步骤' };
}

function GuidePanel() {
  const [open, setOpen] = useState(() => localStorage.getItem('coral.tt.guide') !== '1');
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-fg-muted flex items-center gap-1 cursor-pointer hover:text-brand">
        <HelpCircle className="w-3.5 h-3.5" /> Time-Travel 是什么？怎么选？（附例子）
      </button>
    );
  }
  return (
    <div className="glass rounded-xl border border-glass-border p-4 text-xs text-fg-secondary leading-6">
      <div className="flex items-center gap-2 mb-2">
        <HelpCircle className="w-4 h-4 text-brand" />
        <span className="font-medium text-fg-primary">Time-Travel 使用指引</span>
        <span className="flex-1" />
        <button onClick={() => { setOpen(false); localStorage.setItem('coral.tt.guide', '1'); }}
          className="text-fg-muted hover:text-fg-primary cursor-pointer">收起</button>
      </div>
      <p><b>怎么用</b>：① 选一个<b>对话</b> → ② 选该对话里的一次运行（分支带 🌿 标记）→ ③ 时间轴上找 <span className="text-status-success">✅ 阶段完成点</span>（Agent 刚交付结果的时刻）→ ④ 写新指令点 Fork。</p>
      <p className="mt-2"><b>Fork 后发生什么</b>：会生成一个<b>新对话</b>（继承所选时刻之前的全部上下文——读过的文件、做过的结论都在），原对话完全不变。新对话和原对话在「对话」页属于同一个对话集（主题相同），可在那里继续聊。</p>
      <p className="mt-2"><b>例子</b>：对话 A 里 Agent 已"总结了报告并生成 Word"（第一个完成点），后面又"生成了对比文档"（第二个完成点）。想要"从成本角度重新总结"？选第一个完成点 → 写"改成从成本角度重新总结" → Fork → 新对话 B 带着 A 的文件阅读成果按新角度重做。</p>
    </div>
  );
}

export default function TimeTravelPage() {
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<CpItem[]>([]);
  const [activeCp, setActiveCp] = useState<number | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const d = await api.listRuns({ limit: 50 });
      setRuns((d.items ?? []).filter((r: any) => r.mode !== 'graph'));
    } catch { /* ignore */ }
  }, []);

  const loadCheckpointsMeta = useCallback(async (runId: string) => {
    try {
      const d = await api.getRunCheckpoints(runId);
      setCheckpoints(d.items ?? []);
    } catch { setCheckpoints([]); }
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // 热更新：有 running 的 run 时每 4s 刷新列表（完成后自动变 ✅）
  const hasRunning = runs.some(r => !['completed', 'failed', 'cancelled'].includes(r.status));
  useEffect(() => {
    if (!hasRunning) return;
    const t = setInterval(() => { void loadRuns(); }, 4000);
    return () => clearInterval(t);
  }, [hasRunning, loadRuns]);

  const openSession = (sid: string) => {
    setSelectedSession(sid);
    setSelectedRun(null);
    setCheckpoints([]);
    setActiveCp(null);
    setMsg(null);
  };

  const openRun = (runId: string) => {
    setSelectedRun(runId);
    setActiveCp(null);
    setInstruction('');
    setShowRaw(false);
    setMsg(null);
    void loadCheckpointsMeta(runId);
  };

  const fork = async () => {
    if (!selectedRun || activeCp === null) return;
    setBusy(true);
    try {
      const r = await api.forkRun(selectedRun, activeCp, instruction.trim() || undefined);
      setMsg(`✅ 已 fork — 生成新对话（${r.runId}），继承 #${activeCp} 前的全部成果。到「对话」页左侧找带 🌿 的新对话（与源对话同属一个对话集）`);
      await loadRuns();
    } catch (err: any) {
      setMsg('fork 失败: ' + (err.message || err));
    } finally { setBusy(false); }
  };

  const sessions: SessionGroup[] = useMemo(() => {
    const by = new Map<string, RunItem[]>();
    for (const r of runs) {
      const key = r.session_id ?? '(未分组)';
      if (!by.has(key)) by.set(key, []);
      by.get(key)!.push(r);
    }
    return [...by.entries()].map(([sessionId, rs]) => ({
      sessionId,
      runs: [...rs].sort((a, b) => a.created_at.localeCompare(b.created_at)),
      branchCount: rs.filter(r => r.parent_run_id).length,
      topic: rs[0]?.goal ?? '',
      lastAt: rs.map(r => r.created_at).sort().at(-1) ?? '',
    })).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }, [runs]);

  const session = sessions.find(s => s.sessionId === selectedSession);
  const runItem = runs.find(r => r.id === selectedRun);
  const activeItem = checkpoints.find(c => c.seq === activeCp);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-brand-soft rounded-xl flex items-center justify-center border border-brand/30">
          <History className="w-5 h-5 text-brand" />
        </div>
        <div>
          <h1 className="text-xl font-heading font-medium text-fg-primary">Time-Travel</h1>
          <p className="text-xs text-fg-muted">对话 → 运行 → 存档点 · 从任意存档带着已有成果分叉出新对话</p>
        </div>
      </div>

      <GuidePanel />

      {runs.length === 0 && (
        <div className="glass rounded-xl border border-glass-border p-6 text-center text-xs text-fg-muted leading-6">
          还没有任何对话。先到<b>「对话」</b>页发一个任务，完成后再回到这里。
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
        <div className="glass rounded-xl border border-glass-border overflow-hidden flex flex-col max-h-[580px]">
          {!selectedSession ? (
            <>
              <div className="px-3 py-2 border-b border-glass-border text-xs font-medium text-fg-secondary">第一步：选择对话</div>
              <div className="flex-1 overflow-y-auto">
                {sessions.map(s => (
                  <button key={s.sessionId} onClick={() => openSession(s.sessionId)}
                    className="w-full text-left px-3 py-2 text-xs cursor-pointer border-b border-glass-border/50 hover:bg-bg-elev/30">
                    <div className="flex items-center gap-1.5">
                      <MessageSquare className="w-3 h-3 text-fg-muted shrink-0" />
                      <span className="truncate flex-1 text-fg-primary">{s.topic.slice(0, 60)}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-fg-muted">{s.runs.length} 次运行</span>
                      {s.branchCount > 0 && <span className="text-brand">🌿 {s.branchCount} 分支</span>}
                      <span className="flex-1" />
                      <span className="text-fg-muted">{new Date(s.lastAt).toLocaleDateString()}</span>
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="px-3 py-2 border-b border-glass-border text-xs font-medium text-fg-secondary flex items-center gap-2">
                <button onClick={() => { setSelectedSession(null); setSelectedRun(null); setCheckpoints([]); }}
                  className="text-fg-muted hover:text-brand cursor-pointer shrink-0"><ArrowLeft className="w-3.5 h-3.5" /></button>
                <span className="truncate">{session?.topic.slice(0, 40)}</span>
              </div>
              <div className="px-3 py-1.5 text-[10px] text-fg-muted border-b border-glass-border/50">第二步：选该对话中的一次运行</div>
              <div className="flex-1 overflow-y-auto">
                {session?.runs.map(r => (
                  <div key={r.id} onClick={() => openRun(r.id)}
                    className={`w-full text-left px-3 py-2 text-xs cursor-pointer border-b border-glass-border/50 hover:bg-bg-elev/30 ${selectedRun === r.id ? 'bg-brand/10 border-l-2 border-l-brand' : ''}`}>
                    <div className="flex items-center gap-1.5">
                      {r.parent_run_id && <GitBranch className="w-3 h-3 text-brand shrink-0" />}
                      <span className={`truncate flex-1 ${r.parent_run_id ? 'text-brand' : 'text-fg-primary'}`}>{r.goal.slice(0, 50)}</span>
                      <button
                        onClick={e => { e.stopPropagation(); if (confirm('删除这条运行（分支连同事件一并删除）？')) { api.deleteRun(r.id).then(loadRuns).catch(err => setMsg('删除失败: ' + (err.message || err))); } }}
                        className="text-fg-muted hover:text-status-danger cursor-pointer shrink-0" title="删除">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <Tag variant={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'info'}>{r.status}</Tag>
                      <span className="text-fg-muted">{new Date(r.created_at).toLocaleTimeString()}</span>
                      {r.parent_run_id && <span className="text-brand/80 font-mono text-[10px]">🌿{r.parent_run_id.slice(0, 10)}…{r.fork_from_seq != null ? `@${r.fork_from_seq}` : ''}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="space-y-3">
          {!selectedRun && (
            <div className="glass rounded-xl border border-glass-border p-8 text-center text-xs text-fg-muted">
              <Scan className="w-6 h-6 mx-auto mb-2 opacity-50" />
              ← 先选对话，再选运行 — 这里会显示存档时间轴（每项中文摘要 + ✅ 完成点标记）
            </div>
          )}
          {selectedRun && (
            <>
              <div className="text-xs text-fg-muted">
                第三步：找 <span className="text-status-success">✅ 阶段完成点</span> 写新指令分叉。运行目标：<span className="text-fg-primary">{runItem?.goal.slice(0, 60)}</span>
              </div>

              <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
                {checkpoints.length === 0 && (
                  <div className="glass rounded-xl border border-glass-border p-6 text-center text-xs text-fg-muted">该运行没有存档</div>
                )}
                {checkpoints.map((cp, idx) => {
                  const meta = classifyCheckpoint(cp.preview);
                  const prevCount = idx > 0 ? checkpoints[idx - 1].messageCount : 0;
                  const delta = cp.preview.slice(Math.max(0, Math.min(prevCount, cp.preview.length - 1)));
                  const story = messagesToStory(delta.length > 0 ? delta : cp.preview).slice(0, 6);
                  const isActive = activeCp === cp.seq;
                  return (
                    <div key={cp.seq} className={`glass rounded-xl border p-2.5 cursor-pointer transition-colors ${isActive ? 'border-brand/50 bg-brand/5' : 'border-glass-border hover:border-brand/30'}`}
                      onClick={() => { setActiveCp(cp.seq); setShowRaw(false); }}>
                      <div className="flex items-center gap-2 text-xs flex-wrap">
                        <span className="font-mono text-brand shrink-0">#{cp.seq}</span>
                        <span className={`px-1.5 py-0.5 rounded border text-[10px] ${meta.cls}`}>{meta.badge}</span>
                        <span className="flex-1" />
                        <span className="text-fg-muted">{new Date(cp.createdAt).toLocaleTimeString()}</span>
                        {isActive ? <ChevronDown className="w-3.5 h-3.5 text-fg-muted" /> : <ChevronRight className="w-3.5 h-3.5 text-fg-muted" />}
                      </div>
                      <div className="mt-1.5 space-y-0.5">
                        {story.length === 0
                          ? <p className="text-[11px] text-fg-muted">（这一步没有新动作）</p>
                          : story.map((l, i) => (
                            <div key={i} className="flex gap-1.5 text-[11px] leading-4 text-fg-secondary">
                              <span className="shrink-0">{l.icon}</span>
                              <span className="break-all">{l.text}</span>
                            </div>
                          ))}
                      </div>
                      {isActive && meta.hint && <p className="mt-1.5 text-[11px] text-fg-muted">💡 {meta.hint}</p>}
                    </div>
                  );
                })}
              </div>

              {activeCp !== null && activeItem && (
                <div className="glass rounded-xl border border-brand/30 p-3 space-y-2">
                  <p className="text-xs text-fg-secondary">
                    第四步：写新指令（可留空 = 原样重跑）。将生成<b>新对话</b>，继承 #{activeCp} 之前的全部成果：
                  </p>
                  <textarea
                    value={instruction}
                    onChange={e => setInstruction(e.target.value)}
                    placeholder='例如："改成从成本角度重新总结，其他保持不变"'
                    className="w-full h-16 glass border border-glass-border rounded-lg p-2 text-xs outline-none focus:border-brand/40 resize-none"
                  />
                  <div className="flex items-center gap-2 flex-wrap">
                    <button onClick={fork} disabled={busy}
                      className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs flex items-center gap-1.5 cursor-pointer hover:bg-brand-hover disabled:opacity-50">
                      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CornerUpLeft className="w-3.5 h-3.5" />}
                      Fork 出新对话
                    </button>
                    <button onClick={() => setShowRaw(v => !v)}
                      className="px-2.5 py-1.5 rounded-lg glass border border-glass-border text-xs text-fg-secondary flex items-center gap-1.5 cursor-pointer hover:border-brand/40">
                      {showRaw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      {showRaw ? '隐藏原始消息' : '原始消息'}
                    </button>
                  </div>
                  {showRaw && (
                    <div className="mt-1 space-y-1 max-h-52 overflow-y-auto border-t border-glass-border pt-2">
                      {activeItem.preview.map((m, i) => (
                        <div key={i} className="flex gap-2 text-[11px] leading-4">
                          <span className={m.role === 'user' ? 'text-brand shrink-0' : m.role === 'tool' ? 'text-fg-muted shrink-0' : 'text-status-info shrink-0'}>
                            {m.role}{m.toolName ? `:${m.toolName}` : ''}
                          </span>
                          <span className="text-fg-secondary break-all line-clamp-2">{m.contentPreview || (m.toolCalls ? `[调用: ${m.toolCalls.join(', ')}]` : '')}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
