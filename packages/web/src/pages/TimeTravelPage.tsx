import { useCallback, useEffect, useState } from 'react';
import { History, GitBranch, Loader2, CornerUpLeft, ChevronDown, ChevronRight, Scan, HelpCircle } from 'lucide-react';
import { api } from '../api/client';
import { Tag } from '../components/ui';

/**
 * M4-1：Time-Travel 调试器 — checkpoint 时间轴 → 任意点预览 → fork 新 run。
 * · 使用指引（折叠面板 + 一键示例）
 * · run 列表（free 模式）→ checkpoint 时间轴（消息数/预览）
 * · 选定 checkpoint → 展开消息快照 → 输入新指令（可选）→ fork 新 run 继承历史上下文
 */

interface RunItem { id: string; goal: string; status: string; mode: string; parent_run_id: string | null; created_at: string }
interface CpItem {
  seq: number; kind: string; label: string; createdAt: string; messageCount: number;
  preview: Array<{ role: string; toolName: string | null; contentPreview: string; toolCalls?: string[] }>;
}

/** 使用指引（用户实测反馈"看不懂怎么操作"） */
function GuidePanel() {
  const [open, setOpen] = useState(() => localStorage.getItem('coral.tt.guide') !== '1');
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-fg-muted flex items-center gap-1 cursor-pointer hover:text-brand">
        <HelpCircle className="w-3.5 h-3.5" /> Time-Travel 是什么？怎么用？（附例子）
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
      <p><b>它解决什么问题</b>：Agent 跑完（或跑偏）后，你想"回到过去的某一步，换个说法再试一次"。每次 Agent 执行任务时每一步都会存档（checkpoint），这个页面让你能看到所有存档，并从任意一个存档<b>分叉（fork）出一条新时间线</b>——原 run 完全不动。</p>
      <p className="mt-2"><b>举个例子</b>：你在「对话」页让 Agent"总结这份报告并生成 Word"，但它总结的角度你不满意。到这里 → 左侧点开这个 run → 点时间轴上"总结完成"那个 checkpoint 看快照 → 在指令框写<b>"改成从成本角度重新总结"</b> → 点「Fork」。新 run 会带着之前读过的全部报告内容，按你的新方向重做——不需要重新上传文件、重新解释背景。</p>
      <p className="mt-2"><b>三步操作</b>：① 左侧点一个 run → ② 时间轴上点一个 checkpoint（展开看当时的消息）→ ③ 写新指令（可留空 = 原样重跑）→ 点「Fork 从这里重跑」。fork 出的新 run 会出现在「对话」页继续执行。</p>
      <p className="mt-1 text-fg-muted">适合场景：结果不满意想换思路 / 中途被打断想换个方式续 / 想对比"如果当时说 XXX 会怎样"。</p>
    </div>
  );
}

export default function TimeTravelPage() {
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<CpItem[]>([]);
  const [activeCp, setActiveCp] = useState<number | null>(null);
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
      setMsg(`✅ 已 fork 为新 run（runId: ${r.runId}），继承了 #${activeCp} 之前的全部上下文 — 切到「对话」页即可看到它执行`);
      await loadRuns();
    } catch (err: any) {
      setMsg('fork 失败: ' + (err.message || err));
    } finally { setBusy(false); }
  };

  const run = runs.find(r => r.id === selected);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-brand-soft rounded-xl flex items-center justify-center border border-brand/30">
          <History className="w-5 h-5 text-brand" />
        </div>
        <div>
          <h1 className="text-xl font-heading font-medium text-fg-primary">Time-Travel</h1>
          <p className="text-xs text-fg-muted">checkpoint 时间轴 · 任意点回放 · fork 分支重跑</p>
        </div>
      </div>

      <GuidePanel />

      {runs.length === 0 && (
        <div className="glass rounded-xl border border-glass-border p-6 text-center text-xs text-fg-muted leading-6">
          还没有任何 run。先到<b>「对话」</b>页发一个任务（例如"看看工作区里有什么文件并总结"），完成后再回到这里，
          就能看到它的 checkpoint 时间轴并尝试 fork。
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
        {/* run 列表 */}
        <div className="glass rounded-xl border border-glass-border overflow-hidden flex flex-col max-h-[560px]">
          <div className="px-3 py-2 border-b border-glass-border text-xs font-medium text-fg-secondary">第一步：选择一个 run</div>
          <div className="flex-1 overflow-y-auto">
            {runs.map(r => (
              <button key={r.id} onClick={() => loadCheckpoints(r.id)}
                className={`w-full text-left px-3 py-2 text-xs cursor-pointer border-b border-glass-border/50 hover:bg-bg-elev/30 ${selected === r.id ? 'bg-brand/10 border-l-2 border-l-brand' : ''}`}>
                <div className="flex items-center gap-1.5">
                  {r.parent_run_id && <GitBranch className="w-3 h-3 text-brand shrink-0" aria-label={`fork 自 ${r.parent_run_id ?? ""}`} />}
                  <span className={`truncate flex-1 ${r.parent_run_id ? 'text-brand' : 'text-fg-primary'}`}>{r.goal.slice(0, 60)}</span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <Tag variant={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'info'}>{r.status}</Tag>
                  <span className="text-fg-muted">{new Date(r.created_at).toLocaleString()}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* checkpoint 时间轴 */}
        <div className="space-y-3">
          {!selected && (
            <div className="glass rounded-xl border border-glass-border p-8 text-center text-xs text-fg-muted">
              <Scan className="w-6 h-6 mx-auto mb-2 opacity-50" />
              ← 从左侧选择一个 run，这里会显示它的 checkpoint 时间轴
            </div>
          )}
          {selected && (
            <>
              <div className="text-xs text-fg-muted">
                第二步：点时间轴上的 checkpoint 展开消息快照。目标：<span className="text-fg-primary">{run?.goal.slice(0, 80)}</span>
              </div>

              <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                {checkpoints.length === 0 && (
                  <div className="glass rounded-xl border border-glass-border p-6 text-center text-xs text-fg-muted">
                    该 run 没有 checkpoint（可能是很早以前的 run）— 换一个最近的 run 试试
                  </div>
                )}
                {checkpoints.map(cp => (
                  <div key={cp.seq} className={`glass rounded-xl border p-2.5 cursor-pointer transition-colors ${activeCp === cp.seq ? 'border-brand/50 bg-brand/5' : 'border-glass-border hover:border-brand/30'}`}
                    onClick={() => setActiveCp(cp.seq)}>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono text-brand shrink-0">#{cp.seq}</span>
                      <span className="text-fg-muted">{cp.label}</span>
                      <span className="flex-1" />
                      <span className="text-fg-muted">{cp.messageCount} 条消息</span>
                      {activeCp === cp.seq
                        ? <ChevronDown className="w-3.5 h-3.5 text-fg-muted" />
                        : <ChevronRight className="w-3.5 h-3.5 text-fg-muted" />}
                    </div>
                    {activeCp === cp.seq && (
                      <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                        <p className="text-[11px] text-fg-muted mb-1">▼ 这是 Agent 走到这一步时的完整上下文：</p>
                        {cp.preview.map((m, i) => (
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
                ))}
              </div>

              {activeCp !== null && (
                <div className="glass rounded-xl border border-brand/30 p-3 space-y-2">
                  <p className="text-xs text-fg-secondary">第三步：写新指令（<b>可留空</b> = 从这里原样重跑）— Agent 会带着 #${activeCp} 之前的全部上下文执行它：</p>
                  <textarea
                    value={instruction}
                    onChange={e => setInstruction(e.target.value)}
                    placeholder='例如："改成从成本角度重新总结" / "刚才的方案太保守了，激进一点" / "继续，但跳过前两步"'
                    className="w-full h-16 glass border border-glass-border rounded-lg p-2 text-xs outline-none focus:border-brand/40 resize-none"
                  />
                  <button onClick={fork} disabled={busy}
                    className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs flex items-center gap-1.5 cursor-pointer hover:bg-brand-hover disabled:opacity-50">
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CornerUpLeft className="w-3.5 h-3.5" />}
                    Fork 从 #{activeCp} 重跑
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
