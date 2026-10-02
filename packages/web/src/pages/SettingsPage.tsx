import { useEffect, useState } from 'react';
import { Building2, Tag as TagIcon, Plus, X, Save, RefreshCw, AlertTriangle, Cpu, Sun, Moon, Monitor, Palette, Brain, FileText, FolderOpen } from 'lucide-react';
import { api } from '../api/client';
import { Card, Button, Input, Textarea, Tag, Select, Skeleton } from '../components/ui';
import { useTheme, type ThemeMode } from '../contexts/ThemeContext';

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
  const [config, setConfig] = useState<ConfigState | null>(null);
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');
  const [llmForm, setLlmForm] = useState({
    profileId: '', name: '', provider: 'openai-compat' as 'openai-compat' | 'anthropic', baseUrl: '', model: '', apiKey: '', setActive: true,
  });
  const [llmMessage, setLlmMessage] = useState('');
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [profileForm, setProfileForm] = useState<Partial<CompanyProfile>>({});
  const [profileMessage, setProfileMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
      api.getCompanyProfile(),
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
      setWsMessage('工作区已创建');
    } catch (err: any) { setWsMessage(err.message); }
  };
  const handleActivateWorkspace = async (id: string) => {
    try { await api.activateWorkspace(id); await loadWorkspaces(); } catch (err: any) { setWsMessage(err.message); }
  };
  const handleDeleteWorkspace = async (id: string) => {
    if (!confirm('删除该工作区？（只解除绑定，不会删除磁盘上的文件夹）')) return;
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
      alert('记忆已保存 — agent 下次任务即可使用');
    } catch (err: any) { alert(err.message); }
  };
  const deleteMemoryFile = async (name: string) => {
    if (!confirm(`删除记忆 ${name}？agent 将不再记得该内容。`)) return;
    try { await api.deleteMemory(name); if (memoryName === name) { setMemoryName(''); setMemoryContent(''); } setMemoryFiles((await api.listMemory()).items ?? []); }
    catch (err: any) { alert(err.message); }
  };

  useEffect(() => {
    loadAll().catch(() => {}).finally(() => setLoading(false));
    loadMemory();
    loadWorkspaces();
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
    setLlmMessage('已切换为新建模式');
  };

  const handleSaveLlm = async () => {
    if (!llmForm.name.trim() || !llmForm.baseUrl.trim() || !llmForm.model.trim()) {
      setLlmMessage('名称、API URL、模型名称不能为空');
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
      setLlmMessage('配置已保存');
    } catch (err: any) {
      setLlmMessage(err.message || '保存失败');
    } finally { setSaving(false); }
  };

  const handleActivateLlm = async () => {
    if (!llmForm.profileId) return setLlmMessage('请先保存该配置');
    setSaving(true);
    try {
      const res = await api.activateLlmConfig(llmForm.profileId);
      setProfiles(res.items || []);
      setConfig(await api.config());
      setLlmMessage('已切换到该 LLM 配置');
    } catch (err: any) { setLlmMessage(err.message); } finally { setSaving(false); }
  };

  const handleDeleteLlm = async () => {
    if (!llmForm.profileId) return setLlmMessage('当前是新配置无需删除');
    setSaving(true);
    try {
      const res = await api.deleteLlmConfig(llmForm.profileId);
      setProfiles(res.items || []);
      const next = (res.items || [])[0];
      if (next) { setSelectedProfileId(next.profileId); fillFormFromProfile(next); }
      else handleNewProfile();
      setConfig(await api.config());
      setLlmMessage('已删除');
    } catch (err: any) { setLlmMessage(err.message); } finally { setSaving(false); }
  };

  const handleSaveProfile = async () => {
    if (!profileForm.companyName) return setProfileMessage('公司名称必填');
    setSaving(true); setProfileMessage('');
    try {
      const res = await api.putCompanyProfile(profileForm);
      setProfile(res);
      setProfileForm(res);
      setProfileMessage(`已保存（v${res.version}）`);
    } catch (err: any) { setProfileMessage(err.message); } finally { setSaving(false); }
  };

  const handleResetProfile = async () => {
    if (!confirm('恢复为默认画像？当前修改将被覆盖。')) return;
    setSaving(true);
    try {
      const res = await api.resetCompanyProfile();
      setProfile(res); setProfileForm(res);
      setProfileMessage('已恢复默认');
    } catch (err: any) { setProfileMessage(err.message); } finally { setSaving(false); }
  };

  if (loading) return <div className="p-8"><Skeleton height="h-8" width="w-48" className="mb-6" /><Skeleton height="h-64" /></div>;

  return (
    <div className="p-8 max-w-4xl mx-auto animate-fade-in-up">
      <div className="mb-6">
        <h1 className="text-2xl font-heading font-bold text-fg-primary">系统设置</h1>
        <p className="text-fg-muted mt-1">配置 LLM 模型、公司业务画像与平台参数</p>
      </div>

      {config?.demoMode && (
        <div className="mb-6 p-4 glass border border-status-warn/30 rounded-xl flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-status-warn mt-0.5" />
          <p className="text-status-warn text-sm font-medium">
            演示模式已启用（--demo 启动）— 所有 LLM 调用返回带 <code className="font-mono">mock: true</code> 标记的模拟数据
          </p>
        </div>
      )}

      <ThemeSettingsCard />

      <Card className="mb-6">
        <h2 className="font-heading font-semibold text-fg-primary mb-4 flex items-center gap-2">
          <Cpu className="w-5 h-5" /> LLM 配置管理
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-xs text-fg-muted mb-1">已保存配置</label>
            <Select value={selectedProfileId} onChange={e => handleSelectProfile(e.target.value)}>
              {profiles.map(p => (
                <option key={p.profileId} value={p.profileId}>
                  {p.name} {p.isActive ? '(当前生效)' : ''}
                </option>
              ))}
            </Select>
          </div>
          <ConfigItem label="演示模式" value={config?.demoMode ? '已启用（--demo）' : '未启用'} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-fg-muted mb-1">配置名称</label>
            <Input value={llmForm.name} onChange={e => setLlmForm(p => ({ ...p, name: e.target.value }))} placeholder="DashScope Coding · kimi-k2.5" />
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-1">接入协议（provider）</label>
            <Select value={llmForm.provider} onChange={e => setLlmForm(p => ({
              ...p,
              provider: e.target.value as 'openai-compat' | 'anthropic',
              baseUrl: e.target.value === 'anthropic' && (p.baseUrl === '' || p.baseUrl.includes('dashscope') || p.baseUrl.includes('siliconflow'))
                ? 'https://api.anthropic.com' : p.baseUrl,
              model: e.target.value === 'anthropic' && (p.model === '' || p.model === 'kimi-k2.5') ? 'claude-sonnet-4-5' : p.model,
            }))}>
              <option value="openai-compat">OpenAI 兼容端点（DashScope / DeepSeek / OpenRouter / Ollama…）</option>
              <option value="anthropic">Anthropic 原生（Claude）</option>
            </Select>
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-1">模型名称</label>
            <Input value={llmForm.model} onChange={e => setLlmForm(p => ({ ...p, model: e.target.value }))} placeholder="kimi-k2.5" />
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-1">API 基础 URL</label>
            <Input value={llmForm.baseUrl} onChange={e => setLlmForm(p => ({ ...p, baseUrl: e.target.value }))} placeholder={llmForm.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://coding.dashscope.aliyuncs.com/v1'} />
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-1">API Key（留空则保持原值）</label>
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
            保存后设为当前生效配置
          </label>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={handleNewProfile}>新建配置</Button>
          <Button loading={saving} onClick={handleSaveLlm} icon={<Save className="w-4 h-4" />}>保存配置</Button>
          <Button variant="ghost" disabled={!llmForm.profileId} onClick={handleActivateLlm}>设为生效</Button>
          <Button variant="danger" disabled={!llmForm.profileId} onClick={handleDeleteLlm}>删除</Button>
        </div>
        {llmMessage && <p className="mt-3 text-sm text-fg-muted">{llmMessage}</p>}
      </Card>

      <Card className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-heading font-semibold text-fg-primary flex items-center gap-2">
            <Building2 className="w-5 h-5" /> 公司业务画像
          </h2>
          {profile && <Tag variant="info">v{profile.version}</Tag>}
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-fg-muted mb-1">公司名称<span className="text-status-danger">*</span></label>
            <Input
              value={profileForm.companyName || ''}
              onChange={e => setProfileForm(p => ({ ...p, companyName: e.target.value }))}
              placeholder="例如：中试科技有限公司"
            />
          </div>

          <KeywordInput
            label="行业领域"
            values={profileForm.industries || []}
            onChange={v => setProfileForm(p => ({ ...p, industries: v }))}
          />
          <KeywordInput
            label="核心业务"
            values={profileForm.coreBusinesses || []}
            onChange={v => setProfileForm(p => ({ ...p, coreBusinesses: v }))}
          />
          <KeywordInput
            label="关注关键词（命中即保留）"
            values={profileForm.focusKeywords || []}
            onChange={v => setProfileForm(p => ({ ...p, focusKeywords: v }))}
          />
          <KeywordInput
            label="排除关键词（命中即剔除）"
            values={profileForm.excludeKeywords || []}
            onChange={v => setProfileForm(p => ({ ...p, excludeKeywords: v }))}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <KeywordInput
              label="保留政策类型"
              values={profileForm.policyTypes?.keep || []}
              onChange={v => setProfileForm(p => ({ ...p, policyTypes: { ...(p.policyTypes || { keep: [], exclude: [] }), keep: v } }))}
            />
            <KeywordInput
              label="剔除政策类型"
              values={profileForm.policyTypes?.exclude || []}
              onChange={v => setProfileForm(p => ({ ...p, policyTypes: { ...(p.policyTypes || { keep: [], exclude: [] }), exclude: v } }))}
            />
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-1">自由描述（150-500 字，给 LLM 的额外上下文）</label>
            <Textarea
              rows={3}
              value={profileForm.description || ''}
              onChange={e => setProfileForm(p => ({ ...p, description: e.target.value }))}
            />
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            <Button loading={saving} onClick={handleSaveProfile} icon={<Save className="w-4 h-4" />}>保存（生成 v{(profile?.version || 0) + 1}）</Button>
            <Button variant="secondary" onClick={handleResetProfile} icon={<RefreshCw className="w-4 h-4" />}>恢复默认</Button>
          </div>
          {profileMessage && <p className="text-sm text-fg-muted">{profileMessage}</p>}
        </div>
      </Card>

      <Card className="mb-6">
        <h2 className="font-heading font-semibold text-fg-primary mb-1 flex items-center gap-2">
          <FolderOpen className="w-5 h-5" /> 工作区（Agent 的本地文件夹权限）
        </h2>
        <p className="text-xs text-fg-muted mb-4">
          绑定本地文件夹后，Agent 才能读写其中的文件。权限档：只读 / 询问（写改弹 diff 批准，默认）/ 自动。Chat 页顶部可选择本次使用哪个工作区。
        </p>

        {workspaces.length > 0 && (
          <div className="space-y-1.5 mb-4">
            {workspaces.map(w => (
              <div key={w.id} className={`flex items-center gap-2 p-2.5 rounded-lg border text-xs ${activeWsId === w.id ? 'border-brand/40 bg-brand-soft' : 'border-glass-border bg-bg-panel/40'}`}>
                <FolderOpen className="w-4 h-4 text-brand shrink-0" />
                <span className="font-medium text-fg-primary">{w.name}</span>
                <code className="text-fg-muted truncate flex-1">{w.dir}</code>
                <Tag variant={w.permission === 'readonly' ? 'default' : w.permission === 'auto' ? 'warn' : 'info'}>{w.permission}</Tag>
                {activeWsId === w.id ? <Tag variant="success">当前</Tag>
                  : <Button size="sm" variant="ghost" onClick={() => handleActivateWorkspace(w.id)}>设为当前</Button>}
                <button className="text-fg-disabled hover:text-status-danger cursor-pointer" onClick={() => handleDeleteWorkspace(w.id)}><X className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <div>
            <label className="block text-xs text-fg-muted mb-1">名称</label>
            <Input value={wsForm.name} onChange={e => setWsForm(f => ({ ...f, name: e.target.value }))} placeholder="我的项目" />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs text-fg-muted mb-1">本地文件夹完整路径（须已存在）</label>
            <Input value={wsForm.dir} onChange={e => setWsForm(f => ({ ...f, dir: e.target.value }))} placeholder="D:\projects\my-notes" />
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-1">权限档</label>
            <Select value={wsForm.permission} onChange={e => setWsForm(f => ({ ...f, permission: e.target.value }))}>
              <option value="ask">询问（默认，写改弹 diff 批准）</option>
              <option value="readonly">只读</option>
              <option value="auto">自动（写改直接执行）</option>
            </Select>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button onClick={handleCreateWorkspace} icon={<Plus className="w-4 h-4" />}>创建工作区</Button>
          {wsMessage && <p className="text-xs text-fg-muted">{wsMessage}</p>}
        </div>
      </Card>

      <Card className="mb-6">
        <h2 className="font-heading font-semibold text-fg-primary mb-1 flex items-center gap-2">
          <Brain className="w-5 h-5" /> Agent 长期记忆
        </h2>
        <p className="text-xs text-fg-muted mb-4">
          Agent 跨会话记住的内容（Markdown）。可直接编辑——它下次任务就会按新记忆行事。
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1.5 md:col-span-1">
            {memoryFiles.length === 0 && <p className="text-xs text-fg-muted">记忆为空 — agent 学到新东西后会自动归档到这里</p>}
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
              <input value={memoryName} onChange={e => setMemoryName(e.target.value)} placeholder="文件名（如 user-preferences.md）"
                className="flex-1 bg-bg-panel/50 border border-glass-border rounded-lg px-3 py-1.5 text-xs font-mono text-fg-primary" />
              <Button size="sm" onClick={saveMemoryFile} icon={<Save className="w-3.5 h-3.5" />}>保存</Button>
            </div>
            <textarea value={memoryContent} onChange={e => setMemoryContent(e.target.value)} rows={10}
              placeholder="选择左侧文件查看，或输入新文件名创建记忆"
              className="w-full bg-bg-panel/50 border border-glass-border rounded-lg p-3 text-xs font-mono text-fg-primary font-mono" />
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="font-heading font-semibold text-fg-primary mb-4">平台配置</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ConfigItem label="服务端口" value={config?.port} />
          <ConfigItem label="Skill 目录" value={config?.skillsDir} />
          <ConfigItem label="沙箱模式" value={config?.sandboxMode} />
          <ConfigItem label="最大并发任务" value={config?.maxConcurrentTasks} />
          <ConfigItem label="单任务 Agent 并发上限" value={config?.maxConcurrentAgentsPerTask} />
          <ConfigItem label="平台版本" value="CORAL v1.1.0" />
        </div>
      </Card>
    </div>
  );
}

function ThemeSettingsCard() {
  const { mode, effective, setMode } = useTheme();

  const options: Array<{ value: ThemeMode; label: string; desc: string; icon: any }> = [
    { value: 'light', label: '浅色', desc: '明亮通透，白天办公更舒适', icon: Sun },
    { value: 'dark', label: '深色', desc: '低眩光，长时间使用不疲劳', icon: Moon },
    { value: 'system', label: '跟随系统', desc: '根据操作系统外观自动切换', icon: Monitor },
  ];

  return (
    <Card className="mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-heading font-semibold text-fg-primary flex items-center gap-2">
          <Palette className="w-5 h-5" /> 外观主题
        </h2>
        <Tag variant={effective === 'dark' ? 'info' : 'success'}>
          当前生效：{effective === 'dark' ? '深色' : '浅色'}
        </Tag>
      </div>
      <p className="text-sm text-fg-muted mb-4">
        选择系统的整体配色模式。设置会保存到本地浏览器，不影响其他用户。
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
                {active && <Tag variant="brand">已选</Tag>}
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
          placeholder="输入后回车，或粘贴换行/逗号分隔的多项"
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        />
        <Button variant="secondary" onClick={add} icon={<Plus className="w-3 h-3" />}>添加</Button>
      </div>
    </div>
  );
}
