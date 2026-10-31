import { useCallback, useEffect, useState } from 'react';
import {
  Plug, Plus, RefreshCw, Trash2, ToggleLeft, ToggleRight, Clock, Webhook,
  Loader2, CheckCircle2, XCircle, AlertTriangle, Copy, HelpCircle,
} from 'lucide-react';
import { api } from '../api/client';
import { useI18n } from '../i18n';
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

/** 使用指引（用户实测反馈"看不懂怎么操作"） */
function GuidePanel({ tab }: { tab: 'mcp' | 'triggers' }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(() => localStorage.getItem('coral.conn.guide') !== '1');
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-fg-muted flex items-center gap-1 cursor-pointer hover:text-brand">
        <HelpCircle className="w-3.5 h-3.5" /> {tab === 'mcp' ? t('connectors.guideMcpQuestion') : t('connectors.guideTriggerQuestion')}{t('connectors.guideWithExamples')}
      </button>
    );
  }
  return (
    <div className="glass rounded-xl border border-glass-border p-4 text-xs text-fg-secondary leading-6">
      <div className="flex items-center gap-2 mb-2">
        <HelpCircle className="w-4 h-4 text-brand" />
        <span className="font-medium text-fg-primary">{tab === 'mcp' ? t('connectors.guideMcpTitle') : t('connectors.guideTriggerTitle')}</span>
        <span className="flex-1" />
        <button onClick={() => { setOpen(false); localStorage.setItem('coral.conn.guide', '1'); }}
          className="text-fg-muted hover:text-fg-primary cursor-pointer">{t('connectors.collapse')}</button>
      </div>
      {tab === 'mcp' ? (
        <>
          <p><b>{t('connectors.guideMcpWhat')}</b>{t('connectors.guideMcpIntro')}</p>
          <p className="mt-2"><b>{t('connectors.guideTryFirst')}</b>{t('connectors.guideTryDesc')} <code className="text-brand">filesystem</code> {t('connectors.guideTryStdio')} <code className="text-brand">npx</code> {t('connectors.guideTryArgs')} <code className="text-brand">{t('connectors.guideTryPath')}</code> {t('connectors.guideTryConnect')}</p>
          <p className="mt-2 text-fg-muted">{t('connectors.guideFindMore')}</p>
        </>
      ) : (
        <>
          <p><b>{t('connectors.guideTriggerWhat')}</b>{t('connectors.guideTriggerIntroA')} <b>{t('connectors.guideTriggerAuto')}</b>{t('connectors.guideTriggerIntroB')}</p>
          <p className="mt-2"><b>{t('connectors.guideEx1Title')}</b>{t('connectors.guideEx1A')} <code className="text-brand">86400</code> {t('connectors.guideEx1B')}</p>
          <p className="mt-2"><b>{t('connectors.guideEx2Title')}</b>{t('connectors.guideEx2A')}{'{{title}}'}{t('connectors.guideEx2B')}</p>
          <p className="mt-2 text-fg-muted">{t('connectors.guideTriggerListHint')}</p>
        </>
      )}
    </div>
  );
}

export default function ConnectorsPage() {
  const { t } = useI18n();
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
      setMsg(err.message || t('connectors.operationFailed'));
    } finally { setBusy(false); }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-brand-soft rounded-xl flex items-center justify-center border border-brand/30">
          <Plug className="w-5 h-5 text-brand" />
        </div>
        <div>
          <h1 className="text-xl font-heading font-medium text-fg-primary">{t('connectors.title')}</h1>
          <p className="text-xs text-fg-muted">{t('connectors.subtitle')}</p>
        </div>
      </div>

      <div className="flex gap-2">
        {([['mcp', 'connectors.tabMcp'], ['triggers', 'connectors.tabTriggers']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3 py-1.5 rounded-lg text-xs cursor-pointer border ${tab === k ? 'bg-brand text-white border-brand' : 'glass border-glass-border text-fg-secondary hover:border-brand/40'}`}>
            {t(label)}
          </button>
        ))}
      </div>
      {msg && <div className="text-xs text-fg-secondary glass border border-glass-border rounded-lg px-3 py-2">{msg}</div>}
      <GuidePanel tab={tab} />

      {tab === 'mcp' && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <button onClick={() => setShowAdd(a => !a)} className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs flex items-center gap-1.5 cursor-pointer hover:bg-brand-hover">
              <Plus className="w-3.5 h-3.5" /> {t('connectors.addMcpServer')}
            </button>
            <button onClick={() => act(() => api.getClaudeConfig().then((d: any) => { setClaudeConfig(JSON.stringify(d.config, null, 2)); return null; }))}
              className="px-3 py-1.5 rounded-lg glass border border-glass-border text-xs text-fg-secondary flex items-center gap-1.5 cursor-pointer hover:border-brand/40">
              <Copy className="w-3.5 h-3.5" /> {t('connectors.claudeDesktop')}
            </button>
          </div>
          {claudeConfig && (
            <pre className="glass border border-glass-border rounded-xl p-3 text-xs text-fg-secondary overflow-x-auto">{claudeConfig}</pre>
          )}
          {showAdd && <AddMcpForm onAdd={payload => act(() => api.addMcpServer(payload)).then(() => setShowAdd(false))} />}

          {servers.length === 0 && (
            <div className="glass rounded-xl border border-glass-border p-6 text-center text-xs text-fg-muted">
              {t('connectors.mcpEmpty')}
            </div>
          )}
          {servers.map(s => {
            let tools: any[] = [];
            try { tools = s.tools_preview ? JSON.parse(s.tools_preview) : []; } catch { /* 脏数据不炸渲染 */ }
            return (
              <div key={s.id} className="glass rounded-xl border border-glass-border p-3 space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  <Tag variant={s.enabled ? 'success' : 'info'}>{s.enabled ? t('connectors.enabled') : t('connectors.disabled')}</Tag>
                  <span className="font-medium text-fg-primary">{s.name}</span>
                  <Tag variant="brand">{s.transport}</Tag>
                  {s.command && <span className="text-fg-muted font-mono truncate">{s.command}</span>}
                  {s.url && <span className="text-fg-muted truncate">{s.url}</span>}
                  <span className="flex-1" />
                  <button onClick={() => act(() => api.toggleMcpServer(s.id, !s.enabled))} disabled={busy} className="cursor-pointer text-fg-muted hover:text-brand">
                    {s.enabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                  </button>
                  <button onClick={() => act(() => api.reconnectMcpServer(s.id))} disabled={busy} className="cursor-pointer text-fg-muted hover:text-brand" title={t('connectors.reconnect')}>
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => act(() => api.deleteMcpServer(s.id))} disabled={busy} className="cursor-pointer text-fg-muted hover:text-status-danger" title={t('connectors.delete')}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="text-[11px] text-fg-muted flex items-center gap-2">
                  {s.last_error
                    ? <span className="text-status-danger flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {s.last_error.slice(0, 120)}</span>
                    : <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-status-success" /> {t('connectors.toolsJoined', { n: s.tool_count ?? 0 })}</span>}
                </div>
                {tools.length > 0 && (
                  <details className="text-[11px] text-fg-secondary">
                    <summary className="cursor-pointer text-fg-muted">{t('connectors.toolsPreview', { n: tools.length })}</summary>
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
            <Plus className="w-3.5 h-3.5" /> {t('connectors.newTrigger')}
          </button>
          {showTriggerAdd && <AddTriggerForm onAdd={payload => act(() => api.createTrigger(payload)).then(() => setShowTriggerAdd(false))} />}

          {triggers.length === 0 && (
            <div className="glass rounded-xl border border-glass-border p-6 text-center text-xs text-fg-muted">
              {t('connectors.triggersEmpty')}
            </div>
          )}
          {triggers.map(tr => {
            let action: any = {};
            try { action = JSON.parse(tr.action_json); } catch { /* ignore */ }
            return (
              <div key={tr.id} className="glass rounded-xl border border-glass-border p-3 space-y-1.5">
                <div className="flex items-center gap-2 text-xs">
                  <Tag variant={tr.enabled ? 'success' : 'info'}>{tr.enabled ? t('connectors.enabled') : t('connectors.disabled')}</Tag>
                  {tr.kind === 'webhook'
                    ? <Webhook className="w-3.5 h-3.5 text-fg-muted" />
                    : <Clock className="w-3.5 h-3.5 text-fg-muted" />}
                  <span className="font-medium text-fg-primary">{tr.name}</span>
                  <Tag variant="brand">{tr.kind === 'interval' ? t('connectors.everySeconds', { n: tr.spec }) : tr.kind === 'cron' ? tr.spec : t('connectors.webhookInbound')}</Tag>
                  <span className="flex-1" />
                  <button onClick={() => act(() => api.toggleTrigger(tr.id, !tr.enabled))} disabled={busy} className="cursor-pointer text-fg-muted hover:text-brand">
                    {tr.enabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                  </button>
                  <button onClick={() => act(() => api.deleteTrigger(tr.id))} disabled={busy} className="cursor-pointer text-fg-muted hover:text-status-danger">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="text-[11px] text-fg-muted truncate">{t('connectors.actionLabel')}{action.goal}</div>
                {tr.kind === 'webhook' && (
                  <div className="text-[11px] font-mono text-fg-secondary break-all">
                    POST /api/hooks/{tr.id} <button className="ml-1 text-brand cursor-pointer" onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}/api/hooks/${tr.id}`); setMsg(t('connectors.webhookCopied')); }}>{t('connectors.copy')}</button>
                  </div>
                )}
                <div className="text-[11px] text-fg-muted flex gap-3 flex-wrap">
                  <span>{t('connectors.firedCount', { n: tr.fire_count })}</span>
                  {tr.last_fired_at && <span>{t('connectors.lastFired')}{new Date(tr.last_fired_at).toLocaleString()}</span>}
                  {tr.next_fire_at && tr.kind !== 'webhook' && <span>{t('connectors.nextFire')}{new Date(tr.next_fire_at).toLocaleString()}</span>}
                  {tr.last_error && <span className="text-status-danger"><XCircle className="w-3 h-3 inline" /> {tr.last_error.slice(0, 80)}</span>}
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
  const { t } = useI18n();
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');

  return (
    <div className="glass rounded-xl border border-glass-border p-3 space-y-2 text-xs">
      <div className="flex gap-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder={t('connectors.mcpNamePlaceholder')}
          className="flex-1 glass border border-glass-border rounded-lg px-2 py-1.5 outline-none focus:border-brand/40" />
        <select value={transport} onChange={e => setTransport(e.target.value as any)} className="glass border border-glass-border rounded-lg px-2 py-1.5">
          <option value="stdio">stdio</option>
          <option value="http">http</option>
        </select>
      </div>
      {transport === 'stdio' ? (
        <>
          <input value={command} onChange={e => setCommand(e.target.value)} placeholder={t('connectors.commandPlaceholder')}
            className="w-full glass border border-glass-border rounded-lg px-2 py-1.5 font-mono outline-none focus:border-brand/40" />
          <input value={args} onChange={e => setArgs(e.target.value)} placeholder={t('connectors.argsPlaceholder')}
            className="w-full glass border border-glass-border rounded-lg px-2 py-1.5 font-mono outline-none focus:border-brand/40" />
        </>
      ) : (
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder={t('connectors.urlPlaceholder')}
          className="w-full glass border border-glass-border rounded-lg px-2 py-1.5 font-mono outline-none focus:border-brand/40" />
      )}
      <div className="flex gap-2">
        <button onClick={() => onAdd({ name, transport, command: command || undefined, args: args ? args.split(/\s+/).filter(Boolean) : undefined, url: url || undefined })}
          className="px-3 py-1.5 rounded-lg bg-brand text-white cursor-pointer hover:bg-brand-hover">{t('connectors.connectAndAdd')}</button>
      </div>
    </div>
  );
}

function AddTriggerForm({ onAdd }: { onAdd: (payload: any) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'interval' | 'cron' | 'webhook'>('interval');
  const [spec, setSpec] = useState('');
  const [goal, setGoal] = useState('');

  return (
    <div className="glass rounded-xl border border-glass-border p-3 space-y-2 text-xs">
      <div className="flex gap-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder={t('connectors.triggerNamePlaceholder')}
          className="flex-1 glass border border-glass-border rounded-lg px-2 py-1.5 outline-none focus:border-brand/40" />
        <select value={kind} onChange={e => setKind(e.target.value as any)} className="glass border border-glass-border rounded-lg px-2 py-1.5">
          <option value="interval">{t('connectors.kindInterval')}</option>
          <option value="cron">cron</option>
          <option value="webhook">webhook</option>
        </select>
      </div>
      {kind !== 'webhook' && (
        <input value={spec} onChange={e => setSpec(e.target.value)}
          placeholder={kind === 'interval' ? t('connectors.specIntervalPlaceholder') : t('connectors.specCronPlaceholder')}
          className="w-full glass border border-glass-border rounded-lg px-2 py-1.5 font-mono outline-none focus:border-brand/40" />
      )}
      <textarea value={goal} onChange={e => setGoal(e.target.value)}
        placeholder={kind === 'webhook' ? t('connectors.goalWebhookPlaceholder') : t('connectors.goalPlaceholder')}
        className="w-full h-16 glass border border-glass-border rounded-lg px-2 py-1.5 outline-none focus:border-brand/40 resize-none" />
      <button onClick={() => onAdd({ name, kind, spec: spec || '', action: { mode: 'free', goal } })}
        className="px-3 py-1.5 rounded-lg bg-brand text-white cursor-pointer hover:bg-brand-hover">{t('connectors.create')}</button>
    </div>
  );
}
