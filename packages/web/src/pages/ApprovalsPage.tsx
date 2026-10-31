import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, CheckCircle2, XCircle, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { Tag } from '../components/ui';
import { useI18n } from '../i18n';

/**
 * M2-4：审批中心 — 跨 run 汇聚全部待审批（Free 模式工具审批 + Graph 模式节点审批）。
 * 审批决定直接落到对应 run；graph 节点审批支持改参数（JSON 编辑）。
 */
interface PendingItem {
  runId: string;
  approvalId: string;
  kind: 'tool' | 'node';
  tool?: string;
  node?: string;
  skill?: string;
  goal?: string;
  input?: Record<string, any>;
}

export default function ApprovalsPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<PendingItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.listPendingApprovals();
      setItems(d.items ?? []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const decide = async (runId: string, approvalId: string, approved: boolean) => {
    let input: any;
    const draft = edits[approvalId];
    if (approved && draft && draft.trim()) {
      try { input = JSON.parse(draft); } catch { alert(t('approvals.invalidJson')); return; }
    }
    try {
      await api.resolveApproval(runId, approvalId, approved, input);
      await refresh();
    } catch (err: any) {
      alert(t('approvals.failed', { msg: err.message }));
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-brand-soft rounded-xl flex items-center justify-center border border-brand/30">
          <ShieldAlert className="w-5 h-5 text-brand" />
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-heading font-medium text-fg-primary">{t('approvals.title')}</h1>
          <p className="text-xs text-fg-muted">{t('approvals.subtitle')}</p>
        </div>
        <button onClick={refresh} className="p-2 glass border border-glass-border rounded-lg cursor-pointer hover:border-brand/40">
          {loading ? <Loader2 className="w-4 h-4 animate-spin text-fg-muted" /> : <RefreshCw className="w-4 h-4 text-fg-muted" />}
        </button>
      </div>
      <div className="glass rounded-xl border border-glass-border p-3 text-xs text-fg-secondary leading-6">
        <p><b>{t('approvals.whatTitle')}</b>{t('approvals.whatLead')}<b>{t('approvals.toolApproval')}</b>{t('approvals.whatTool')}<b>{t('approvals.nodeApproval')}</b>{t('approvals.whatNode')}<code className="text-brand">permission: approval</code>{t('approvals.whatNodeEnd')}</p>
        <p className="mt-1"><b>{t('approvals.choicesTitle')}</b>{t('approvals.choicesColon')}<b>{t('approvals.approve')}</b>{t('approvals.choicesApprove')}<b>{t('approvals.deny')}</b>{t('approvals.choicesDeny')}<b>{t('approvals.approveEdited')}</b>{t('approvals.choicesApproveEdited')}</p>
      </div>

      {items.length === 0 && (
        <div className="glass rounded-xl border border-glass-border p-8 text-center">
          <CheckCircle2 className="w-8 h-8 text-status-success mx-auto mb-2" />
          <p className="text-sm text-fg-secondary">{t('approvals.empty')}</p>
        </div>
      )}

      {items.map(item => (
        <div key={item.approvalId} className="glass rounded-xl border border-status-warning/30 p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <Tag variant={item.kind === 'node' ? 'brand' : 'info'}>{item.kind === 'node' ? t('approvals.graphNode') : t('approvals.tool')}</Tag>
            <span className="text-fg-primary font-medium">{item.node ?? item.tool}</span>
            {item.skill && <span className="text-fg-muted">{item.skill}</span>}
            <span className="flex-1" />
            <span className="text-fg-muted font-mono">{item.runId}</span>
          </div>
          {item.goal && (
            <p className="text-xs text-fg-muted">{t('approvals.belongTask', { goal: item.goal })}</p>
          )}
          {item.kind === 'node' && (
            <>
              <pre className="text-xs text-fg-muted glass border border-glass-border rounded-lg p-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words">{t('approvals.currentParams')}{JSON.stringify(item.input ?? {}, null, 2)}</pre>
              <textarea
                value={edits[item.approvalId] ?? ''}
                onChange={e => setEdits(prev => ({ ...prev, [item.approvalId]: e.target.value }))}
                placeholder={t('approvals.editParamsPlaceholder')}
                spellCheck={false}
                className="w-full h-20 glass border border-glass-border rounded-lg p-2 font-mono text-xs text-fg-primary outline-none focus:border-brand/40 resize-none"
              />
            </>
          )}
          <div className="flex gap-2">
            <button onClick={() => decide(item.runId, item.approvalId, true)}
              className="px-3 py-1.5 rounded-lg bg-status-success/90 text-white text-xs cursor-pointer hover:bg-status-success flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> {t('approvals.approve')}{item.kind === 'node' ? t('approvals.andContinue') : ''}
            </button>
            <button onClick={() => decide(item.runId, item.approvalId, false)}
              className="px-3 py-1.5 rounded-lg bg-status-danger/90 text-white text-xs cursor-pointer hover:bg-status-danger flex items-center gap-1">
              <XCircle className="w-3.5 h-3.5" /> {t('approvals.deny')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
