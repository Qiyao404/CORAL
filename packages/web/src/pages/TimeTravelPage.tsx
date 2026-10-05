import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  History, GitBranch, Loader2, CornerUpLeft, ChevronDown, ChevronRight, Scan, HelpCircle, Eye, EyeOff, Trash2, ArrowLeft, MessageSquare, MessageCircle,
} from 'lucide-react';
import { api } from '../api/client';
import { Tag } from '../components/ui';

/**
 * M4-1：Time-Travel — 四层导航（用户语义终版）。
 * 第一层：选择对话（血缘对话集 — 与对话页侧栏一致）
 * 第二层：该对话的全部提问（分支归在父提问下）
 * 第三层：某提问的运行变体（原运行 + 🌿 分支运行，仅当有分支时出现）
 * 第四层：存档时间轴（checkpoint）
 */

interface RunItem { id: string; goal: string; status: string; mode: string; session_id: string | null; parent_run_id: string | null; fork_from_seq?: number | null; created_at: string }
interface CpPreviewMsg { role: string; toolName: string | null; contentPreview: string; toolCalls?: string[] }
interface CpItem { seq: number; kind: string; label: string; createdAt: string; messageCount: number; preview: CpPreviewMsg[] }

interface AskItem {
  originalRun: RunItem;
  branchRuns: RunItem[];
  goal: string;
  status: string;
  createdAt: string;
}

interface ConvItem {
  rootId: string;
  topic: string;
  asks: AskItem[];
  lastAt: string;
}

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
        <HelpCircle className="w-3.5 h-3.5" /> Time-Travel 是什么？怎么用？
      </button>
    );
  }
  return (
    <div className="glass rounded-xl border border-glass-border p-4 text-xs text-fg-secondary leading-6">
      <div className="flex items-center gap-2 mb-2">
        <HelpCircle className="w-4 h-4 text-brand" />
        <span className="font-medium text-fg-primary">Time-Travel 使用指引</span>
        <span className="flex-1" />
        <button onClick={() => { setOpen(false); localStorage.setItem('coral.tt.guide', '1'); }} className="text-fg-muted hover:text-fg-primary cursor-pointer">收起</button>
      </div>
      <p><b>四步走</b>：① 选<b>对话</b> → ② 选该对话里的<b>提问</b> → ③ 提问有分支时选<b>运行变体</b> → ④ 时间轴上找 <span className="text-status-success">✅ 完成点</span> 写新指令 Fork。</p>
      <p className="mt-2"><b>Fork 后</b>：生成新对话（继承上下文），原对话不变。新对话在「对话」页与原对话同属一个对话集。</p>
      <p className="mt-2"><b>例子</b>：对话里有"总结报告并生成 Word"和"生成对比文档"两个提问。想让总结换角度？选"总结"提问 → 时间轴找"生成 Word"那个完成点 → 写"从成本角度重做" → Fork。</p>
    </div>
  );
}

export default function TimeTravelPage() {
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [selectedConv, setSelectedConv] = useState<string | null>(null);
  const [selectedAsk, setSelectedAsk] = useState<string | null>(null);
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

  const loadCheckpoints = useCallback(async (runId: string) => {
    try {
      const d = await api.getRunCheckpoints(runId);
      setCheckpoints(d.items ?? []);
    } catch { setCheckpoints([]); }
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  const hasRunning = runs.some(r => !['completed', 'failed', 'cancelled'].includes(r.status));
  useEffect(() => {
    if (!hasRunning) return;
    const t = setInterval(() => { void loadRuns(); }, 4000);
    return () => clearInterval(t);
  }, [hasRunning, loadRuns]);

  const convs: ConvItem[] = useMemo(() => {
    const byId = new Map(runs.map(r => [r.id, r]));
    const rootOf = (r: RunItem, seen = new Set<string>()): string => {
      if (!r.parent_run_id || seen.has(r.id)) return r.id;
      seen.add(r.id);
      const parent = byId.get(r.parent_run_id);
      return parent ? rootOf(parent, seen) : r.parent_run_id;
    };
    const byRoot = new Map<string, RunItem[]>();
    for (const r of runs) {
      const root = rootOf(r);
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root)!.push(r);
    }
    return [...byRoot.entries()].map(([root, rs]) => {
      const sorted = [...rs].sort((a, b) => a.created_at.localeCompare(b.created_at));
      const topLevel = sorted.filter(r => !r.parent_run_id || !byId.get(r.parent_run_id));
      const asks: AskItem[] = topLevel.map(orig => {
        const branches = sorted.filter(r => {
          if (r.id === orig.id) return false;
          let cur: RunItem | undefined = r;
          const seen = new Set<string>();
          while (cur?.parent_run_id && !seen.has(cur.id)) {
            seen.add(cur.id);
            if (cur.parent_run_id === orig.id) return true;
            cur = byId.get(cur.parent_run_id);
          }
          return false;
        });
        return { originalRun: orig, branchRuns: branches, goal: orig.goal, status: orig.status, createdAt: orig.created_at };
      });
      return { rootId: root, topic: sorted[0]?.goal ?? '', asks, lastAt: sorted.map(r => r.created_at).sort().at(-1) ?? '' };
    }).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }, [runs]);

  const conv = convs.find(c => c.rootId === selectedConv);
  const ask = conv?.asks.find(a => a.originalRun.id === selectedAsk);
  const runItem = runs.find(r => r.id === selectedRun);

  const openConv = (rootId: string) => {
    setSelectedConv(rootId); setSelectedAsk(null); setSelectedRun(null);
    setCheckpoints([]); setActiveCp(null); setMsg(null);
  };
  const openAsk = (a: AskItem) => {
    setSelectedAsk(a.originalRun.id); setActiveCp(null); setInstruction(''); setShowRaw(false); setMsg(null);
    if (a.branchRuns.length === 0) { setSelectedRun(a.originalRun.id); loadCheckpoints(a.originalRun.id); }
    else { setSelectedRun(null); setCheckpoints([]); }
  };
  const openRun = (runId: string) => {
    setSelectedRun(runId); setActiveCp(null); setInstruction(''); setShowRaw(false); setMsg(null);
    loadCheckpoints(runId);
  };
  const fork = async () => {
    if (!selectedRun || activeCp === null) return;
    setBusy(true);
    try {
      const r = await api.forkRun(selectedRun, activeCp, instruction.trim() || undefined);
      setMsg(`✅ 已 fork — 生成新对话（${r.runId}），继承 #${activeCp} 前的全部成果`);
      await loadRuns();
    } catch (err: any) { setMsg('fork 失败: ' + (err.message || err)); }
    finally { setBusy(false); }
  };

  const activeItem = checkpoints.find(c => c.seq === activeCp);
  const showAskList = selectedConv && !selectedAsk;
  const showRunVariants = selectedConv && selectedAsk && ask && ask.branchRuns.length > 0 && !selectedRun;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-brand-soft rounded-xl flex items-center justify-center border border-brand/30">
          <History className="w-5 h-5 text-brand" />
        </div>
        <div>
          <h1 className="text-xl font-heading font-medium text-fg-primary">Time-Travel</h1>
          <p className="text-xs text-fg-muted">对话 → 提问 → 运行变体 → 存档点 · 从任意存档分叉出新对话</p>
        </div>
      </div>
      <GuidePanel />
      {runs.length === 0 && (
        <div className="glass rounded-xl border border-glass-border p-6 text-center text-xs text-fg-muted">先到「对话」页发一个任务</div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
        {/* 左栏：层级导航 */}
        <div className="glass rounded-xl border border-glass-border overflow-hidden flex flex-col max-h-[580px]">
          <div className="px-3 py-1.5 border-b border-glass-border flex items-center gap-1 text-[11px] text-fg-muted">
            <button onClick={() => { setSelectedConv(null); setSelectedAsk(null); setSelectedRun(null); setCheckpoints([]); }} className={`cursor-pointer hover:text-brand ${!selectedConv ? 'font-bold text-fg-primary' : ''}`}>对话</button>
            {selectedConv && <><ChevronRight className="w-3 h-3" /><button onClick={() => { setSelectedAsk(null); setSelectedRun(null); setCheckpoints([]); }} className={`cursor-pointer hover:text-brand truncate max-w-[100px] ${showAskList ? 'font-bold text-fg-primary' : ''}`}>{conv?.topic.slice(0, 16)}…</button></>}
            {selectedAsk && <><ChevronRight className="w-3 h-3" /><button onClick={() => { setSelectedRun(null); setCheckpoints([]); }} className={`cursor-pointer hover:text-brand truncate max-w-[100px] ${showRunVariants ? 'font-bold text-fg-primary' : ''}`}>{ask?.goal.slice(0, 14)}…</button></>}
            {selectedRun && ask && ask.branchRuns.length > 0 && <><ChevronRight className="w-3 h-3" /><span className="text-fg-secondary font-bold">变体</span></>}
          </div>
          {!selectedConv && (
            <>
              <div className="px-3 py-2 border-b border-glass-border text-xs font-medium text-fg-secondary">选择对话</div>
              <div className="flex-1 overflow-y-auto">
                {convs.map(c => {
                  const bt = c.asks.reduce((n, a) => n + a.branchRuns.length, 0);
                  return (
                    <button key={c.rootId} onClick={() => openConv(c.rootId)} className="w-full text-left px-3 py-2 text-xs cursor-pointer border-b border-glass-border/50 hover:bg-bg-elev/30">
                      <div className="flex items-center gap-1.5"><MessageSquare className="w-3 h-3 text-fg-muted shrink-0" /><span className="truncate flex-1 text-fg-primary">{c.topic.slice(0, 55)}</span></div>
                      <div className="flex items-center gap-2 mt-0.5"><span className="text-fg-muted">{c.asks.length} 个提问</span>{bt > 0 && <span className="text-brand">🌿 {bt}</span>}<span className="flex-1" /><span className="text-fg-muted">{new Date(c.lastAt).toLocaleDateString()}</span></div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {showAskList && (
            <>
              <div className="px-3 py-1.5 text-[10px] text-fg-muted border-b border-glass-border/50">选择提问</div>
              <div className="flex-1 overflow-y-auto">
                {conv?.asks.map(a => (
                  <div key={a.originalRun.id} onClick={() => openAsk(a)} className="px-3 py-2 text-xs cursor-pointer border-b border-glass-border/50 hover:bg-bg-elev/30">
                    <div className="flex items-center gap-1.5"><MessageCircle className="w-3 h-3 text-fg-muted shrink-0" /><span className="truncate flex-1 text-fg-primary">{a.goal.slice(0, 50)}</span>{a.branchRuns.length > 0 && <GitBranch className="w-3 h-3 text-brand shrink-0" />}</div>
                    <div className="flex items-center gap-2 mt-0.5"><Tag variant={a.status === 'completed' ? 'success' : a.status === 'failed' ? 'danger' : 'info'}>{a.status}</Tag>{a.branchRuns.length > 0 && <span className="text-brand">🌿 {a.branchRuns.length}</span>}<span className="flex-1" /><span className="text-fg-muted">{new Date(a.createdAt).toLocaleTimeString()}</span></div>
                  </div>
                ))}
              </div>
            </>
          )}
          {showRunVariants && (
            <>
              <div className="px-3 py-1.5 text-[10px] text-fg-muted border-b border-glass-border/50">选择运行变体</div>
              <div className="flex-1 overflow-y-auto">
                <div onClick={() => openRun(ask!.originalRun.id)} className="px-3 py-2 text-xs cursor-pointer border-b border-glass-border/50 hover:bg-bg-elev/30">
                  <div className="flex items-center gap-1.5"><span className="text-fg-primary flex-1">原始运行</span><Tag variant={ask!.originalRun.status === 'completed' ? 'success' : 'info'}>{ask!.originalRun.status}</Tag></div>
                </div>
                {ask!.branchRuns.map(b => (
                  <div key={b.id} onClick={() => openRun(b.id)} className="px-3 py-2 text-xs cursor-pointer border-b border-glass-border/50 hover:bg-bg-elev/30">
                    <div className="flex items-center gap-1.5"><GitBranch className="w-3 h-3 text-brand shrink-0" /><span className="text-brand truncate flex-1">{b.goal.split('\n')[0].slice(0, 40)}</span><Tag variant={b.status === 'completed' ? 'success' : 'info'}>{b.status}</Tag></div>
                    {b.fork_from_seq != null && <div className="text-[10px] text-brand/60 mt-0.5">🌿 从第 {b.fork_from_seq} 步分出</div>}
                  </div>
                ))}
              </div>
            </>
          )}
          {selectedRun && (
            <div className="px-3 py-1.5 text-[10px] text-fg-muted">存档时间轴在右侧 ↓</div>
          )}
        </div>

        {/* 右栏：存档时间轴 */}
        <div className="space-y-3">
          {!selectedRun && (
            <div className="glass rounded-xl border border-glass-border p-8 text-center text-xs text-fg-muted">
              <Scan className="w-6 h-6 mx-auto mb-2 opacity-50" />
              ← 逐层选择后这里显示存档时间轴
            </div>
          )}
          {selectedRun && (
            <>
              <div className="text-xs text-fg-muted">
                找 <span className="text-status-success">✅ 完成点</span> 写新指令分叉
                {runItem?.parent_run_id && <span className="text-brand"> · 🌿 分支运行</span>}
              </div>
              <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
                {checkpoints.length === 0 && <div className="glass rounded-xl border border-glass-border p-6 text-center text-xs text-fg-muted">该运行没有存档</div>}
                {checkpoints.map((cp, idx) => {
                  const meta = classifyCheckpoint(cp.preview);
                  const prevCount = idx > 0 ? checkpoints[idx - 1].messageCount : 0;
                  const delta = cp.preview.slice(Math.max(0, Math.min(prevCount, cp.preview.length - 1)));
                  const story = messagesToStory(delta.length > 0 ? delta : cp.preview).slice(0, 6);
                  const isActive = activeCp === cp.seq;
                  return (
                    <div key={cp.seq} className={`glass rounded-xl border p-2.5 cursor-pointer transition-colors ${isActive ? 'border-brand/50 bg-brand/5' : 'border-glass-border hover:border-brand/30'}`} onClick={() => { setActiveCp(cp.seq); setShowRaw(false); }}>
                      <div className="flex items-center gap-2 text-xs flex-wrap">
                        <span className="font-mono text-brand shrink-0">#{cp.seq}</span>
                        <span className={`px-1.5 py-0.5 rounded border text-[10px] ${meta.cls}`}>{meta.badge}</span>
                        <span className="flex-1" /><span className="text-fg-muted">{new Date(cp.createdAt).toLocaleTimeString()}</span>
                        {isActive ? <ChevronDown className="w-3.5 h-3.5 text-fg-muted" /> : <ChevronRight className="w-3.5 h-3.5 text-fg-muted" />}
                      </div>
                      <div className="mt-1.5 space-y-0.5">
                        {story.length === 0 ? <p className="text-[11px] text-fg-muted">（这一步没有新动作）</p> : story.map((l, i) => (
                          <div key={i} className="flex gap-1.5 text-[11px] leading-4 text-fg-secondary"><span className="shrink-0">{l.icon}</span><span className="break-all">{l.text}</span></div>
                        ))}
                      </div>
                      {isActive && meta.hint && <p className="mt-1.5 text-[11px] text-fg-muted">💡 {meta.hint}</p>}
                    </div>
                  );
                })}
              </div>
              {activeCp !== null && activeItem && (
                <div className="glass rounded-xl border border-brand/30 p-3 space-y-2">
                  <p className="text-xs text-fg-secondary">写新指令（可留空 = 原样重跑），将生成<b>新对话</b>继承 #{activeCp} 前的全部成果：</p>
                  <textarea value={instruction} onChange={e => setInstruction(e.target.value)} placeholder='例如："改成从成本角度重新总结，其他保持不变"' className="w-full h-16 glass border border-glass-border rounded-lg p-2 text-xs outline-none focus:border-brand/40 resize-none" />
                  <div className="flex items-center gap-2 flex-wrap">
                    <button onClick={fork} disabled={busy} className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs flex items-center gap-1.5 cursor-pointer hover:bg-brand-hover disabled:opacity-50">
                      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CornerUpLeft className="w-3.5 h-3.5" />} Fork 出新对话
                    </button>
                    <button onClick={() => setShowRaw(v => !v)} className="px-2.5 py-1.5 rounded-lg glass border border-glass-border text-xs text-fg-secondary flex items-center gap-1.5 cursor-pointer hover:border-brand/40">
                      {showRaw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />} {showRaw ? '隐藏' : '原始消息'}
                    </button>
                  </div>
                  {showRaw && (
                    <div className="mt-1 space-y-1 max-h-52 overflow-y-auto border-t border-glass-border pt-2">
                      {activeItem.preview.map((m, i) => (
                        <div key={i} className="flex gap-2 text-[11px] leading-4">
                          <span className={m.role === 'user' ? 'text-brand shrink-0' : m.role === 'tool' ? 'text-fg-muted shrink-0' : 'text-status-info shrink-0'}>{m.role}{m.toolName ? `:${m.toolName}` : ''}</span>
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
