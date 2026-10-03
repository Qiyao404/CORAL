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
} from 'lucide-react';
import DashboardPage from './pages/DashboardPage';
import TasksPage from './pages/TasksPage';
import TaskDetailPage from './pages/TaskDetailPage';
import SkillsPage from './pages/SkillsPage';
import ChatPage from './pages/ChatPage';
import WorkflowPage from './pages/WorkflowPage';
import ApprovalsPage from './pages/ApprovalsPage';
import SettingsPage from './pages/SettingsPage';
import SkillBuilderPage from './pages/SkillBuilderPage';
import { useGlobalStream } from './hooks/useGlobalStream';
import { ConnectionDot } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useTheme } from './contexts/ThemeContext';
import { api } from './api/client';

const navItems = [
  { path: '/', label: '控制台', icon: LayoutDashboard },
  { path: '/tasks', label: '任务中心', icon: ListChecks },
  { path: '/skills', label: '技能列表', icon: Sparkles },
  { path: '/skill-builder', label: '技能创建', icon: Wand2 },
  { path: '/chat', label: '对话', icon: MessageSquare },
  { path: '/workflows', label: 'Workflow', icon: GitBranch },
  { path: '/approvals', label: '审批中心', icon: ShieldAlert },
  { path: '/settings', label: '设置', icon: SettingsIcon },
];

function ThemeQuickToggle() {
  const { mode, effective, setMode, toggle } = useTheme();
  const Icon = effective === 'dark' ? Sun : Moon;
  const tip = `当前：${mode === 'system' ? '跟随系统' : mode === 'dark' ? '深色' : '浅色'}（点击切换）`;
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
        <span>{effective === 'dark' ? '深色' : '浅色'}</span>
      </button>
      <button
        type="button"
        title="跟随系统"
        aria-label="跟随系统"
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

function Sidebar() {
  const location = useLocation();
  const { wsConnected, runningTasks } = useGlobalStream();

  return (
    <aside className="w-60 glass border-r border-glass-border flex flex-col h-screen sticky top-0 rounded-none">
      <div className="p-5 border-b border-glass-border">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-brand rounded-xl flex items-center justify-center text-white font-bold text-base font-heading shadow-lg shadow-brand/20">
            C
          </div>
          <div>
            <h1 className="font-heading font-bold text-lg leading-tight text-fg-primary">CORAL</h1>
            <p className="text-xs text-fg-muted">智能体运行时平台</p>
          </div>
        </div>
      </div>
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {navItems.map(item => {
          const Icon = item.icon;
          const isActive = item.path === '/'
            ? location.pathname === '/'
            : location.pathname.startsWith(item.path);
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors cursor-pointer ${
                isActive
                  ? 'bg-brand-soft text-brand font-medium border border-brand/20'
                  : 'text-fg-secondary hover:bg-bg-elev/40 hover:text-fg-primary border border-transparent'
              }`}
            >
              <Icon className="w-4 h-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="p-3 border-t border-glass-border space-y-2">
        <ThemeQuickToggle />
        <div className="flex items-center justify-between px-2 text-xs">
          <ConnectionDot
            state={wsConnected ? 'connected' : 'disconnected'}
            label={wsConnected ? 'WS 已连接' : 'WS 已断开'}
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
  return (
    <BrowserRouter>
      <div className="flex min-h-screen bg-bg-base text-fg-primary">
        <Sidebar />
        <main className="flex-1 overflow-auto">
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
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </ErrorBoundary>
        </main>
      </div>
    </BrowserRouter>
  );
}

/** 左下角：动态版本号 + 当前模型 + 一键切换模型配置（用户反馈 #5） */
function ModelFooter() {
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
      alert('切换失败: ' + err.message);
    }
  };

  return (
    <div className="px-2 text-xs text-fg-muted space-y-1.5">
      <div>CORAL v{version}</div>
      <div className="flex items-center gap-1.5">
        <span className="text-fg-disabled shrink-0">模型</span>
        <select
          value={profiles.find(p => p.isActive)?.profileId ?? ''}
          onChange={e => switchTo(e.target.value)}
          className="flex-1 min-w-0 bg-bg-panel/60 border border-glass-border rounded-md px-1.5 py-1 text-[11px] text-fg-secondary cursor-pointer truncate"
          title="切换模型配置（在设置页可新增）"
        >
          {profiles.length === 0 && <option value="">{model || '未配置'}</option>}
          {profiles.map(p => (
            <option key={p.profileId} value={p.profileId}>{p.name} · {p.model}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
