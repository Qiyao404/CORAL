import { useEffect, useState } from 'react';
import { Sparkles, Check, X, FileDiff, UserPlus, GitBranch } from 'lucide-react';
import { api } from '../api/client';
import { Card, Button, Tag } from './ui';
import { useI18n } from '../i18n';

/**
 * 演化提议卡（自进化闭环的人审面）：
 * 运行后蒸馏管线产出的提议——技能修订 / 新技能草案 / 画像增补。
 * 只展示不代决：接受才落盘（技能旧版备份 .history/，热加载），拒绝归档。
 */

type Kind = 'skill_revision' | 'skill_new' | 'profile_update';

interface Proposal {
  id: string;
  kind: Kind;
  runId: string;
  skillName?: string;
  rationale: string;
  content: unknown;
  status: string;
  createdAt: string;
}

const KIND_ICON: Record<Kind, typeof GitBranch> = {
  skill_revision: FileDiff,
  skill_new: GitBranch,
  profile_update: UserPlus,
};

export function EvolutionProposals({ kinds }: { kinds: Kind[] }) {
  const { t } = useI18n();
  const [items, setItems] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.getEvolutionProposals('pending');
      setItems((r.items ?? []).filter(p => kinds.includes(p.kind)));
    } catch { /* 静默 */ }
  };
  useEffect(() => { load(); }, []);

  const decide = async (id: string, accept: boolean) => {
    setBusy(id);
    setMessage('');
    try {
      const r = await api.decideEvolutionProposal(id, accept);
      setMessage(r.message ?? '');
      await load();
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setBusy(null);
    }
  };

  if (items.length === 0) return null;

  return (
    <Card className="mb-6 border-brand/30">
      <h3 className="font-heading font-semibold text-fg-primary mb-1 flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-brand" /> {t('evo.title')}
        <Tag variant="brand">{items.length}</Tag>
      </h3>
      <p className="text-xs text-fg-muted mb-3">{t('evo.subtitle')}</p>
      {message && <p className="text-xs text-status-success mb-2">{message}</p>}
      <div className="space-y-2">
        {items.map(p => {
          const Icon = KIND_ICON[p.kind] ?? Sparkles;
          const body = p.kind === 'profile_update'
            ? Array.isArray(p.content) ? (p.content as Array<any>).map(i => `${i.field}: ${i.value}`).join('\n') : ''
            : String(p.content ?? '');
          return (
            <div key={p.id} className="p-3 rounded-lg border border-glass-border bg-bg-panel/40">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Icon className="w-3.5 h-3.5 text-brand shrink-0" />
                    <span className="text-sm font-medium text-fg-primary">
                      {p.kind === 'profile_update' ? t('evo.kindProfile') : `${t(p.kind === 'skill_revision' ? 'evo.kindRevision' : 'evo.kindNew')}${p.skillName ? ` · ${p.skillName}` : ''}`}
                    </span>
                    <span className="text-[11px] text-fg-disabled">{new Date(p.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="text-xs text-fg-secondary">{p.rationale}</p>
                  {p.kind !== 'profile_update' && (
                    <button
                      type="button"
                      className="text-[11px] text-brand hover:underline cursor-pointer mt-1"
                      onClick={() => setExpanded(expanded === p.id ? null : p.id)}
                    >
                      {expanded === p.id ? t('evo.collapse') : t('evo.expand')}
                    </button>
                  )}
                  {expanded === p.id && (
                    <pre className="mt-2 text-[11px] font-mono bg-bg-panel/70 border border-glass-border rounded-lg p-2.5 max-h-64 overflow-auto whitespace-pre-wrap">{body}</pre>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button size="sm" disabled={busy === p.id} onClick={() => decide(p.id, true)} icon={<Check className="w-3.5 h-3.5" />}>
                    {t('evo.accept')}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => decide(p.id, false)} icon={<X className="w-3.5 h-3.5" />}>
                    {t('evo.reject')}
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
