import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  ListChecks,
  Sparkles,
  MessageSquare,
  Settings as SettingsIcon,
  Wand2,
  Building2,
  Sun,
  Moon,
  Monitor,
  GitBranch,
  ShieldAlert,
  Plug,
  History,
  Languages,
  Webhook,
} from 'lucide-react';
import DashboardPage from './pages/DashboardPage';
import TasksPage from './pages/TasksPage';
import TaskDetailPage from './pages/TaskDetailPage';
import SkillsPage from './pages/SkillsPage';
import ChatPage from './pages/ChatPage';
import WorkflowPage from './pages/WorkflowPage';
import ApprovalsPage from './pages/ApprovalsPage';
import ConnectorsPage from './pages/ConnectorsPage';
import TimeTravelPage from './pages/TimeTravelPage';
import SettingsPage from './pages/SettingsPage';
import SkillBuilderPage from './pages/SkillBuilderPage';
import HooksPage from './pages/HooksPage';
import { useGlobalStream } from './hooks/useGlobalStream';
import { ConnectionDot } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useTheme } from './contexts/ThemeContext';
import { useI18n } from './i18n';
import { api } from './api/client';

const NAV_KEYS = [
  { path: '/', key: 'app.nav.dashboard', icon: LayoutDashboard },
  { path: '/tasks', key: 'app.nav.tasks', icon: ListChecks },
  { path: '/skills', key: 'app.nav.skills', icon: Sparkles },
  { path: '/skill-builder', key: 'app.nav.skillBuilder', icon: Wand2 },
  { path: '/chat', key: 'app.nav.chat', icon: MessageSquare },
  { path: '/workflows', label: 'Workflow', icon: GitBranch },
  { path: '/approvals', key: 'app.nav.approvals', icon: ShieldAlert },
  { path: '/connectors', key: 'app.nav.connectors', icon: Plug },
  { path: '/hooks', key: 'app.nav.hooks', icon: Webhook },
  { path: '/time-travel', label: 'Time-Travel', icon: History },
  { path: '/settings', key: 'app.nav.settings', icon: SettingsIcon },
];

function ThemeQuickToggle() {
  const { mode, effective, setMode, toggle } = useTheme();
  const { t } = useI18n();
  const Icon = effective === 'dark' ? Sun : Moon;
  const modeText = mode === 'system' ? t('app.theme.system') : mode === 'dark' ? t('app.theme.dark') : t('app.theme.light');
  const tip = `${t('app.theme.current', { mode: modeText })}（${t('app.theme.clickToToggle')}）`;
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        title={tip}
        aria-label={tip}
        onClick={toggle}
        className="flex-1 inline-flex items-center justify-center gap-2 px-2 py-1.5 rounded-lg text-xs text-fg-secondary hover:bg-bg-elev/40 hover:text-fg-primary transition-colors cursor-pointer border border-transparent hover:border-glass-border"
      >
        <Icon className="w-4 h-4" />
        <span>{effective === 'dark' ? t('app.theme.dark') : t('app.theme.light')}</span>
      </button>
      <button
        type="button"
        title={t('app.theme.system')}
        aria-label={t('app.theme.system')}
        onClick={() => setMode('system')}
        className={`p-1.5 rounded-lg transition-colors cursor-pointer border ${
          mode === 'system'
            ? 'bg-brand-soft text-brand border-brand/20'
            : 'text-fg-muted hover:bg-bg-elev/40 hover:text-fg-primary border-transparent'
        }`}
      >
        <Monitor className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/** 语言一键切换（中/英）— 与主题切换并排 */
function LangQuickToggle() {
  const { lang, toggle, t } = useI18n();
  const tip = t('app.lang.toggleTip');
  return (
    <button
      type="button"
      title={tip}
      aria-label={tip}
      onClick={toggle}
      className="w-full inline-flex items-center justify-center gap-2 px-2 py-1.5 rounded-lg text-xs text-fg-secondary hover:bg-bg-elev/40 hover:text-fg-primary transition-colors cursor-pointer border border-transparent hover:border-glass-border"
    >
      <Languages className="w-4 h-4" />
      <span>{lang === 'zh' ? 'English' : '中文'}</span>
    </button>
  );
}

function Sidebar() {
  const location = useLocation();
  const { wsConnected, runningTasks } = useGlobalStream();
  const { t } = useI18n();

  return (
    <aside className="w-60 bg-bg-panel border-r border-glass-border flex flex-col h-screen sticky top-0 shadow-sidebar">
      <div className="p-4 border-b border-glass-border">
        <div className="flex items-center gap-3">
          <img src="/coral-logo.svg" alt="CORAL" className="w-9 h-9 rounded-xl" />
          <div>
            <h1 className="font-heading font-bold text-lg leading-tight text-fg-primary">CORAL</h1>
            <p className="text-xs text-fg-muted">{t('app.tagline')}</p>
          </div>
        </div>
      </div>
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {NAV_KEYS.map(item => {
          const Icon = item.icon;
          const isActive = item.path === '/'
            ? location.pathname === '/'
            : location.pathname.startsWith(item.path);
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm nav-item cursor-pointer ${
                isActive
                  ? 'bg-brand/10 text-brand font-medium'
                  : 'text-fg-secondary hover:bg-bg-raise hover:text-fg-primary'
              }`}
            >
              <Icon className="w-4 h-4" />
              {item.label ?? t(item.key!)}
            </Link>
          );
        })}
      </nav>
      <div className="px-3 py-2 border-t border-glass-border space-y-1">
        <ThemeQuickToggle />
        <LangQuickToggle />
        <div className="flex items-center justify-between px-2 text-xs">
          <ConnectionDot
            state={wsConnected ? 'connected' : 'disconnected'}
            label={wsConnected ? t('app.ws.connected') : t('app.ws.disconnected')}
          />
          {runningTasks > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-status-info/15 text-status-info text-xs rounded-full">
              <Building2 className="w-3 h-3" />{runningTasks}
            </span>
          )}
        </div>
        <ModelFooter />
      </div>
    </aside>
  );
}

export default function App() {
  const { t } = useI18n();
  return (
    <BrowserRouter>
      <div className="flex min-h-screen bg-bg-base text-fg-primary">
        <Sidebar />
        <main className="flex-1 overflow-auto page-enter">
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
              <Route path="/skills" element={<SkillsPage />} />
              <Route path="/skill-builder" element={<SkillBuilderPage />} />
              <Route path="/skill-builder/:sessionId" element={<SkillBuilderPage />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/workflows" element={<WorkflowPage />} />
              <Route path="/approvals" element={<ApprovalsPage />} />
              <Route path="/connectors" element={<ConnectorsPage />} />
              <Route path="/hooks" element={<HooksPage />} />
              <Route path="/time-travel" element={<TimeTravelPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <h2 className="text-lg font-heading text-fg-primary mb-1">{t('app.notFound.title')}</h2>
                    <p className="text-xs text-fg-muted">{t('app.notFound.desc')}</p>
                  </div>
                </div>
              } />
            </Routes>
          </ErrorBoundary>
        </main>
      </div>
    </BrowserRouter>
  );
}

/** 左下角：动态版本号 + 当前模型 + 一键切换模型配置（用户反馈 #5） */
function ModelFooter() {
  const { t } = useI18n();
  const [version, setVersion] = useState('…');
  const [model, setModel] = useState('');
  const [profiles, setProfiles] = useState<Array<{ profileId: string; name: string; model: string; isActive: boolean }>>([]);

  const load = async () => {
    try {
      const [health, config, llm] = await Promise.all([
        api.health().catch(() => null),
        api.config().catch(() => null),
        api.listLlmConfigs().catch(() => null),
      ]);
      if (health?.version) setVersion(health.version);
      if (config?.llmModel) setModel(config.llmModel);
      if (llm?.items) setProfiles(llm.items);
    } catch { /* 静默 */ }
  };

  useEffect(() => { load(); }, []);

  const switchTo = async (profileId: string) => {
    try {
      await api.activateLlmConfig(profileId);
      await load();
    } catch (err: any) {
      alert(t('app.model.switchFailed') + ': ' + err.message);
    }
  };

  return (
    <div className="px-2 text-xs text-fg-muted space-y-1.5">
      <div>CORAL v{version}</div>
      <div className="flex items-center gap-1.5">
        <span className="text-fg-disabled shrink-0">{t('app.model.label')}</span>
        <select
          value={profiles.find(p => p.isActive)?.profileId ?? ''}
          onChange={e => switchTo(e.target.value)}
          className="flex-1 min-w-0 bg-bg-panel/60 border border-glass-border rounded-md px-1.5 py-1 text-[11px] text-fg-secondary cursor-pointer truncate"
          title={t('app.model.switchTip')}
        >
          {profiles.length === 0 && <option value="">{model || t('app.model.none')}</option>}
          {profiles.map(p => (
            <option key={p.profileId} value={p.profileId}>{p.name} · {p.model}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
