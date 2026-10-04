import { useCallback, useEffect, useState } from 'react';
import { History, GitBranch, Loader2, CornerUpLeft, ChevronDown, ChevronRight, Scan } from 'lucide-react';
import { api } from '../api/client';
import { Tag } from '../components/ui';

/**
 * M4-1：Time-Travel 调试器 — checkpoint 时间轴 → 任意点预览 → fork 新 run。
 * · run 列表（free 模式）→ checkpoint 时间轴（消息数/预览）
 * · 选定 checkpoint → 展开消息快照 → 输入新指令（可选）→ fork
 * · fork 的新 run 继承历史上下文，可在「对话」页继续查看
 */

interface RunItem { id: string; goal: string; status: string; mode: string; parent_run_id: string | null; created_at: string }
interface CpItem {
  seq: number; kind: string; label: string; createdAt: string; messageCount: number;
  preview: Array<{ role: string; toolName: string | null; contentPreview: string; toolCalls?: string[] }>;
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
      setMsg(`已 fork 为新 run ${r.runId}（继承 ${activeCp} 号 checkpoint 前的 ${r.forkFrom ? '' : ''}全部上下文）— 到「对话」页查看执行`);
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

      {msg && <div className="text-xs text-fg-secondary glass border border-brand/30 rounded-lg px-3 py-2 break-all">{msg}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
        {/* run 列表 */}
        <div className="glass rounded-xl border border-glass-border overflow-hidden flex flex-col max-h-[560px]">
          <div className="px-3 py-2 border-b border-glass-border text-xs font-medium text-fg-secondary">Runs（free 模式）</div>
          <div className="flex-1 overflow-y-auto">
            {runs.map(r => (
              <button key={r.id} onClick={() => loadCheckpoints(r.id)}
                className={`w-full text-left px-3 py-2 text-xs cursor-pointer border-b border-glass-border/50 hover:bg-bg-elev/30 ${selected === r.id ? 'bg-brand/10 border-l-2 border-l-brand' : ''}`}>
                <div className="flex items-center gap-1.5">
                  {r.parent_run_id && <GitBranch className="w-3 h-3 text-brand shrink-0" />}
                  <span className={`truncate flex-1 ${r.parent_run_id ? 'text-brand' : 'text-fg-primary'}`}>{r.goal.slice(0, 60)}</span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <Tag variant={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'info'}>{r.status}</Tag>
                  <span className="text-fg-muted">{new Date(r.created_at).toLocaleString()}</span>
                </div>
              </button>
            ))}
            {runs.length === 0 && <div className="p-4 text-xs text-fg-muted text-center">暂无 run</div>}
          </div>
        </div>

        {/* checkpoint 时间轴 */}
        <div className="space-y-3">
          {!selected && (
            <div className="glass rounded-xl border border-glass-border p-8 text-center text-xs text-fg-muted">
              <Scan className="w-6 h-6 mx-auto mb-2 opacity-50" />
              选择左侧任一 run 查看它的 checkpoint 时间轴
            </div>
          )}
          {selected && (
            <>
              <div className="glass rounded-xl border border-glass-border p-3">
                <p className="text-xs text-fg-secondary leading-5">
                  <b>用法</b>：点击时间轴上的 checkpoint 查看当时的消息快照 → 在输入框写新指令（可留空）→ 点「Fork 从这里重跑」。
                  新 run 会带着该 checkpoint 之前的全部上下文执行新方向 — 旧 run 不受影响。
                </p>
              </div>

              <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                {checkpoints.length === 0 && (
                  <div className="glass rounded-xl border border-glass-border p-6 text-center text-xs text-fg-muted">该 run 没有 checkpoint</div>
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
                        {cp.preview.map((m, i) => (
                          <div key={i} className="flex gap-2 text-[11px] leading-4">
                            <span className={m.role === 'user' ? 'text-brand shrink-0' : m.role === 'tool' ? 'text-fg-muted shrink-0' : 'text-status-info shrink-0'}>
                              {m.role}{m.toolName ? `:${m.toolName}` : ''}
                            </span>
                            <span className="text-fg-secondary break-all line-clamp-2">{m.contentPreview || (m.toolCalls ? `[${m.toolCalls.join(', ')}]` : '')}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {activeCp !== null && (
                <div className="glass rounded-xl border border-brand/30 p-3 space-y-2">
                  <textarea
                    value={instruction}
                    onChange={e => setInstruction(e.target.value)}
                    placeholder={`新指令（可选）— 留空则按原目标从 checkpoint #${activeCp} 重跑`}
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
