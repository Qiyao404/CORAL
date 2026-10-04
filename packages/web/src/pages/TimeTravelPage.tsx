import { useCallback, useEffect, useMemo, useState } from 'react';
import { History, GitBranch, Loader2, CornerUpLeft, ChevronDown, ChevronRight, Scan, HelpCircle, Eye, EyeOff, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { Tag } from '../components/ui';

/**
 * M4-1：Time-Travel 调试器 — checkpoint 时间轴 → 任意点预览 → fork 新 run。
 * 用户实测反馈："看不懂这些指令，不知道选 step 几去改写"。
 * 解法：快照默认渲染为**中文故事线**（每步只显示"这一步做了什么"的增量摘要，
 * 隐藏工具 JSON/英文自言自语/[system] 提醒），自动标注"阶段完成点"（最适合 fork 的位置），
 * 原始消息保留在"查看原始消息"开关后面给高级用户。
 */

interface RunItem { id: string; goal: string; status: string; mode: string; parent_run_id: string | null; fork_from_seq?: number | null; created_at: string }
interface CpPreviewMsg { role: string; toolName: string | null; contentPreview: string; toolCalls?: string[] }
interface CpItem {
  seq: number; kind: string; label: string; createdAt: string; messageCount: number;
  preview: CpPreviewMsg[];
}

/** 把工具调用翻译成中文动作（尽量从结果 JSON 里抠出文件路径/URL） */
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

/** 把一段消息（增量）翻译成中文故事线；噪声（工具 JSON/英文自言自语/[system]）一律不显示 */
function messagesToStory(msgs: CpPreviewMsg[]): StoryLine[] {
  const lines: StoryLine[] = [];
  let lastToolDesc = '';
  let toolRun = 0;
  const flushTools = () => {
    if (toolRun > 0) {
      lines.push({ icon: '🔧', text: lastToolDesc + (toolRun > 1 ? ` ×${toolRun}` : '') });
    }
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
      if (content.startsWith('[system]')) continue; // 引擎提醒，非用户发言
      lines.push({ icon: '👤', text: `你说：${content.slice(0, 80)}` });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.toolCalls?.length) continue; // 工具调用已在上面汇总
      const trimmed = content.trim();
      if (!trimmed || trimmed.startsWith('[调用工具')) continue; // 内部串场话
      const firstLine = trimmed.split('\n').find(l => l.trim()) ?? trimmed;
      lines.push({ icon: '🤖', text: `Agent 回答：${firstLine.slice(0, 80)}` });
    }
  }
  flushTools();
  return lines;
}

/** checkpoint 的性质标签：阶段完成点最适合 fork */
function classifyCheckpoint(preview: CpPreviewMsg[]): { badge: string; cls: string; hint: string } {
  const last = preview[preview.length - 1];
  // REG-17 配套：英文过渡话（Now I'll / Let me…）不是交付 — 不算完成点
  const isNarration = (t: string) =>
    /^(I'll|I will|Let me|Now I|Next I|First,? I|I'm going to|Now,? let|我来|我将|接下来|让我)/i.test(t.trim()) && t.length < 300;
  const lastIsAssistantAnswer = last?.role === 'assistant' && !last.toolCalls
    && !(last.contentPreview ?? '').startsWith('[调用工具')
    && !isNarration(last?.contentPreview ?? '忽略长内容长内容长内容长内容长内容长内容长内容长内容长内容长内容长内容长内容');
  if (preview.length <= 2) {
    return { badge: '起点', cls: 'text-fg-muted border-glass-borderStrong', hint: '刚收到目标 — 从这里 fork 等于重来一遍' };
  }
  if (lastIsAssistantAnswer) {
    return { badge: '✅ 阶段完成点 · 最适合分叉', cls: 'text-status-success border-status-success/40', hint: 'Agent 刚交付了一轮结果 — 在此写新指令，它会带着全部已有成果换方向' };
  }
  return { badge: '执行中段', cls: 'text-fg-muted border-glass-borderStrong', hint: '当时正在连续调用工具 — 从这里 fork 会重试未完成的步骤' };
}

/** 使用指引 */
function GuidePanel() {
  const [open, setOpen] = useState(() => localStorage.getItem('coral.tt.guide') !== '1');
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-fg-muted flex items-center gap-1 cursor-pointer hover:text-brand">
        <HelpCircle className="w-3.5 h-3.5" /> Time-Travel 是什么？怎么选 step？（附例子）
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
      <p><b>怎么理解时间轴</b>：Agent 干活时每走一步都存档。时间轴上每一项就是一个存档点，<b>每项下面的中文摘要就是"这一步做了什么"</b>（读取某文件 / 生成了某文档 / 给出回答…），你不需要看懂底层的消息和 JSON —— 那些收进了"查看原始消息"。</p>
      <p className="mt-2"><b>该选哪个 step？一个原则：<span className="text-status-success">选带"✅ 阶段完成点"的那一项</span></b> —— Agent 刚交付出一样东西（比如生成了一份 Word），在这里 fork 并写新指令，它会<b>带着之前全部成果</b>按新要求继续，已读的文件不用重读。标"执行中段"的是干到一半的存档，只有想"重试未完成步骤"时才选。</p>
      <p className="mt-2"><b>完整例子（对照你现在的 run）</b>：你的 run 有两个阶段完成点 —— 一个是"生成了总结 Word"（#4 附近），一个是"生成了对比说明 Word"（最后附近）。想要<b>对比文档换个结构</b>：选最后那个完成点 → 指令写"重新生成对比文档，改成按受众对比，其他保持不变" → Fork。想要<b>总结换个角度</b>：选"生成总结 Word"那个完成点 → 写"从儿童学习的角度重新总结"。</p>
      <p className="mt-2"><b>新指令怎么写</b>：像给同事发消息一样说清"要改什么、其他保持什么"。留空 = 从这一步原样重跑。</p>
    </div>
  );
}

export default function TimeTravelPage() {
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
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

  useEffect(() => { loadRuns(); }, [loadRuns]);

  const loadCheckpoints = useCallback(async (runId: string) => {
    setSelected(runId);
    setActiveCp(null);
    setInstruction('');
    setMsg(null);
    setShowRaw(false);
    try {
      const d = await api.getRunCheckpoints(runId);
      setCheckpoints(d.items ?? []);
    } catch { setCheckpoints([]); }
  }, []);

  const fork = async () => {
    if (!selected || activeCp === null) return;
    setBusy(true);
    try {
      const r = await api.forkRun(selected, activeCp, instruction.trim() || undefined);
      setMsg(`✅ 已 fork 为新 run（${r.runId}），继承了 #${activeCp} 之前的全部成果 — 切到「对话」页即可看到它执行`);
      await loadRuns();
    } catch (err: any) {
      setMsg('fork 失败: ' + (err.message || err));
    } finally { setBusy(false); }
  };

  const run = runs.find(r => r.id === selected);
  const activeItem = checkpoints.find(c => c.seq === activeCp);

  /** 选中项的故事线：默认只显示"这一步新增"（与上一个存档的差异）；首项显示全部 */
  const activeStory = useMemo(() => {
    if (!activeItem) return [] as StoryLine[];
    const idx = checkpoints.findIndex(c => c.seq === activeCp);
    const prevCount = idx > 0 ? checkpoints[idx - 1].messageCount : 0;
    const delta = activeItem.preview.slice(Math.max(0, Math.min(prevCount, activeItem.preview.length - 1)));
    const story = messagesToStory(delta.length > 0 ? delta : activeItem.preview);
    return story.slice(0, 10);
  }, [activeItem, checkpoints, activeCp]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-brand-soft rounded-xl flex items-center justify-center border border-brand/30">
          <History className="w-5 h-5 text-brand" />
        </div>
        <div>
          <h1 className="text-xl font-heading font-medium text-fg-primary">Time-Travel</h1>
          <p className="text-xs text-fg-muted">Agent 每一步都有存档 · 从任意存档带着已有成果换方向重跑</p>
        </div>
      </div>

      <GuidePanel />

      {runs.length === 0 && (
        <div className="glass rounded-xl border border-glass-border p-6 text-center text-xs text-fg-muted leading-6">
          还没有任何 run。先到<b>「对话」</b>页发一个任务（例如"看看工作区里有什么文件并总结"），完成后再回到这里，
          就能看到它的存档时间轴并尝试 fork。
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
        {/* run 列表 */}
        <div className="glass rounded-xl border border-glass-border overflow-hidden flex flex-col max-h-[560px]">
          <div className="px-3 py-2 border-b border-glass-border text-xs font-medium text-fg-secondary">第一步：选择一个 run</div>
          <div className="flex-1 overflow-y-auto">
            {runs.map(r => (
              <div key={r.id}
                className={`w-full text-left px-3 py-2 text-xs cursor-pointer border-b border-glass-border/50 hover:bg-bg-elev/30 ${selected === r.id ? 'bg-brand/10 border-l-2 border-l-brand' : ''}`}
                onClick={() => loadCheckpoints(r.id)}>
                <div className="flex items-center gap-1.5">
                  {r.parent_run_id && <GitBranch className="w-3 h-3 text-brand shrink-0" />}
                  <span className={`truncate flex-1 ${r.parent_run_id ? 'text-brand' : 'text-fg-primary'}`}>{r.goal.slice(0, 60)}</span>
                  <button
                    onClick={e => { e.stopPropagation(); if (confirm('删除这条 run（分支连同事件一并删除）？')) { api.deleteRun(r.id).then(loadRuns).catch(err => setMsg('删除失败: ' + (err.message || err))); } }}
                    className="text-fg-muted hover:text-status-danger cursor-pointer shrink-0" title="删除此 run">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
                {r.parent_run_id && (
                  <div className="text-[10px] text-brand/80 mt-0.5 font-mono">🌿 分支自 {r.parent_run_id.slice(0, 14)}…{r.fork_from_seq != null ? ` @第${r.fork_from_seq}步` : ''}</div>
                )}
                <div className="flex items-center gap-2 mt-0.5">
                  <Tag variant={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'info'}>{r.status}</Tag>
                  <span className="text-fg-muted">{new Date(r.created_at).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* checkpoint 时间轴 */}
        <div className="space-y-3">
          {!selected && (
            <div className="glass rounded-xl border border-glass-border p-8 text-center text-xs text-fg-muted">
              <Scan className="w-6 h-6 mx-auto mb-2 opacity-50" />
              ← 从左侧选择一个 run，这里会显示它的存档时间轴（每项都有中文摘要，告诉你那一步做了什么）
            </div>
          )}
          {selected && (
            <>
              <div className="text-xs text-fg-muted">
                第二步：逐项看<b>中文摘要</b>，找你想"从那里改"的时刻 — 标了 <span className="text-status-success">✅ 阶段完成点</span> 的最适合分叉。
                目标：<span className="text-fg-primary">{run?.goal.slice(0, 70)}</span>
              </div>

              <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
                {checkpoints.length === 0 && (
                  <div className="glass rounded-xl border border-glass-border p-6 text-center text-xs text-fg-muted">
                    该 run 没有存档（可能是很早以前的 run）— 换一个最近的 run 试试
                  </div>
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
                        {isActive
                          ? <ChevronDown className="w-3.5 h-3.5 text-fg-muted" />
                          : <ChevronRight className="w-3.5 h-3.5 text-fg-muted" />}
                      </div>
                      {/* 中文故事线（默认阅读面） */}
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
                      {isActive && meta.hint && (
                        <p className="mt-1.5 text-[11px] text-fg-muted">💡 {meta.hint}</p>
                      )}
                    </div>
                  );
                })}
              </div>

              {activeCp !== null && activeItem && (
                <div className="glass rounded-xl border border-brand/30 p-3 space-y-2">
                  <p className="text-xs text-fg-secondary">
                    第三步：写新指令（可留空 = 从 #{activeCp} 原样重跑）。Agent 会带着 <b>#{activeCp} 之前的全部成果</b>执行：
                  </p>
                  <textarea
                    value={instruction}
                    onChange={e => setInstruction(e.target.value)}
                    placeholder={
                      activeItem.preview.some(m => (m.contentPreview ?? '').includes('.docx') || (m.contentPreview ?? '').includes('Word'))
                        ? '例如："重新生成这份 Word，改成按受众对比，其他内容保持不变"'
                        : '例如："换个角度重新总结" / "继续，但跳过刚才读过的部分"'
                    }
                    className="w-full h-16 glass border border-glass-border rounded-lg p-2 text-xs outline-none focus:border-brand/40 resize-none"
                  />
                  <div className="flex items-center gap-2 flex-wrap">
                    <button onClick={fork} disabled={busy}
                      className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs flex items-center gap-1.5 cursor-pointer hover:bg-brand-hover disabled:opacity-50">
                      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CornerUpLeft className="w-3.5 h-3.5" />}
                      Fork 从 #{activeCp} 重跑
                    </button>
                    <button onClick={() => setShowRaw(v => !v)}
                      className="px-2.5 py-1.5 rounded-lg glass border border-glass-border text-xs text-fg-secondary flex items-center gap-1.5 cursor-pointer hover:border-brand/40">
                      {showRaw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      {showRaw ? '隐藏原始消息' : '查看原始消息（开发者视图）'}
                    </button>
                  </div>
                  {showRaw && (
                    <div className="mt-1 space-y-1 max-h-52 overflow-y-auto border-t border-glass-border pt-2">
                      <p className="text-[11px] text-fg-muted mb-1">#{activeCp} 时的完整原始快照（{activeItem.preview.length} 条 — 工具 JSON 与英文为模型内部内容，仅供排查）：</p>
                      {activeItem.preview.map((m, i) => (
                        <div key={i} className="flex gap-2 text-[11px] leading-4">
                          <span className={m.role === 'user' ? 'text-brand shrink-0' : m.role === 'tool' ? 'text-fg-muted shrink-0' : 'text-status-info shrink-0'}>
                            {m.role}{m.toolName ? `:${m.toolName}` : ''}
                          </span>
                          <span className="text-fg-secondary break-all line-clamp-2">{m.contentPreview || (m.toolCalls ? `[调用工具: ${m.toolCalls.join(', ')}]` : '')}</span>
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
