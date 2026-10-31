import { useEffect, useState } from 'react';
import { Webhook, Plus, Play, Trash2, Pencil, Activity, FileJson } from 'lucide-react';
import { api } from '../api/client';
import { Card, Button, Input, Tag } from '../components/ui';
import { useI18n } from '../i18n';

interface HookEntry {
  matcher?: string;
  command: string;
  timeout?: number;
  enabled?: boolean;
}

interface RecentFiring {
  ts: number;
  event: string;
  tool?: string;
  durationMs: number;
  decision: string;
  reason?: string;
  matched: number;
  failed: number;
}

interface TestResult {
  exitCode: number | null;
  durationMs: number;
  decision: string;
  reason?: string;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
}

const EVENTS = [
  'pre_tool_use', 'post_tool_use', 'stop', 'user_prompt_submit',
  'session_start', 'session_end', 'pre_compact', 'notification',
] as const;

/** 事件能力徽章（能否否决/改写/注入 — 与运行时契约一致） */
function eventPowers(event: string): string[] {
  switch (event) {
    case 'pre_tool_use': return ['deny', 'ask', 'rewrite', 'context'];
    case 'post_tool_use': return ['observe'];
    case 'stop': return ['block'];
    case 'user_prompt_submit': return ['deny', 'context'];
    case 'session_start': return ['context'];
    case 'session_end': return ['observe'];
    case 'pre_compact': return ['block'];
    case 'notification': return ['observe'];
    default: return [];
  }
}

function decisionTagVariant(decision: string): 'success' | 'danger' | 'warn' | 'default' {
  if (decision === 'allow') return 'success';
  if (decision === 'deny') return 'danger';
  if (decision === 'block' || decision === 'ask') return 'warn';
  return 'default';
}

export default function HooksPage() {
  const { t } = useI18n();
  const [config, setConfig] = useState<Record<string, HookEntry[]>>({});
  const [configPath, setConfigPath] = useState('');
  const [recent, setRecent] = useState<RecentFiring[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  // 编辑器（新增/修改一条）：event + 索引定位（-1 = 新增）
  const [draft, setDraft] = useState<{ event: string; index: number; command: string; matcher: string; timeout: string } | null>(null);
  const [testResult, setTestResult] = useState<(TestResult & { label: string }) | null>(null);
  const [testing, setTesting] = useState(false);

  const load = async () => {
    try {
      const r = await api.getHooks();
      setConfig(r.hooks ?? {});
      setConfigPath(r.configPath ?? '');
      setRecent(r.recent ?? []);
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const persist = async (next: Record<string, HookEntry[]>) => {
    setConfig(next);
    setMessage('');
    try {
      await api.saveHooks(next);
    } catch (err: any) {
      setMessage(err.message);
      await load(); // 保存失败回滚到磁盘状态
    }
  };

  const startAdd = (event: string) => {
    setDraft({ event, index: -1, command: '', matcher: '', timeout: '60' });
    setTestResult(null);
  };
  const startEdit = (event: string, index: number) => {
    const e = config[event]?.[index];
    if (!e) return;
    setDraft({ event, index, command: e.command, matcher: e.matcher ?? '', timeout: String(e.timeout ?? 60) });
    setTestResult(null);
  };
  const saveDraft = async () => {
    if (!draft || !draft.command.trim()) { setMessage(t('hooks.errCommandEmpty')); return; }
    const next: Record<string, HookEntry[]> = JSON.parse(JSON.stringify(config));
    const list = [...(next[draft.event] ?? [])];
    const entry: HookEntry = {
      command: draft.command.trim(),
      ...(draft.matcher.trim() ? { matcher: draft.matcher.trim() } : {}),
      timeout: Math.max(1, Math.min(300, Number(draft.timeout) || 60)),
    };
    if (draft.index >= 0) {
      // 编辑保留 enabled 状态
      const prev = list[draft.index];
      list[draft.index] = { ...entry, ...(prev?.enabled === false ? { enabled: false } : {}) };
    } else {
      list.push(entry);
    }
    next[draft.event] = list;
    await persist(next);
    setDraft(null);
  };

  const removeEntry = async (event: string, index: number) => {
    const next: Record<string, HookEntry[]> = {};
    for (const [ev, list] of Object.entries(config)) {
      const filtered = list.filter((_, i) => !(ev === event && i === index));
      if (filtered.length > 0) next[ev] = filtered;
    }
    await persist(next);
    setDraft(null);
  };

  const toggleEnabled = async (event: string, index: number) => {
    const next: Record<string, HookEntry[]> = JSON.parse(JSON.stringify(config));
    const e = next[event][index];
    e.enabled = e.enabled === false ? undefined : false;
    if (e.enabled === undefined) delete e.enabled;
    await persist(next);
  };

  const runTest = async (command: string, event: string, label: string) => {
    if (!command.trim()) { setMessage(t('hooks.errCommandEmpty')); return; }
    setTesting(true);
    setTestResult(null);
    setMessage('');
    try {
      const r = await api.testHook({ event, command });
      setTestResult({ ...r, label });
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-fg-muted">{t('hooks.loading')}</div>;
  }

  return (
    <div className="p-8 max-w-4xl mx-auto animate-fade-in-up">
      <div className="mb-6">
        <h1 className="text-2xl font-heading font-bold text-fg-primary flex items-center gap-2">
          <Webhook className="w-6 h-6" /> {t('hooks.title')}
        </h1>
        <p className="text-fg-muted mt-1">{t('hooks.subtitle')}</p>
      </div>

      {/* 契约说明 */}
      <Card className="mb-6">
        <p className="text-xs text-fg-secondary leading-relaxed">
          {t('hooks.contract1')} <code className="font-mono text-brand">stdin</code> {t('hooks.contract2')}{' '}
          <code className="font-mono text-brand">stdout</code> {t('hooks.contract3')} <code className="font-mono text-brand">exit 2</code>{t('hooks.contract4')}
        </p>
        <p className="text-xs text-fg-muted mt-2 flex items-center gap-1.5">
          <FileJson className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate font-mono">{configPath}</span>
          <span className="text-fg-disabled shrink-0">{t('hooks.configFileNote')}</span>
        </p>
      </Card>

      {message && <p className="mb-4 text-sm text-status-danger">{message}</p>}

      {/* 编辑器 */}
      {draft && (
        <Card className="mb-6 border-brand/30">
          <h3 className="font-heading font-semibold text-fg-primary mb-3">
            {draft.index >= 0 ? t('hooks.editTitle') : t('hooks.addTitle')} · {draft.event}
          </h3>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-fg-muted mb-1">{t('hooks.commandLabel')}</label>
              <Input
                value={draft.command}
                onChange={e => setDraft(d => d ? { ...d, command: e.target.value } : d)}
                placeholder={t('hooks.commandPlaceholder')}
                className="font-mono text-xs"
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-fg-muted mb-1">{t('hooks.matcherLabel')}</label>
                <Input
                  value={draft.matcher}
                  onChange={e => setDraft(d => d ? { ...d, matcher: e.target.value } : d)}
                  placeholder={t('hooks.matcherPlaceholder')}
                  className="font-mono text-xs"
                />
                <p className="text-[11px] text-fg-muted mt-1">{t('hooks.matcherHint')}</p>
              </div>
              <div>
                <label className="block text-xs text-fg-muted mb-1">{t('hooks.timeoutLabel')}</label>
                <Input
                  type="number"
                  value={draft.timeout}
                  onChange={e => setDraft(d => d ? { ...d, timeout: e.target.value } : d)}
                />
                <p className="text-[11px] text-fg-muted mt-1">{t('hooks.timeoutHint')}</p>
              </div>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <Button onClick={saveDraft}>{t('hooks.saveEntry')}</Button>
            <Button
              variant="secondary"
              disabled={testing}
              onClick={() => runTest(draft.command, draft.event, draft.event)}
              icon={<Play className="w-3.5 h-3.5" />}
            >
              {testing ? t('hooks.testing') : t('hooks.testEntry')}
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>{t('hooks.cancel')}</Button>
          </div>
        </Card>
      )}

      {/* 测试结果 */}
      {testResult && (
        <Card className="mb-6">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-medium text-fg-primary">{t('hooks.testResultTitle')}</span>
            <Tag variant={decisionTagVariant(testResult.decision)}>{testResult.decision}</Tag>
            <span className="text-xs text-fg-muted">{testResult.durationMs} ms · exit {String(testResult.exitCode)}</span>
          </div>
          {testResult.reason && <p className="text-xs text-status-warn mb-2">{testResult.reason}</p>}
          {testResult.stdoutTail && (
            <pre className="text-[11px] font-mono bg-bg-panel/60 border border-glass-border rounded-lg p-2.5 mb-2 overflow-x-auto whitespace-pre-wrap">{testResult.stdoutTail}</pre>
          )}
          {testResult.stderrTail && (
            <pre className="text-[11px] font-mono text-status-danger/90 bg-bg-panel/60 border border-glass-border rounded-lg p-2.5 overflow-x-auto whitespace-pre-wrap">{testResult.stderrTail}</pre>
          )}
        </Card>
      )}

      {/* 8 个生命周期事件 */}
      <div className="space-y-4 mb-6">
        {EVENTS.map(event => {
          const entries = config[event] ?? [];
          return (
            <Card key={event}>
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-heading font-semibold text-fg-primary font-mono text-sm">{event}</h3>
                <Button size="sm" variant="ghost" onClick={() => startAdd(event)} icon={<Plus className="w-3.5 h-3.5" />}>
                  {t('hooks.add')}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 mb-3">
                <span className="text-xs text-fg-muted">{t(`hooks.event.${event}.desc`)}</span>
                {eventPowers(event).map(p => (
                  <Tag key={p} variant={p === 'observe' ? 'default' : 'info'}>{t(`hooks.power.${p}`)}</Tag>
                ))}
              </div>
              {entries.length === 0 ? (
                <p className="text-xs text-fg-disabled">{t('hooks.noEntries')}</p>
              ) : (
                <div className="space-y-1.5">
                  {entries.map((e, i) => (
                    <div key={i} className={`flex items-center gap-2 p-2.5 rounded-lg border text-xs ${e.enabled === false ? 'border-glass-border bg-bg-panel/20 opacity-60' : 'border-glass-border bg-bg-panel/40'}`}>
                      <code className="font-mono text-fg-primary truncate flex-1" title={e.command}>{e.command}</code>
                      {e.matcher && <code className="font-mono text-brand/80 shrink-0">/{e.matcher}/</code>}
                      <span className="text-fg-disabled shrink-0">{e.timeout ?? 60}s</span>
                      <button
                        type="button"
                        title={e.enabled === false ? t('hooks.enable') : t('hooks.disable')}
                        onClick={() => toggleEnabled(event, i)}
                        className={`shrink-0 w-9 h-4.5 rounded-full transition-colors relative ${e.enabled === false ? 'bg-fg-disabled/30' : 'bg-brand'}`}
                        style={{ height: '1.125rem' }}
                      >
                        <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-all ${e.enabled === false ? 'left-0.5' : 'left-[1.125rem]'}`} />
                      </button>
                      <Button size="sm" variant="ghost" disabled={testing} onClick={() => runTest(e.command, event, event)} icon={<Play className="w-3 h-3" />} title={t('hooks.testEntry')} />
                      <Button size="sm" variant="ghost" onClick={() => startEdit(event, i)} icon={<Pencil className="w-3 h-3" />} title={t('hooks.edit')} />
                      <Button size="sm" variant="ghost" onClick={() => removeEntry(event, i)} icon={<Trash2 className="w-3 h-3" />} title={t('hooks.delete')} />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {/* 最近命中 */}
      <Card>
        <h3 className="font-heading font-semibold text-fg-primary mb-3 flex items-center gap-2">
          <Activity className="w-4 h-4" /> {t('hooks.recentTitle')}
        </h3>
        {recent.length === 0 ? (
          <p className="text-xs text-fg-muted">{t('hooks.recentEmpty')}</p>
        ) : (
          <div className="space-y-1.5">
            {recent.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-xs py-1.5 border-b border-glass-border/40 last:border-0">
                <Tag variant={decisionTagVariant(f.decision)}>{f.decision}</Tag>
                <code className="font-mono text-fg-secondary">{f.event}</code>
                {f.tool && <code className="font-mono text-fg-muted truncate flex-1">{f.tool}</code>}
                {f.reason && <span className="text-fg-muted truncate" title={f.reason}>{f.reason}</span>}
                <span className="text-fg-disabled shrink-0 ml-auto">{f.durationMs} ms · {new Date(f.ts).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        )}
        <p className="text-[11px] text-fg-disabled mt-3">{t('hooks.recentNote')}</p>
      </Card>
    </div>
  );
}
