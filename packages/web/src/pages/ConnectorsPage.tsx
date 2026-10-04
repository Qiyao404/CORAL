import { useCallback, useEffect, useState } from 'react';
import {
  Plug, Plus, RefreshCw, Trash2, ToggleLeft, ToggleRight, Clock, Webhook,
  Loader2, CheckCircle2, XCircle, AlertTriangle, Copy,
} from 'lucide-react';
import { api } from '../api/client';
import { Tag } from '../components/ui';

/**
 * M3-4/M3-5：连接器页 — MCP 管理 + 触发器（个人 agent 的自动化入口）。
 *  · MCP tab：外部 server 列表/添加/启停/重连/删除/工具预览/最近错误 + Claude Desktop 配置片段
 *  · 触发器 tab：定时（interval/cron）与 webhook 列表/创建/启停/触发记录
 */

interface McpServerItem {
  id: string; name: string; transport: 'stdio' | 'http';
  command?: string | null; args_json?: string | null; url?: string | null;
  enabled: number; tool_count?: number | null; last_error?: string | null; tools_preview?: string | null;
}

interface TriggerItem {
  id: string; name: string; enabled: number; kind: 'interval' | 'cron' | 'webhook'; spec: string;
  action_json: string; last_fired_at: string | null; next_fire_at: string | null;
  fire_count: number; last_error: string | null;
}

export default function ConnectorsPage() {
  const [tab, setTab] = useState<'mcp' | 'triggers'>(localStorage.getItem('coral.connectors.tab') as any ?? 'mcp');
  const [servers, setServers] = useState<McpServerItem[]>([]);
  const [triggers, setTriggers] = useState<TriggerItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [claudeConfig, setClaudeConfig] = useState<string | null>(null);
  const [showTriggerAdd, setShowTriggerAdd] = useState(false);

  useEffect(() => { localStorage.setItem('coral.connectors.tab', tab); }, [tab]);

  const refresh = useCallback(async () => {
    try {
      const [m, t] = await Promise.all([api.listMcpServers(), api.listTriggers()]);
      setServers(m.items ?? []);
      setTriggers(t.items ?? []);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const act = async (fn: () => Promise<any>) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r?.message) setMsg(r.message);
      await refresh();
    } catch (err: any) {
      setMsg(err.message || '操作失败');
    } finally { setBusy(false); }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-brand-soft rounded-xl flex items-center justify-center border border-brand/30">
          <Plug className="w-5 h-5 text-brand" />
        </div>
        <div>
          <h1 className="text-xl font-heading font-medium text-fg-primary">连接器</h1>
          <p className="text-xs text-fg-muted">MCP 外部工具接入 · 定时与 Webhook 触发器</p>
        </div>
      </div>

      <div className="flex gap-2">
        {([['mcp', 'MCP 工具'], ['triggers', '触发器']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3 py-1.5 rounded-lg text-xs cursor-pointer border ${tab === k ? 'bg-brand text-white border-brand' : 'glass border-glass-border text-fg-secondary hover:border-brand/40'}`}>
            {label}
          </button>
        ))}
      </div>
      {msg && <div className="text-xs text-fg-secondary glass border border-glass-border rounded-lg px-3 py-2">{msg}</div>}

      {tab === 'mcp' && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <button onClick={() => setShowAdd(a => !a)} className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs flex items-center gap-1.5 cursor-pointer hover:bg-brand-hover">
              <Plus className="w-3.5 h-3.5" /> 添加 MCP Server
            </button>
            <button onClick={() => act(() => api.getClaudeConfig().then((d: any) => { setClaudeConfig(JSON.stringify(d.config, null, 2)); return null; }))}
              className="px-3 py-1.5 rounded-lg glass border border-glass-border text-xs text-fg-secondary flex items-center gap-1.5 cursor-pointer hover:border-brand/40">
              <Copy className="w-3.5 h-3.5" /> Claude Desktop 接入 CORAL
            </button>
          </div>
          {claudeConfig && (
            <pre className="glass border border-glass-border rounded-xl p-3 text-xs text-fg-secondary overflow-x-auto">{claudeConfig}</pre>
          )}
          {showAdd && <AddMcpForm onAdd={payload => act(() => api.addMcpServer(payload)).then(() => setShowAdd(false))} />}

          {servers.length === 0 && (
            <div className="glass rounded-xl border border-glass-border p-6 text-center text-xs text-fg-muted">
              还没有外部 MCP server — 添加后其工具自动进入对话模式的 agent 工具集（如社区 filesystem / fetch / everything）
            </div>
          )}
          {servers.map(s => {
            const tools = s.tools_preview ? JSON.parse(s.tools_preview) : [];
            return (
              <div key={s.id} className="glass rounded-xl border border-glass-border p-3 space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  <Tag variant={s.enabled ? 'success' : 'info'}>{s.enabled ? '启用' : '停用'}</Tag>
                  <span className="font-medium text-fg-primary">{s.name}</span>
                  <Tag variant="brand">{s.transport}</Tag>
                  {s.command && <span className="text-fg-muted font-mono truncate">{s.command}</span>}
                  {s.url && <span className="text-fg-muted truncate">{s.url}</span>}
                  <span className="flex-1" />
                  <button onClick={() => act(() => api.toggleMcpServer(s.id, !s.enabled))} disabled={busy} className="cursor-pointer text-fg-muted hover:text-brand">
                    {s.enabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                  </button>
                  <button onClick={() => act(() => api.reconnectMcpServer(s.id))} disabled={busy} className="cursor-pointer text-fg-muted hover:text-brand" title="重连">
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => act(() => api.deleteMcpServer(s.id))} disabled={busy} className="cursor-pointer text-fg-muted hover:text-status-danger" title="删除">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="text-[11px] text-fg-muted flex items-center gap-2">
                  {s.last_error
                    ? <span className="text-status-danger flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {s.last_error.slice(0, 120)}</span>
                    : <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-status-success" /> {s.tool_count ?? 0} 个工具已进入 agent 工具集</span>}
                </div>
                {tools.length > 0 && (
                  <details className="text-[11px] text-fg-secondary">
                    <summary className="cursor-pointer text-fg-muted">工具预览（{tools.length}）</summary>
                    <div className="mt-1 space-y-0.5">
                      {tools.map((t: any) => (
                        <div key={t.name} className="flex gap-2"><span className="font-mono text-brand">{t.name}</span><span className="text-fg-muted truncate">{t.description}</span></div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'triggers' && (
        <div className="space-y-3">
          <button onClick={() => setShowTriggerAdd(a => !a)} className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs flex items-center gap-1.5 cursor-pointer hover:bg-brand-hover">
            <Plus className="w-3.5 h-3.5" /> 新建触发器
          </button>
          {showTriggerAdd && <AddTriggerForm onAdd={payload => act(() => api.createTrigger(payload)).then(() => setShowTriggerAdd(false))} />}

          {triggers.length === 0 && (
            <div className="glass rounded-xl border border-glass-border p-6 text-center text-xs text-fg-muted">
              还没有触发器 — 定时执行任务（interval/cron），或生成 webhook 让外部系统（GitHub/监控系统）唤起 agent
            </div>
          )}
          {triggers.map(t => {
            let action: any = {};
            try { action = JSON.parse(t.action_json); } catch { /* ignore */ }
            return (
              <div key={t.id} className="glass rounded-xl border border-glass-border p-3 space-y-1.5">
                <div className="flex items-center gap-2 text-xs">
                  <Tag variant={t.enabled ? 'success' : 'info'}>{t.enabled ? '启用' : '停用'}</Tag>
                  {t.kind === 'webhook'
                    ? <Webhook className="w-3.5 h-3.5 text-fg-muted" />
                    : <Clock className="w-3.5 h-3.5 text-fg-muted" />}
                  <span className="font-medium text-fg-primary">{t.name}</span>
                  <Tag variant="brand">{t.kind === 'interval' ? `每 ${t.spec}s` : t.kind === 'cron' ? t.spec : '入站'}</Tag>
                  <span className="flex-1" />
                  <button onClick={() => act(() => api.toggleTrigger(t.id, !t.enabled))} disabled={busy} className="cursor-pointer text-fg-muted hover:text-brand">
                    {t.enabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                  </button>
                  <button onClick={() => act(() => api.deleteTrigger(t.id))} disabled={busy} className="cursor-pointer text-fg-muted hover:text-status-danger">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="text-[11px] text-fg-muted truncate">动作：{action.goal}</div>
                {t.kind === 'webhook' && (
                  <div className="text-[11px] font-mono text-fg-secondary break-all">
                    POST /api/hooks/{t.id} <button className="ml-1 text-brand cursor-pointer" onClick={() => { navigator.clipboard?.writeText(`http://localhost:3001/api/hooks/${t.id}`); setMsg('webhook 地址已复制'); }}>复制</button>
                  </div>
                )}
                <div className="text-[11px] text-fg-muted flex gap-3 flex-wrap">
                  <span>已触发 {t.fire_count} 次</span>
                  {t.last_fired_at && <span>最近：{new Date(t.last_fired_at).toLocaleString()}</span>}
                  {t.next_fire_at && t.kind !== 'webhook' && <span>下次：{new Date(t.next_fire_at).toLocaleString()}</span>}
                  {t.last_error && <span className="text-status-danger"><XCircle className="w-3 h-3 inline" /> {t.last_error.slice(0, 80)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AddMcpForm({ onAdd }: { onAdd: (payload: any) => void }) {
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');

  return (
    <div className="glass rounded-xl border border-glass-border p-3 space-y-2 text-xs">
      <div className="flex gap-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="名称（英文，工具前缀 mcp_<名>_…）"
          className="flex-1 glass border border-glass-border rounded-lg px-2 py-1.5 outline-none focus:border-brand/40" />
        <select value={transport} onChange={e => setTransport(e.target.value as any)} className="glass border border-glass-border rounded-lg px-2 py-1.5">
          <option value="stdio">stdio</option>
          <option value="http">http</option>
        </select>
      </div>
      {transport === 'stdio' ? (
        <>
          <input value={command} onChange={e => setCommand(e.target.value)} placeholder="command（如 npx / node / uvx）"
            className="w-full glass border border-glass-border rounded-lg px-2 py-1.5 font-mono outline-none focus:border-brand/40" />
          <input value={args} onChange={e => setArgs(e.target.value)} placeholder="参数（空格分隔，如 -y @modelcontextprotocol/server-filesystem /path）"
            className="w-full glass border border-glass-border rounded-lg px-2 py-1.5 font-mono outline-none focus:border-brand/40" />
        </>
      ) : (
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="http(s) URL（Streamable HTTP transport）"
          className="w-full glass border border-glass-border rounded-lg px-2 py-1.5 font-mono outline-none focus:border-brand/40" />
      )}
      <div className="flex gap-2">
        <button onClick={() => onAdd({ name, transport, command: command || undefined, args: args ? args.split(/\s+/).filter(Boolean) : undefined, url: url || undefined })}
          className="px-3 py-1.5 rounded-lg bg-brand text-white cursor-pointer hover:bg-brand-hover">连接并添加</button>
      </div>
    </div>
  );
}

function AddTriggerForm({ onAdd }: { onAdd: (payload: any) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'interval' | 'cron' | 'webhook'>('interval');
  const [spec, setSpec] = useState('');
  const [goal, setGoal] = useState('');

  return (
    <div className="glass rounded-xl border border-glass-border p-3 space-y-2 text-xs">
      <div className="flex gap-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="名称（如 每日摘要）"
          className="flex-1 glass border border-glass-border rounded-lg px-2 py-1.5 outline-none focus:border-brand/40" />
        <select value={kind} onChange={e => setKind(e.target.value as any)} className="glass border border-glass-border rounded-lg px-2 py-1.5">
          <option value="interval">定时间隔</option>
          <option value="cron">cron</option>
          <option value="webhook">webhook</option>
        </select>
      </div>
      {kind !== 'webhook' && (
        <input value={spec} onChange={e => setSpec(e.target.value)}
          placeholder={kind === 'interval' ? '间隔秒数（≥60，如 3600 = 每小时）' : 'cron 表达式（分 时 日 月 周，如 0 9 * * * = 每天 9 点）'}
          className="w-full glass border border-glass-border rounded-lg px-2 py-1.5 font-mono outline-none focus:border-brand/40" />
      )}
      <textarea value={goal} onChange={e => setGoal(e.target.value)}
        placeholder={kind === 'webhook' ? '触发时的目标（body 顶层键可用 {{key}} 注入，如 处理告警：{{title}}）' : '触发时要执行的目标（交给 agent 自主完成）'}
        className="w-full h-16 glass border border-glass-border rounded-lg px-2 py-1.5 outline-none focus:border-brand/40 resize-none" />
      <button onClick={() => onAdd({ name, kind, spec: spec || '', action: { mode: 'free', goal } })}
        className="px-3 py-1.5 rounded-lg bg-brand text-white cursor-pointer hover:bg-brand-hover">创建</button>
    </div>
  );
}
