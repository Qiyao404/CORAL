import { useEffect, useState } from 'react';
import { Building2, Tag as TagIcon, Plus, X, Save, RefreshCw, AlertTriangle, Cpu, Sun, Moon, Monitor, Palette, Brain, FileText, FolderOpen, User, Type, Languages } from 'lucide-react';
import { api } from '../api/client';
import { Card, Button, Input, Textarea, Tag, Select, Skeleton } from '../components/ui';
import { useTheme, type ThemeMode } from '../contexts/ThemeContext';
import { useI18n, LANGS, type Lang } from '../i18n';

interface LlmProfile {
  profileId: string;
  name: string;
  provider: 'openai-compat' | 'anthropic';
  baseUrl: string;
  model: string;
  isActive: boolean;
  apiKeyMasked: string;
  hasApiKey: boolean;
}

interface ConfigState {
  port: number;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  llmProfileId?: string;
  llmProfileName?: string;
  demoMode: boolean;
  skillsDir: string;
  sandboxMode: string;
  maxConcurrentTasks: number;
  maxConcurrentAgentsPerTask: number;
}

interface CompanyProfile {
  version: number;
  companyName: string;
  industries: string[];
  coreBusinesses: string[];
  focusKeywords: string[];
  excludeKeywords: string[];
  policyTypes: { keep: string[]; exclude: string[] };
  description: string;
  updatedAt: string;
}

export default function SettingsPage() {
  const { t, lang, setLang } = useI18n();
  const [config, setConfig] = useState<ConfigState | null>(null);
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');
  const [llmForm, setLlmForm] = useState({
    profileId: '', name: '', provider: 'openai-compat' as 'openai-compat' | 'anthropic', baseUrl: '', model: '', apiKey: '', setActive: true,
  });
  const [llmMessage, setLlmMessage] = useState('');
  const [profile, setProfile] = useState<Record<string, any> | null>(null);
  const [profileForm, setProfileForm] = useState<Record<string, any>>({});
  const [profileMessage, setProfileMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [fontScale, setFontScale] = useState(() => {
    if (typeof window === 'undefined') return 1;
    const saved = localStorage.getItem('coral.fontScale');
    if (saved) {
      document.documentElement.style.setProperty('--font-scale', saved);
      return parseFloat(saved);
    }
    return 1;
  });
  const [saving, setSaving] = useState(false);
  // 个性化（6 维度，默认全关）
  const [personalization, setPersonalization] = useState<{
    settings: { interestTags: boolean; styleAdaptive: boolean; rhythmAware: boolean; knowledgeGraph: boolean; proactive: boolean; implicitPrefs: boolean };
  }>({ settings: { interestTags: false, styleAdaptive: false, rhythmAware: false, knowledgeGraph: false, proactive: false, implicitPrefs: false } });
  // 运行预算（用户可调 — data/run-budget.json，对新 run 生效）
  const [runBudget, setRunBudget] = useState<{
    draftTokens: string; draftSteps: string;
    effectiveTokens: number; effectiveSteps: number;
    saving: boolean; saved: boolean; error: string;
  }>({ draftTokens: '', draftSteps: '', effectiveTokens: 1_000_000, effectiveSteps: 40, saving: false, saved: false, error: '' });
  const wan = (n: number) => lang === 'en'
    ? (n >= 1_000_000 && n % 1_000_000 === 0 ? `${n / 1_000_000}M` : String(n))
    : (n >= 10000 ? `${(n / 10000).toFixed(0)}万` : String(n));
  const saveRunBudget = async () => {
    setRunBudget(b => ({ ...b, saving: true, saved: false, error: '' }));
    try {
      const r = await api.saveRunBudget({
        maxTokens: runBudget.draftTokens.trim() === '' ? null : Number(runBudget.draftTokens),
        maxSteps: runBudget.draftSteps.trim() === '' ? null : Number(runBudget.draftSteps),
      });
      setRunBudget(b => ({
        ...b, saving: false, saved: true, error: '',
        effectiveTokens: r.effective?.maxTokens ?? b.effectiveTokens,
        effectiveSteps: r.effective?.maxSteps ?? b.effectiveSteps,
      }));
      setTimeout(() => setRunBudget(b => ({ ...b, saved: false })), 2500);
    } catch (err: any) {
      setRunBudget(b => ({ ...b, saving: false, error: err?.message ?? t('settings.common.saveFailed') }));
    }
  };
  // M1-10：工作区管理
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string; dir: string; permission: string }>>([]);
  const [activeWsId, setActiveWsId] = useState<string | null>(null);
  const [wsForm, setWsForm] = useState({ name: '', dir: '', permission: 'ask' });
  const [wsMessage, setWsMessage] = useState('');
  // 创新③：长期记忆
  const [memoryFiles, setMemoryFiles] = useState<Array<{ name: string; size: number; modifiedAt: string }>>([]);
  const [memoryName, setMemoryName] = useState('');
  const [memoryContent, setMemoryContent] = useState('');

  const loadAll = async () => {
    const [configRes, llmRes, profileRes] = await Promise.all([
      api.config(),
      api.listLlmConfigs(),
      api.getUserProfile(),
    ]);
    setConfig(configRes);
    const items: LlmProfile[] = llmRes.items || [];
    setProfiles(items);
    const active = items.find(p => p.profileId === llmRes.activeProfileId) || items[0];
    if (active) {
      setSelectedProfileId(active.profileId);
      fillFormFromProfile(active);
    }
    setProfile(profileRes);
    setProfileForm(profileRes);
  };

  const loadMemory = async () => {
    try {
      const res = await api.listMemory();
      setMemoryFiles(res.items ?? []);
    } catch { /* 静默 */ }
  };
  const loadWorkspaces = async () => {
    try {
      const res = await api.listWorkspaces();
      setWorkspaces(res.items ?? []);
      setActiveWsId(res.activeId ?? null);
    } catch { /* 静默 */ }
  };
  const handleCreateWorkspace = async () => {
    setWsMessage('');
    try {
      await api.createWorkspace({ name: wsForm.name, dir: wsForm.dir, permission: wsForm.permission });
      setWsForm({ name: '', dir: '', permission: 'ask' });
      await loadWorkspaces();
      setWsMessage(t('settings.ws.created'));
    } catch (err: any) { setWsMessage(err.message); }
  };
  const handleActivateWorkspace = async (id: string) => {
    try { await api.activateWorkspace(id); await loadWorkspaces(); } catch (err: any) { setWsMessage(err.message); }
  };
  const handleDeleteWorkspace = async (id: string) => {
    if (!confirm(t('settings.ws.deleteConfirm'))) return;
    try { await api.deleteWorkspace(id); await loadWorkspaces(); } catch (err: any) { setWsMessage(err.message); }
  };

  const openMemoryFile = async (name: string) => {
    try {
      const r = await api.getMemory(name);
      setMemoryName(name);
      setMemoryContent(r.content ?? '');
    } catch (err: any) { alert(err.message); }
  };
  const saveMemoryFile = async () => {
    if (!memoryName) return;
    try {
      await api.saveMemory(memoryName, memoryContent);
      setMemoryFiles((await api.listMemory()).items ?? []);
      alert(t('settings.memory.saved'));
    } catch (err: any) { alert(err.message); }
  };
  const deleteMemoryFile = async (name: string) => {
    if (!confirm(t('settings.memory.deleteConfirm', { name }))) return;
    try { await api.deleteMemory(name); if (memoryName === name) { setMemoryName(''); setMemoryContent(''); } setMemoryFiles((await api.listMemory()).items ?? []); }
    catch (err: any) { alert(err.message); }
  };

  useEffect(() => {
    loadAll().catch(() => {}).finally(() => setLoading(false));
    loadMemory();
    loadWorkspaces();
    // 运行预算初值（草稿框留空 = 显示占位的"默认"）
    api.getRunBudget().then(r => {
      setRunBudget(b => ({
        ...b,
        draftTokens: r.maxTokens != null ? String(r.maxTokens) : '',
        draftSteps: r.maxSteps != null ? String(r.maxSteps) : '',
        effectiveTokens: r.effective?.maxTokens ?? b.effectiveTokens,
        effectiveSteps: r.effective?.maxSteps ?? b.effectiveSteps,
      }));
    }).catch(() => {});
    // 个性化设置初值
    api.getPersonalization().then(r => {
      if (r?.settings) setPersonalization(p => ({ ...p, settings: r.settings }));
    }).catch(() => {});
  }, []);

  const fillFormFromProfile = (p: LlmProfile) => {
    setLlmForm({ profileId: p.profileId, name: p.name, provider: p.provider ?? 'openai-compat', baseUrl: p.baseUrl, model: p.model, apiKey: '', setActive: p.isActive });
  };

  const handleSelectProfile = (id: string) => {
    setSelectedProfileId(id);
    const p = profiles.find(x => x.profileId === id);
    if (p) { fillFormFromProfile(p); setLlmMessage(''); }
  };

  const handleNewProfile = () => {
    setSelectedProfileId('');
    setLlmForm({
      profileId: '', name: '', provider: 'openai-compat', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', model: 'kimi-k2.5', apiKey: '', setActive: true,
    });
    setLlmMessage(t('settings.llm.switchedToNew'));
  };

  const handleSaveLlm = async () => {
    if (!llmForm.name.trim() || !llmForm.baseUrl.trim() || !llmForm.model.trim()) {
      setLlmMessage(t('settings.llm.required'));
      return;
    }
    setSaving(true); setLlmMessage('');
    try {
      const res = await api.saveLlmConfig({
        profileId: llmForm.profileId || undefined,
        name: llmForm.name.trim(),
        provider: llmForm.provider,
        baseUrl: llmForm.baseUrl.trim(),
        model: llmForm.model.trim(),
        apiKey: llmForm.apiKey.trim() || undefined,
        setActive: llmForm.setActive,
      });
      setProfiles(res.items || []);
      const active = (res.items || []).find((p: LlmProfile) => p.profileId === res.activeProfileId);
      if (active) { setSelectedProfileId(active.profileId); fillFormFromProfile(active); }
      setConfig(await api.config());
      setLlmMessage(t('settings.llm.saved'));
    } catch (err: any) {
      setLlmMessage(err.message || t('settings.common.saveFailed'));
    } finally { setSaving(false); }
  };

  const handleActivateLlm = async () => {
    if (!llmForm.profileId) return setLlmMessage(t('settings.llm.saveFirst'));
    setSaving(true);
    try {
      const res = await api.activateLlmConfig(llmForm.profileId);
      setProfiles(res.items || []);
      setConfig(await api.config());
      setLlmMessage(t('settings.llm.activated'));
    } catch (err: any) { setLlmMessage(err.message); } finally { setSaving(false); }
  };

  const handleDeleteLlm = async () => {
    if (!llmForm.profileId) return setLlmMessage(t('settings.llm.nothingToDelete'));
    setSaving(true);
    try {
      const res = await api.deleteLlmConfig(llmForm.profileId);
      setProfiles(res.items || []);
      const next = (res.items || [])[0];
      if (next) { setSelectedProfileId(next.profileId); fillFormFromProfile(next); }
      else handleNewProfile();
      setConfig(await api.config());
      setLlmMessage(t('settings.llm.deleted'));
    } catch (err: any) { setLlmMessage(err.message); } finally { setSaving(false); }
  };

  const handleSaveProfile = async () => {
    if (!profileForm.name) return setProfileMessage(t('settings.profile.nameRequired'));
    setSaving(true); setProfileMessage('');
    try {
      const res = await api.putUserProfile(profileForm);
      setProfile(res);
      setProfileForm(res);
      setProfileMessage(t('settings.profile.saved', { version: res.version }));
    } catch (err: any) { setProfileMessage(err.message); } finally { setSaving(false); }
  };

  const handleResetProfile = async () => {
    if (!confirm(t('settings.profile.resetConfirm'))) return;
    setSaving(true);
    try {
      const res = await api.resetUserProfile();
      setProfile(res); setProfileForm(res);
      setProfileMessage(t('settings.profile.resetDone'));
    } catch (err: any) { setProfileMessage(err.message); } finally { setSaving(false); }
  };

  if (loading) return <div className="p-8"><Skeleton height="h-8" width="w-48" className="mb-6" /><Skeleton height="h-64" /></div>;

  const personalizationItems = [
    { key: 'interestTags', label: t('settings.personalization.interestTags.label'), desc: t('settings.personalization.interestTags.desc') },
    { key: 'styleAdaptive', label: t('settings.personalization.styleAdaptive.label'), desc: t('settings.personalization.styleAdaptive.desc') },
    { key: 'rhythmAware', label: t('settings.personalization.rhythmAware.label'), desc: t('settings.personalization.rhythmAware.desc') },
    { key: 'knowledgeGraph', label: t('settings.personalization.knowledgeGraph.label'), desc: t('settings.personalization.knowledgeGraph.desc') },
    { key: 'proactive', label: t('settings.personalization.proactive.label'), desc: t('settings.personalization.proactive.desc') },
    { key: 'implicitPrefs', label: t('settings.personalization.implicitPrefs.label'), desc: t('settings.personalization.implicitPrefs.desc') },
  ];

  return (
    <div className="p-8 max-w-4xl mx-auto animate-fade-in-up">
      <div className="mb-6">
        <h1 className="text-2xl font-heading font-bold text-fg-primary">{t('settings.title')}</h1>
        <p className="text-fg-muted mt-1">{t('settings.subtitle')}</p>
      </div>

      {config?.demoMode && (
        <div className="mb-6 p-4 glass border border-status-warn/30 rounded-xl flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-status-warn mt-0.5" />
          <p className="text-status-warn text-sm font-medium">
            {t('settings.demoMode')}
          </p>
        </div>
      )}


      {/* 字体大小调节 */}
      <Card className="mb-6">
        <h2 className="font-heading font-semibold text-fg-primary mb-4 flex items-center gap-2">
          <Type className="w-5 h-5" /> {t('settings.font.title')}
        </h2>
        <div className="flex items-center gap-4">
          <input
            type="range"
            min="0.85"
            max="1.3"
            step="0.05"
            value={typeof window !== 'undefined' ? document.documentElement.style.getPropertyValue('--font-scale') || '1' : '1'}
            onChange={(e) => {
              const val = e.target.value;
              document.documentElement.style.setProperty('--font-scale', val);
              localStorage.setItem('coral.fontScale', val);
              setFontScale(parseFloat(val));
            }}
            className="flex-1 accent-[rgb(var(--brand))]"
          />
          <span className="text-sm text-fg-secondary w-16 text-right">
            {Math.round(fontScale * 100)}%
          </span>
        </div>
        <p className="text-xs text-fg-muted mt-2">{t('settings.font.desc')}</p>
      </Card>

      {/* 界面语言 */}
      <Card className="mb-6">
        <h2 className="font-heading font-semibold text-fg-primary mb-4 flex items-center gap-2">
          <Languages className="w-5 h-5" /> {t('settings.lang.title')}
        </h2>
        <p className="text-xs text-fg-muted mb-4">{t('settings.lang.desc')}</p>
        <div className="flex gap-3">
          {LANGS.map(l => (
            <button
              key={l.id}
              type="button"
              onClick={() => setLang(l.id as Lang)}
              className={`px-4 py-2 rounded-lg border text-sm cursor-pointer transition-colors ${
                lang === l.id
                  ? 'border-brand bg-brand-soft text-brand font-medium'
                  : 'border-glass-border text-fg-secondary hover:border-glass-borderStrong hover:text-fg-primary'
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </Card>

      {/* 个性化（6 维度"越用越懂你"，默认全关） */}
      <Card className="mb-6">
        <h2 className="font-heading font-semibold text-fg-primary mb-4 flex items-center gap-2">
          <Brain className="w-5 h-5" /> {t('settings.personalization.title')}
        </h2>
        <p className="text-xs text-fg-muted mb-4">{t('settings.personalization.desc')}</p>
        <div className="space-y-3">
          {personalizationItems.map(item => (
            <div key={item.key} className="flex items-start justify-between gap-4 p-3 rounded-lg border border-glass-border/50 hover:border-brand/20 transition-colors">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-fg-primary font-medium">{item.label}</p>
                <p className="text-xs text-fg-muted mt-0.5">{item.desc}</p>
              </div>
              <button
                onClick={() => {
                  const next = !personalization.settings[item.key as keyof typeof personalization.settings];
                  setPersonalization(p => ({ ...p, settings: { ...p.settings, [item.key]: next } }));
                  api.savePersonalization({ [item.key]: next }).catch(() => {});
                }}
                className={`shrink-0 w-10 h-5 rounded-full transition-colors relative ${personalization.settings[item.key as keyof typeof personalization.settings] ? 'bg-brand' : 'bg-fg-disabled/30'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${personalization.settings[item.key as keyof typeof personalization.settings] ? 'left-5' : 'left-0.5'}`} />
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 mt-4">
          <Button variant="ghost" onClick={() => { api.resetPersonalization().catch(() => {}); }}>{t('settings.personalization.reset')}</Button>
          <span className="text-xs text-fg-muted">{t('settings.personalization.resetDesc')}</span>
        </div>
      </Card>

      {/* 运行预算（用户可调 — 每个 run 的 token/步数上限） */}
      <Card className="mb-6">
        <h2 className="font-heading font-semibold text-fg-primary mb-4 flex items-center gap-2">
          <Cpu className="w-5 h-5" /> {t('settings.budget.title')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-fg-muted mb-1 block">{t('settings.budget.tokenLabel')}</label>
            <Input
              type="number"
              value={runBudget.draftTokens}
              disabled={runBudget.saving}
              onChange={e => setRunBudget(b => ({ ...b, draftTokens: e.target.value }))}
              placeholder={t('settings.budget.defaultPlaceholder', { v: wan(runBudget.effectiveTokens) })}
            />
            <p className="text-[11px] text-fg-muted mt-1">{t('settings.budget.tokenHint')}</p>
          </div>
          <div>
            <label className="text-xs text-fg-muted mb-1 block">{t('settings.budget.stepLabel')}</label>
            <Input
              type="number"
              value={runBudget.draftSteps}
              disabled={runBudget.saving}
              onChange={e => setRunBudget(b => ({ ...b, draftSteps: e.target.value }))}
              placeholder={t('settings.budget.defaultPlaceholder', { v: runBudget.effectiveSteps })}
            />
            <p className="text-[11px] text-fg-muted mt-1">{t('settings.budget.stepHint')}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 mt-3">
          <Button onClick={saveRunBudget} disabled={runBudget.saving}>
            {runBudget.saving ? t('settings.budget.saving') : t('settings.budget.save')}
          </Button>
          {runBudget.saved && <span className="text-xs text-status-success">{t('settings.budget.saved')}</span>}
          {runBudget.error && <span className="text-xs text-status-danger">{runBudget.error}</span>}
          <span className="text-xs text-fg-muted ml-auto">
            {t('settings.budget.current', { tokens: wan(runBudget.effectiveTokens), steps: runBudget.effectiveSteps })}
          </span>
        </div>
        <p className="text-xs text-fg-muted mt-2">{t('settings.budget.desc')}</p>
      </Card>

      <ThemeSettingsCard />

      <Card className="mb-6">
        <h2 className="font-heading font-semibold text-fg-primary mb-4 flex items-center gap-2">
          <Cpu className="w-5 h-5" /> {t('settings.llm.title')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-xs text-fg-muted mb-1">{t('settings.llm.savedProfiles')}</label>
            <Select value={selectedProfileId} onChange={e => handleSelectProfile(e.target.value)}>
              {profiles.map(p => (
                <option key={p.profileId} value={p.profileId}>
                  {p.name} {p.isActive ? t('settings.llm.activeSuffix') : ''}
                </option>
              ))}
            </Select>
          </div>
          <ConfigItem label={t('settings.llm.demoMode')} value={config?.demoMode ? t('settings.llm.demoOn') : t('settings.llm.demoOff')} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-fg-muted mb-1">{t('settings.llm.name')}</label>
            <Input value={llmForm.name} onChange={e => setLlmForm(p => ({ ...p, name: e.target.value }))} placeholder="DashScope Coding · kimi-k2.5" />
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-1">{t('settings.llm.provider')}</label>
            <Select value={llmForm.provider} onChange={e => setLlmForm(p => ({
              ...p,
              provider: e.target.value as 'openai-compat' | 'anthropic',
              baseUrl: e.target.value === 'anthropic' && (p.baseUrl === '' || p.baseUrl.includes('dashscope') || p.baseUrl.includes('siliconflow'))
                ? 'https://api.anthropic.com' : p.baseUrl,
              model: e.target.value === 'anthropic' && (p.model === '' || p.model === 'kimi-k2.5') ? 'claude-sonnet-4-5' : p.model,
            }))}>
              <option value="openai-compat">{t('settings.llm.providerOpenai')}</option>
              <option value="anthropic">{t('settings.llm.providerAnthropic')}</option>
            </Select>
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-1">{t('settings.llm.model')}</label>
            <Input value={llmForm.model} onChange={e => setLlmForm(p => ({ ...p, model: e.target.value }))} placeholder="kimi-k2.5" />
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-1">{t('settings.llm.baseUrl')}</label>
            <Input value={llmForm.baseUrl} onChange={e => setLlmForm(p => ({ ...p, baseUrl: e.target.value }))} placeholder={llmForm.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://coding.dashscope.aliyuncs.com/v1'} />
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-1">{t('settings.llm.apiKey')}</label>
            <Input
              type="password"
              value={llmForm.apiKey}
              onChange={e => setLlmForm(p => ({ ...p, apiKey: e.target.value }))}
              placeholder={profiles.find(p => p.profileId === llmForm.profileId)?.apiKeyMasked || 'sk-...'}
            />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-4">
          <label className="text-sm text-fg-muted flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={llmForm.setActive}
              onChange={e => setLlmForm(p => ({ ...p, setActive: e.target.checked }))}
              className="accent-brand"
            />
            {t('settings.llm.setActiveOnSave')}
          </label>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={handleNewProfile}>{t('settings.llm.new')}</Button>
          <Button loading={saving} onClick={handleSaveLlm} icon={<Save className="w-4 h-4" />}>{t('settings.llm.save')}</Button>
          <Button variant="ghost" disabled={!llmForm.profileId} onClick={handleActivateLlm}>{t('settings.llm.activate')}</Button>
          <Button variant="danger" disabled={!llmForm.profileId} onClick={handleDeleteLlm}>{t('settings.llm.delete')}</Button>
        </div>
        {llmMessage && <p className="mt-3 text-sm text-fg-muted">{llmMessage}</p>}
      </Card>

      <Card className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-heading font-semibold text-fg-primary flex items-center gap-2">
            <User className="w-5 h-5" /> {t('settings.profile.title')}
          </h2>
          {profile && <Tag variant="info">v{profile.version}</Tag>}
        </div>
        <p className="text-xs text-fg-muted mb-4 -mt-2">{t('settings.profile.desc')}</p>
        <div className="flex items-center justify-between mb-4">
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-fg-muted mb-1">{t('settings.profile.name')}</label>
            <Input
              value={profileForm.name || ''}
              onChange={e => setProfileForm(p => ({ ...p, name: e.target.value }))}
              placeholder={t('settings.profile.namePlaceholder')}
            />
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-1">{t('settings.profile.role')}</label>
            <Input
              value={profileForm.role || ''}
              onChange={e => setProfileForm(p => ({ ...p, role: e.target.value }))}
              placeholder={t('settings.profile.rolePlaceholder')}
            />
          </div>

          <KeywordInput
            label={t('settings.profile.interests')}
            values={profileForm.interests || []}
            onChange={v => setProfileForm(p => ({ ...p, interests: v }))}
          />
          <KeywordInput
            label={t('settings.profile.expertise')}
            values={profileForm.expertise || []}
            onChange={v => setProfileForm(p => ({ ...p, expertise: v }))}
          />
          <KeywordInput
            label={t('settings.profile.likes')}
            values={profileForm.preferences?.likeKeywords || []}
            onChange={v => setProfileForm(p => ({ ...p, preferences: { ...(p.preferences || {}), likeKeywords: v } }))}
          />
          <KeywordInput
            label={t('settings.profile.dislikes')}
            values={profileForm.preferences?.avoidKeywords || []}
            onChange={v => setProfileForm(p => ({ ...p, preferences: { ...(p.preferences || {}), avoidKeywords: v } }))}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-fg-muted mb-1">{t('settings.profile.outputFormat')}</label>
              <Input
                value={profileForm.workStyle?.outputFormat || ''}
                onChange={e => setProfileForm(p => ({ ...p, workStyle: { ...(p.workStyle || { outputFormat: '', language: '', detailLevel: '', tone: '' }), outputFormat: e.target.value } }))}
                placeholder={t('settings.profile.outputFormatPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-xs text-fg-muted mb-1">{t('settings.profile.language')}</label>
              <Input
                value={profileForm.workStyle?.language || ''}
                onChange={e => setProfileForm(p => ({ ...p, workStyle: { ...(p.workStyle || { outputFormat: '', language: '', detailLevel: '', tone: '' }), language: e.target.value } }))}
                placeholder={t('settings.profile.languagePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-xs text-fg-muted mb-1">{t('settings.profile.detailLevel')}</label>
              <Input
                value={profileForm.workStyle?.detailLevel || ''}
                onChange={e => setProfileForm(p => ({ ...p, workStyle: { ...(p.workStyle || { outputFormat: '', language: '', detailLevel: '', tone: '' }), detailLevel: e.target.value } }))}
                placeholder={t('settings.profile.detailLevelPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-xs text-fg-muted mb-1">{t('settings.profile.tone')}</label>
              <Input
                value={profileForm.workStyle?.tone || ''}
                onChange={e => setProfileForm(p => ({ ...p, workStyle: { ...(p.workStyle || { outputFormat: '', language: '', detailLevel: '', tone: '' }), tone: e.target.value } }))}
                placeholder={t('settings.profile.tonePlaceholder')}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-1">{t('settings.profile.background')}</label>
            <Textarea
              rows={3}
              value={profileForm.background || ''}
              onChange={e => setProfileForm(p => ({ ...p, background: e.target.value }))}
            />
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            <Button loading={saving} onClick={handleSaveProfile} icon={<Save className="w-4 h-4" />}>{t('settings.profile.save', { version: (profile?.version || 0) + 1 })}</Button>
            <Button variant="secondary" onClick={handleResetProfile} icon={<RefreshCw className="w-4 h-4" />}>{t('settings.profile.reset')}</Button>
          </div>
          {profileMessage && <p className="text-sm text-fg-muted">{profileMessage}</p>}
        </div>
      </Card>

      <Card className="mb-6">
        <h2 className="font-heading font-semibold text-fg-primary mb-1 flex items-center gap-2">
          <FolderOpen className="w-5 h-5" /> {t('settings.ws.title')}
        </h2>
        <p className="text-xs text-fg-muted mb-4">
          {t('settings.ws.desc')}
        </p>

        {workspaces.length > 0 && (
          <div className="space-y-1.5 mb-4">
            {workspaces.map(w => (
              <div key={w.id} className={`flex items-center gap-2 p-2.5 rounded-lg border text-xs ${activeWsId === w.id ? 'border-brand/40 bg-brand-soft' : 'border-glass-border bg-bg-panel/40'}`}>
                <FolderOpen className="w-4 h-4 text-brand shrink-0" />
                <span className="font-medium text-fg-primary">{w.name}</span>
                <code className="text-fg-muted truncate flex-1">{w.dir}</code>
                <Tag variant={w.permission === 'readonly' ? 'default' : w.permission === 'auto' ? 'warn' : 'info'}>{w.permission}</Tag>
                {activeWsId === w.id ? <Tag variant="success">{t('settings.ws.current')}</Tag>
                  : <Button size="sm" variant="ghost" onClick={() => handleActivateWorkspace(w.id)}>{t('settings.ws.setCurrent')}</Button>}
                <button className="text-fg-disabled hover:text-status-danger cursor-pointer" onClick={() => handleDeleteWorkspace(w.id)}><X className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <div>
            <label className="block text-xs text-fg-muted mb-1">{t('settings.ws.name')}</label>
            <Input value={wsForm.name} onChange={e => setWsForm(f => ({ ...f, name: e.target.value }))} placeholder={t('settings.ws.namePlaceholder')} />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs text-fg-muted mb-1">{t('settings.ws.dir')}</label>
            <Input value={wsForm.dir} onChange={e => setWsForm(f => ({ ...f, dir: e.target.value }))} placeholder="D:\\projects\\my-notes" />
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-1">{t('settings.ws.permission')}</label>
            <Select value={wsForm.permission} onChange={e => setWsForm(f => ({ ...f, permission: e.target.value }))}>
              <option value="ask">{t('settings.ws.permAsk')}</option>
              <option value="readonly">{t('settings.ws.permReadonly')}</option>
              <option value="auto">{t('settings.ws.permAuto')}</option>
            </Select>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button onClick={handleCreateWorkspace} icon={<Plus className="w-4 h-4" />}>{t('settings.ws.create')}</Button>
          {wsMessage && <p className="text-xs text-fg-muted">{wsMessage}</p>}
        </div>
      </Card>

      <Card className="mb-6">
        <h2 className="font-heading font-semibold text-fg-primary mb-1 flex items-center gap-2">
          <Brain className="w-5 h-5" /> {t('settings.memory.title')}
        </h2>
        <p className="text-xs text-fg-muted mb-4">
          {t('settings.memory.desc')}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1.5 md:col-span-1">
            {memoryFiles.length === 0 && <p className="text-xs text-fg-muted">{t('settings.memory.empty')}</p>}
            {memoryFiles.map(f => (
              <div key={f.name} className={`flex items-center gap-1 p-2 rounded-lg cursor-pointer text-xs ${memoryName === f.name ? 'bg-brand-soft text-brand' : 'hover:bg-bg-elev/40 text-fg-secondary'}`} onClick={() => openMemoryFile(f.name)}>
                <FileText className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate flex-1">{f.name}</span>
                <button className="text-fg-disabled hover:text-status-danger" onClick={e => { e.stopPropagation(); deleteMemoryFile(f.name); }}>×</button>
              </div>
            ))}
          </div>
          <div className="md:col-span-2 space-y-2">
            <div className="flex gap-2 items-center">
              <input value={memoryName} onChange={e => setMemoryName(e.target.value)} placeholder={t('settings.memory.filePlaceholder')}
                className="flex-1 bg-bg-panel/50 border border-glass-border rounded-lg px-3 py-1.5 text-xs font-mono text-fg-primary" />
              <Button size="sm" onClick={saveMemoryFile} icon={<Save className="w-3.5 h-3.5" />}>{t('settings.memory.save')}</Button>
            </div>
            <textarea value={memoryContent} onChange={e => setMemoryContent(e.target.value)} rows={10}
              placeholder={t('settings.memory.contentPlaceholder')}
              className="w-full bg-bg-panel/50 border border-glass-border rounded-lg p-3 text-xs font-mono text-fg-primary font-mono" />
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="font-heading font-semibold text-fg-primary mb-4">{t('settings.platform.title')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ConfigItem label={t('settings.platform.port')} value={config?.port} />
          <ConfigItem label={t('settings.platform.skillsDir')} value={config?.skillsDir} />
          <ConfigItem label={t('settings.platform.sandbox')} value={config?.sandboxMode} />
          <ConfigItem label={t('settings.platform.maxTasks')} value={config?.maxConcurrentTasks} />
          <ConfigItem label={t('settings.platform.maxAgents')} value={config?.maxConcurrentAgentsPerTask} />
          <ConfigItem label={t('settings.platform.version')} value="CORAL v2.2.0" />
        </div>
      </Card>
    </div>
  );
}

function ThemeSettingsCard() {
  const { mode, effective, setMode } = useTheme();
  const { t } = useI18n();

  const options: Array<{ value: ThemeMode; label: string; desc: string; icon: any }> = [
    { value: 'light', label: t('settings.theme.light'), desc: t('settings.theme.lightDesc'), icon: Sun },
    { value: 'dark', label: t('settings.theme.dark'), desc: t('settings.theme.darkDesc'), icon: Moon },
    { value: 'system', label: t('settings.theme.system'), desc: t('settings.theme.systemDesc'), icon: Monitor },
  ];

  return (
    <Card className="mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-heading font-semibold text-fg-primary flex items-center gap-2">
          <Palette className="w-5 h-5" /> {t('settings.theme.title')}
        </h2>
        <Tag variant={effective === 'dark' ? 'info' : 'success'}>
          {t('settings.theme.current', { mode: effective === 'dark' ? t('settings.theme.dark') : t('settings.theme.light') })}
        </Tag>
      </div>
      <p className="text-sm text-fg-muted mb-4">
        {t('settings.theme.desc')}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {options.map(opt => {
          const Icon = opt.icon;
          const active = mode === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setMode(opt.value)}
              className={`text-left p-4 rounded-xl border transition-all cursor-pointer ${
                active
                  ? 'border-brand bg-brand-soft shadow-glass'
                  : 'border-glass-border bg-bg-panel/40 hover:bg-bg-elev/40 hover:border-glass-borderStrong'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <Icon className={`w-4 h-4 ${active ? 'text-brand' : 'text-fg-secondary'}`} />
                <span className={`font-semibold text-sm ${active ? 'text-brand' : 'text-fg-primary'}`}>
                  {opt.label}
                </span>
                {active && <Tag variant="brand">{t('settings.theme.chosen')}</Tag>}
              </div>
              <p className="text-xs text-fg-muted">{opt.desc}</p>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function ConfigItem({ label, value }: { label: string; value: any }) {
  return (
    <div>
      <label className="block text-xs text-fg-muted mb-1">{label}</label>
      <p className="text-sm text-fg-primary font-mono bg-bg-panel/50 px-3 py-2 rounded-lg border border-glass-border">
        {value ?? '-'}
      </p>
    </div>
  );
}

function KeywordInput({ label, values, onChange }: { label: string; values: string[]; onChange: (v: string[]) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const add = () => {
    const items = draft.split(/[,;\s\n]+/).map(s => s.trim()).filter(Boolean);
    if (!items.length) return;
    onChange([...new Set([...values, ...items])]);
    setDraft('');
  };
  return (
    <div>
      <label className="block text-xs text-fg-muted mb-1 flex items-center gap-1"><TagIcon className="w-3 h-3" /> {label}</label>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {values.map((v, i) => (
          <span key={`${v}-${i}`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-bg-elev/60 text-fg-secondary border border-glass-border">
            {v}
            <button
              className="text-fg-muted hover:text-status-danger cursor-pointer"
              onClick={() => onChange(values.filter((_, j) => j !== i))}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder={t('settings.keyword.placeholder')}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        />
        <Button variant="secondary" onClick={add} icon={<Plus className="w-3 h-3" />}>{t('settings.keyword.add')}</Button>
      </div>
    </div>
  );
}
